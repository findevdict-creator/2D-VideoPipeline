import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../paths.js";
import type { CloneEngine } from "../voice/engine.js";
import { nowIso } from "./ids.js";
import { readWav, resample, writeWav } from "./media/wav.js";
import type { Studio } from "./studio.js";

/**
 * Your own voices. Each is a short recording of someone speaking, kept in the workspace
 * (voices/<slug>/reference.wav, next to projects/), never in the repository, and offered to
 * every project. Narration in a cloned voice is made one of two ways:
 *
 * - "kokoclone": Kokoro speaks in one of its own voices and the Kanade model re-voices the
 *   audio as the person in the clip, the way KokoClone does. Fast, and the timing is Kokoro's.
 * - "chatterbox": Chatterbox speaks the text itself in the cloned voice. Slower, closer.
 *
 * A project names its narrator by one id, whichever kind it is: "af_heart" for a Kokoro
 * voice, "clone.<slug>" for a clone made the first way, "clone.<slug>.chatterbox" for the second.
 */
export interface ClonedVoice {
  slug: string;
  /** What the person called it, such as "My voice". */
  name: string;
  /** The Kokoro voice that speaks before conversion. Its rhythm and accent carry over; its sound does not. */
  baseVoice: string;
  /** Length of the reference clip. */
  clipSec: number;
  /** Changes when the clip does, so narration made from an older clip is recorded again. */
  clipHash: string;
  createdAt: string;
}

export const CLONE_ENGINES = ["kokoclone", "chatterbox"] as const;

/** A reference clip shorter than this carries too little of a voice; longer than the upper limit adds nothing. */
export const CLIP_MIN_SEC = 6;
export const CLIP_MAX_SEC = 90;
const CLIP_RATE = 24000;
const MAX_CLIP_BYTES = 40 * 1024 * 1024;
const DEFAULT_BASE = "am_michael";

const CLONE_ID = /^clone\.([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.(chatterbox))?$/;

export const voicesDir = (studio: Studio) => path.join(studio.workspaceDir, "voices");
const dirOf = (studio: Studio, slug: string) => path.join(voicesDir(studio), slug);
export const referenceFile = (studio: Studio, slug: string) => path.join(dirOf(studio, slug), "reference.wav");

export const cloneId = (slug: string, engine: CloneEngine = "kokoclone") => `clone.${slug}${engine === "chatterbox" ? ".chatterbox" : ""}`;

/** Read "clone.<slug>" or "clone.<slug>.chatterbox". Undefined for anything else, such as a Kokoro voice. */
export function parseCloneId(id: string): { slug: string; engine: CloneEngine } | undefined {
  const m = CLONE_ID.exec(id.trim().toLowerCase());
  return m ? { slug: m[1]!, engine: m[2] ? "chatterbox" : "kokoclone" } : undefined;
}

export function listClones(studio: Studio): ClonedVoice[] {
  const dir = voicesDir(studio);
  if (!fs.existsSync(dir)) return [];
  const out: ClonedVoice[] = [];
  for (const slug of fs.readdirSync(dir)) {
    if (slug.startsWith(".")) continue;
    const voice = readClone(studio, slug);
    if (voice) out.push(voice);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function readClone(studio: Studio, slug: string): ClonedVoice | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dirOf(studio, slug), "voice.json"), "utf8")) as Partial<ClonedVoice>;
    if (!fs.existsSync(referenceFile(studio, slug))) return undefined;
    return { slug, name: String(v.name || slug), baseVoice: String(v.baseVoice || DEFAULT_BASE), clipSec: Number(v.clipSec) || 0, clipHash: String(v.clipHash || ""), createdAt: String(v.createdAt || "") };
  } catch {
    return undefined;
  }
}

export function getClone(studio: Studio, slug: string): ClonedVoice {
  const voice = /^[a-z0-9-]+$/.test(slug) ? readClone(studio, slug) : undefined;
  if (!voice) throw new Error(`There is no cloned voice "${slug}". It may have been deleted. Choose another narrator under Plan → Voice.`);
  return voice;
}

/**
 * Keep a recording as a voice. The clip is a WAV file (the studio's page converts whatever
 * was recorded or chosen); it is stored mono at 24 kHz, which is what both engines read.
 * Saving under a name that exists replaces that voice's clip.
 */
