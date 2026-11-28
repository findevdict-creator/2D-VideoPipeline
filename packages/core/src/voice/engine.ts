import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { PYTHON_DIR, REPO_ROOT } from "../paths.js";
import type { PipelineConfig } from "../config.js";
import type { TimedWord } from "./text.js";

/** How a cloned voice is made: Kokoro re-voiced by Kanade (as KokoClone does), or Chatterbox speaking by itself. */
export type CloneEngine = "kokoclone" | "chatterbox";

export interface SpeechItem {
  id: string;
  /** Text as it should be spoken, after respellings. */
  text: string;
  /** The Kokoro voice. For a clone made with Kokoro, the voice that speaks before it is re-voiced. */
  voice: string;
  /** Set to speak as the person in a reference clip (a WAV file) instead of in the Kokoro voice. */
  clone?: { engine: CloneEngine; referenceFile: string };
  lang: string;
  speed: number;
  padBeforeSec: number;
  padAfterSec: number;
  outFile: string;
}

export interface SpeechResult {
  id: string;
  durationSec: number;
  speechStartSec: number;
  speechEndSec: number;
  words: TimedWord[];
}

export interface SpeechJob {
  sampleRate: number;
  items: SpeechItem[];
  concat?: { files: string[]; outFile: string };
}

export interface SpeechOutput {
  items: SpeechResult[];
  concat?: { outFile: string; durationSec: number };
}

export interface SpeechEngine {
  readonly kind: string;
  speak(job: SpeechJob, log: (m: string) => void): Promise<SpeechOutput>;
}

export function createSpeechEngine(config: PipelineConfig): SpeechEngine {
  return config.voice.engine === "mock" ? new MockSpeechEngine() : new KokoroEngine(config);
}

const SCRIPT = path.join(PYTHON_DIR, "kokoro", "kokoro_tts.py");

/** The Python that setup:voice installed, or a configured one, or the system Python. */
export function resolvePython(config: PipelineConfig): string {
  if (config.voice.python) return config.voice.python;
  const windows = process.platform === "win32";
  for (const root of [config.rootDir, REPO_ROOT]) {
    const venv = windows
      ? path.join(root, ".venv-voice", "Scripts", "python.exe")
      : path.join(root, ".venv-voice", "bin", "python");
    if (existsSync(venv)) return venv;
  }
  return windows ? "python" : "python3";
}

const CHATTERBOX_SCRIPT = path.join(PYTHON_DIR, "chatterbox", "chatterbox_tts.py");

/** The Python that setup:chatterbox installed. Chatterbox has its own, because its libraries differ from Kokoro's. */
export function resolveChatterboxPython(config: PipelineConfig): string | undefined {
  const windows = process.platform === "win32";
  for (const root of [config.rootDir, REPO_ROOT]) {
    const venv = windows ? path.join(root, ".venv-chatterbox", "Scripts", "python.exe") : path.join(root, ".venv-chatterbox", "bin", "python");
    if (existsSync(venv)) return venv;
  }
  return undefined;
}

/** What went wrong, in a first line a person can act on. The studio's page shows only that line. */
export class SpeechError extends Error {}

/** Run one of the speech scripts in python/ with a job on stdin, and read its result. */
function runSpeech(python: string, script: string, name: string, setup: string, job: SpeechJob, log: (m: string) => void): Promise<SpeechOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
      for (const line of d.toString().split(/\r?\n/)) {
        if (/^(Speaking|Loading) /.test(line)) log(`  ${line}`);
      }
    });
    child.on("error", (err) => reject(new SpeechError(`Could not start Python ("${python}"): ${err.message}. Run: ${setup}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const lines = stderr.trim().split(/\r?\n/);
        // Codes 2 and 3 are the scripts saying what is not installed, in their last line.
        if (code === 2 || code === 3) return reject(new SpeechError(lines.at(-1) || `${name} is not installed. Run: ${setup}`));
        reject(new SpeechError(`${name} failed (exit code ${code}):\n${lines.slice(-8).join("\n")}\nIf ${name} is not set up yet, run: ${setup}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? ""));
      } catch {
        reject(new SpeechError(`${name} returned output that is not JSON:\n${stdout.slice(0, 500)}`));
      }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

