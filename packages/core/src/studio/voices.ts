import fs from "node:fs";
import path from "node:path";
import { createSpeechEngine } from "../voice/engine.js";
import { applyPronunciations, kokoroLanguage, loadPronunciations } from "../voice/text.js";
import type { Studio } from "./studio.js";
import { getProject, projectPaths, updateProject, type Project } from "./store/projects.js";

export interface VoiceChoice {
  id: string;
  /** The name a person would call it. */
  name: string;
  accent: "American" | "British";
  gender: "female" | "male";
}

const voice = (id: string): VoiceChoice => ({
  id,
  name: id.slice(3, 4).toUpperCase() + id.slice(4),
  accent: id[0] === "b" ? "British" : "American",
  gender: id[1] === "f" ? "female" : "male",
});

/** The English voices of Kokoro 1.0. Another Kokoro voice can still be set by its id. */
export const VOICES: VoiceChoice[] = [
  "af_heart",
  "af_bella",
  "af_nicole",
  "af_sarah",
  "af_aoede",
  "af_kore",
  "af_alloy",
  "af_jessica",
  "af_nova",
  "af_river",
  "af_sky",
  "am_michael",
  "am_fenrir",
  "am_puck",
  "am_adam",
  "am_echo",
  "am_eric",
  "am_liam",
  "am_onyx",
  "bf_emma",
  "bf_isabella",
  "bf_alice",
  "bf_lily",
  "bm_george",
  "bm_fable",
  "bm_daniel",
  "bm_lewis",
].map(voice);

export const PACES = ["slow", "normal", "fast"] as const;
export type Pace = (typeof PACES)[number];

/** A Kokoro voice id: a language letter, f or m, an underscore and a name. */
const VOICE_ID = /^[a-z][fm]_[a-z0-9]+$/;

export function checkVoice(id: string): string {
  const v = id.trim().toLowerCase();
  if (!VOICE_ID.test(v)) throw new Error(`"${id}" is not a voice. A voice is named like af_heart or bm_george. The voices are: ${VOICES.map((x) => x.id).join(", ")}.`);
  return v;
}

/**
 * Choose who narrates a project and how fast. Narration is recorded per voice and kept, so
 * the scenes are spoken again the next time they are drawn, and going back to an earlier
 * voice records nothing. Scenes keep their approvals: their cues follow the new timing.
 */
export function setVoice(studio: Studio, projectId: string, choice: { voice?: string; pace?: string }): Project {
  const project = getProject(studio, projectId);
  if (choice.pace !== undefined && !(PACES as readonly string[]).includes(choice.pace)) throw new Error(`The pace is one of: ${PACES.join(", ")}.`);
  const kokoroVoice = choice.voice !== undefined ? checkVoice(choice.voice) : project.settings.voice.kokoroVoice;
  return updateProject(studio, projectId, { settings: { voice: { kokoroVoice, pace: (choice.pace as Pace | undefined) ?? project.settings.voice.pace } } });
}

const SAMPLE = "This is how your video will sound. Each satellite carries a clock, and your phone listens for it.";

/**
 * A short recording in a voice, to hear it before choosing. Kept in the project, so asking
 * for the same voice twice records once. Returns the file, relative to the project folder.
 */
export async function previewVoice(studio: Studio, projectId: string, choice: { voice?: string; pace?: string }, log: (m: string) => void = () => {}): Promise<{ file: string; voice: string; pace: Pace; silent: boolean }> {
  const project = getProject(studio, projectId);
  const p = projectPaths(studio, project);
  const id = checkVoice(choice.voice ?? project.settings.voice.kokoroVoice);
  const pace = (choice.pace as Pace | undefined) ?? project.settings.voice.pace;
  if (!(PACES as readonly string[]).includes(pace)) throw new Error(`The pace is one of: ${PACES.join(", ")}.`);
  const v = studio.config.voice;
  const speed = Math.round(v.speed * v.paceSpeed[pace] * 1000) / 1000;
  const file = path.join(p.work, "voice-preview", `${id}-${String(speed).replace(".", "_")}-${v.engine}.wav`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const partial = `${file}.part.wav`;
    await createSpeechEngine(studio.config).speak(
      {
        sampleRate: v.sampleRate,
        items: [{ id: "preview", text: applyPronunciations(SAMPLE, await loadPronunciations(studio.config)), voice: id, lang: kokoroLanguage(v.language, id), speed, padBeforeSec: 0.1, padAfterSec: 0.2, outFile: partial }],
      },
      log,
    );
    fs.renameSync(partial, file);
  }
  return { file: p.rel(file), voice: id, pace, silent: v.engine === "mock" };
}