export function saveClone(studio: Studio, input: { name: string; wav: Buffer; baseVoice?: string }): { voice: ClonedVoice; warnings: string[] } {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) throw new Error("Give the voice a name, such as My voice.");
  const slug = slugOf(name);
  if (!slug) throw new Error("The name needs at least one letter or number.");
  if (input.wav.length > MAX_CLIP_BYTES) throw new Error(`That recording is too large. A clip of 10 to 30 seconds is enough.`);
  const baseVoice = input.baseVoice?.trim().toLowerCase() || readClone(studio, slug)?.baseVoice || DEFAULT_BASE;
  if (!/^[ab][fm]_[a-z0-9]+$/.test(baseVoice)) throw new Error(`"${input.baseVoice}" is not an English Kokoro voice. The voice it starts from is named like am_michael or bf_emma.`);

  // Read from a scratch file, so a refused recording leaves nothing behind in the voices folder.
  fs.mkdirSync(voicesDir(studio), { recursive: true });
  const incoming = path.join(voicesDir(studio), `.incoming-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(incoming, input.wav);
  let clip;
  try {
    clip = resample(readWav(incoming), CLIP_RATE);
  } catch {
    throw new Error("That recording could not be read. Record again, or choose a WAV, MP3 or M4A file.");
  } finally {
    fs.rmSync(incoming, { force: true });
  }
  const clipSec = clip.samples.length / CLIP_RATE;
  if (clipSec < CLIP_MIN_SEC) throw new Error(`That recording is ${clipSec.toFixed(1)} seconds long. Record at least ${CLIP_MIN_SEC} seconds; 10 to 30 works best.`);
  if (clipSec > CLIP_MAX_SEC) throw new Error(`That recording is ${Math.round(clipSec)} seconds long. Keep it under ${CLIP_MAX_SEC} seconds; 10 to 30 works best.`);

  let peak = 0;
  let clipped = 0;
  for (const s of clip.samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a >= 32700) clipped++;
  }
  if (peak < 400) throw new Error("That recording is silent. Check that the right microphone is chosen and try again.");
  const warnings: string[] = [];
  if (peak < 3300) warnings.push("The recording is very quiet. Move closer to the microphone and record again for a better likeness.");
  if (clipped > clip.samples.length / 2000) warnings.push("The recording is distorted in places because it is too loud. Move back a little and record again for a better likeness.");
  if (clipSec < 10) warnings.push("The recording is short. 10 to 30 seconds gives a closer voice.");

  fs.mkdirSync(dirOf(studio, slug), { recursive: true });
  writeWav(referenceFile(studio, slug), clip);
  const voice: ClonedVoice = {
    slug,
    name,
    baseVoice,
    clipSec: Math.round(clipSec * 10) / 10,
    clipHash: createHash("sha1").update(Buffer.from(clip.samples.buffer, clip.samples.byteOffset, clip.samples.byteLength)).digest("hex").slice(0, 12),
    createdAt: readClone(studio, slug)?.createdAt || nowIso(),
  };
  writeMeta(studio, voice);
  studio.emit("voices.changed", {});
  return { voice, warnings };
}

/** Change which Kokoro voice a clone starts from. A male voice suits a male speaker, and the accent carries over. */
export function setCloneBase(studio: Studio, slug: string, baseVoice: string): ClonedVoice {
  const voice = getClone(studio, slug);
  const base = baseVoice.trim().toLowerCase();
  if (!/^[ab][fm]_[a-z0-9]+$/.test(base)) throw new Error(`"${baseVoice}" is not an English Kokoro voice. It is named like am_michael or bf_emma.`);
  const changed = { ...voice, baseVoice: base };
  writeMeta(studio, changed);
  studio.emit("voices.changed", {});
  return changed;
}

/** Remove a voice and its clip. Projects that used it say so the next time they record narration. */
export function deleteClone(studio: Studio, slug: string): void {
  getClone(studio, slug);
  fs.rmSync(dirOf(studio, slug), { recursive: true, force: true });
  studio.emit("voices.changed", {});
}

function writeMeta(studio: Studio, voice: ClonedVoice) {
  const { slug: _slug, ...kept } = voice;
  fs.writeFileSync(path.join(dirOf(studio, voice.slug), "voice.json"), JSON.stringify(kept, null, 2) + "\n");
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** Which of the two cloning engines are installed on this computer. */
export function cloneEngines(studio: Studio): Record<CloneEngine, boolean> {
  if (studio.config.voice.engine === "mock") return { kokoclone: true, chatterbox: true };
  const roots = [studio.config.rootDir, REPO_ROOT];
  const chatterbox = roots.some((root) => fs.existsSync(venvPython(root, ".venv-chatterbox")));
  // A Python the person configured themselves cannot be looked into, so it is taken on trust.
  const kokoclone = Boolean(studio.config.voice.python) || roots.some((root) => sitePackages(path.join(root, ".venv-voice")).some((dir) => fs.existsSync(path.join(dir, "kanade_tokenizer"))));
  return { kokoclone, chatterbox };
}

export const venvPython = (root: string, name: string) => (process.platform === "win32" ? path.join(root, name, "Scripts", "python.exe") : path.join(root, name, "bin", "python"));

function sitePackages(venv: string): string[] {
  const out = [path.join(venv, "Lib", "site-packages")];
  const lib = path.join(venv, "lib");
  try {
    for (const entry of fs.readdirSync(lib)) if (entry.startsWith("python")) out.push(path.join(lib, entry, "site-packages"));
  } catch {
    // No such environment.
  }
  return out;
}

/** Who speaks, worked out from a project's narrator id. */
export interface Narrator {
  id: string;
  /** The Kokoro voice to speak with (for a clone, the one it starts from). */
  kokoroVoice: string;
  clone?: { engine: CloneEngine; referenceFile: string; voice: ClonedVoice };
}

const KOKORO_ID = /^[a-z][fm]_[a-z0-9]+$/;

/** Check a narrator id, a Kokoro voice or a cloned one, and say how to speak as it. */
export function resolveNarrator(studio: Studio, id: string): Narrator {
  const v = id.trim().toLowerCase();
  const clone = parseCloneId(v);
  if (clone) {
    const voice = getClone(studio, clone.slug);
    return { id: cloneId(clone.slug, clone.engine), kokoroVoice: voice.baseVoice, clone: { engine: clone.engine, referenceFile: referenceFile(studio, clone.slug), voice } };
  }
  if (!KOKORO_ID.test(v)) throw new Error(`"${id}" is not a voice. A voice is named like af_heart or bm_george, or clone.my-voice for one you cloned.`);
  return { id: v, kokoroVoice: v };
}
