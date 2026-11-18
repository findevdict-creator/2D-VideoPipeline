import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig } from "../config.js";
import { createSpeechEngine } from "./engine.js";
import { applyPronunciations, kokoroLanguage, loadPronunciations } from "./text.js";

/** Speak one sentence in each audition voice, so you can pick a voice by ear. */
export async function auditionVoices(config: PipelineConfig, text: string | undefined, log: (m: string) => void) {
  const v = config.voice;
  const outDir = path.join(config.rootDir, "voice-auditions");
  await fs.mkdir(outDir, { recursive: true });
  const pronunciations = await loadPronunciations(config);
  const spoken = applyPronunciations(text ?? v.auditionText, pronunciations);
  const items = v.auditionVoices.map((voice) => ({
    id: voice,
    text: spoken,
    voice,
    lang: kokoroLanguage(v.language === "auto" ? "auto" : v.language, voice),
    speed: v.speed,
    padBeforeSec: 0,
    padAfterSec: 0,
    outFile: path.join(outDir, `${voice}.wav`),
  }));
  log(`Speaking "${spoken}" in ${items.length} voices...`);
  await createSpeechEngine(config).speak({ sampleRate: v.sampleRate, items }, log);
  return items.map((i) => ({ voice: i.voice, file: i.outFile }));
}