/**
 * Runs python/kokoro/kokoro_tts.py with the job on stdin. Items in a voice cloned with
 * Chatterbox go to python/chatterbox/chatterbox_tts.py instead, in Chatterbox's own Python.
 */
export class KokoroEngine implements SpeechEngine {
  readonly kind = "kokoro";
  constructor(private readonly config: PipelineConfig) {}

  async speak(job: SpeechJob, log: (m: string) => void): Promise<SpeechOutput> {
    const own = job.items.filter((i) => i.clone?.engine === "chatterbox");
    const rest = job.items.filter((i) => i.clone?.engine !== "chatterbox");
    const spoken: SpeechResult[] = [];
    if (own.length) {
      const python = resolveChatterboxPython(this.config);
      if (!python) throw new SpeechError("Chatterbox is not installed. Run: npm run setup:chatterbox   then restart the studio. Or choose your voice without (Chatterbox).");
      spoken.push(...(await runSpeech(python, CHATTERBOX_SCRIPT, "Chatterbox", "npm run setup:chatterbox", { sampleRate: job.sampleRate, items: own }, log)).items);
    }
    let concat: SpeechOutput["concat"];
    if (rest.length || job.concat) {
      const out = await runSpeech(resolvePython(this.config), SCRIPT, "Kokoro", "npm run setup:voice", { ...job, items: rest }, log);
      spoken.push(...out.items);
      concat = out.concat;
    }
    const items = job.items.map((i) => spoken.find((r) => r.id === i.id)).filter((r): r is SpeechResult => Boolean(r));
    return { items, concat };
  }
}

/**
 * Writes silent audio of a realistic length, with evenly spaced word timings.
 * For testing the flow without Python or Kokoro.
 */
export class MockSpeechEngine implements SpeechEngine {
  readonly kind = "mock";
  readonly jobs: SpeechJob[] = [];
  /** The latest job any stand-in engine was given, for tests of code that makes its own engine. */
  static last: SpeechJob | undefined;

  async speak(job: SpeechJob): Promise<SpeechOutput> {
    this.jobs.push(job);
    MockSpeechEngine.last = job;
    const items: SpeechResult[] = [];
    for (const item of job.items) {
      const tokens = item.text.split(/\s+/).filter(Boolean);
      const perWord = 60 / 150 / item.speed;
      const words = tokens.map((text, i) => ({
        text,
        startSec: round(item.padBeforeSec + i * perWord),
        endSec: round(item.padBeforeSec + (i + 0.9) * perWord),
      }));
      const speechSec = tokens.length * perWord;
      const durationSec = round(item.padBeforeSec + speechSec + item.padAfterSec);
      await writeSilentWav(item.outFile, durationSec, job.sampleRate);
      items.push({
        id: item.id,
        durationSec,
        speechStartSec: item.padBeforeSec,
        speechEndSec: round(item.padBeforeSec + speechSec),
        words,
      });
    }
    let concat: SpeechOutput["concat"];
    if (job.concat) {
      let total = 0;
      for (const f of job.concat.files) total += (await fs.stat(f)).size - 44;
      const durationSec = round(total / 2 / job.sampleRate);
      await writeSilentWav(job.concat.outFile, durationSec, job.sampleRate);
      concat = { outFile: job.concat.outFile, durationSec };
    }
    return { items, concat };
  }
}

export async function writeSilentWav(file: string, seconds: number, sampleRate: number) {
  const samples = Math.round(seconds * sampleRate);
  const data = samples * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + data, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(data, 40);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buf);
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}
