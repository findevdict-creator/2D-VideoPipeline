import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PipelineConfig } from "../config.js";

export type Pronunciations = Record<string, string>;

const PronunciationsSchema = z.record(z.string(), z.string());

/** Load the respelling list. A missing file means no respellings. */
export async function loadPronunciations(config: PipelineConfig): Promise<Pronunciations> {
  const file = path.resolve(config.rootDir, config.voice.pronunciationsFile);
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = PronunciationsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} must be an object of "word": "how to say it" pairs`);
  return parsed.data;
}

/**
 * Replace whole words with how they should be spoken, for example GPS -> "G P S".
 * Matching is case-sensitive, so "US" and "us" can be told apart. Longer entries win.
 */
export function applyPronunciations(text: string, pronunciations: Pronunciations): string {
  const terms = Object.keys(pronunciations).sort((a, b) => b.length - a.length);
  if (!terms.length) return text;
  const pattern = new RegExp(`(?<![A-Za-z0-9])(${terms.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`, "g");
  return text.replace(pattern, (match) => pronunciations[match] ?? match);
}

/** Kokoro language code for a voice. "auto" reads it from the voice name: af_heart -> "a". */
export function kokoroLanguage(setting: string, voice: string): string {
  const named: Record<string, string> = { "en-us": "a", "en-gb": "b", es: "e", fr: "f", hi: "h", it: "i", ja: "j", "pt-br": "p", zh: "z" };
  const s = setting.toLowerCase();
  if (s === "auto") {
    const code = voice[0]?.toLowerCase();
    if (!code || !"abefhijpz".includes(code)) {
      throw new Error(`Cannot tell the language of voice "${voice}". Set voice.language in pipeline.config.json.`);
    }
    return code;
  }
  if (named[s]) return named[s];
  if (s.length === 1 && "abefhijpz".includes(s)) return s;
  throw new Error(`Unknown voice.language "${setting}". Use auto, en-us, en-gb, or a Kokoro code such as "a".`);
}

export interface TimedWord {
  text: string;
  startSec: number;
  endSec: number;
}

export interface CueTiming {
  startSec: number;
  endSec: number;
  /** "exact" when the phrase was found in the spoken words, "estimated" when it was placed by its position in the text. */
  match: "exact" | "estimated";
}

/**
 * Find when a cue phrase is spoken. Words are compared letter by letter with spaces
 * and punctuation removed, so different word splits ("that's" vs "that 's") still match.
 */
export function findCueTiming(
  cue: string,
  spokenText: string,
  words: TimedWord[],
  speech: { startSec: number; endSec: number },
  pronunciations: Pronunciations,
): CueTiming {
  const target = squash(applyPronunciations(cue, pronunciations));
  if (target && words.length) {
    let stream = "";
    const owner: number[] = [];
    words.forEach((w, i) => {
      const s = squash(w.text);
      stream += s;
      for (let k = 0; k < s.length; k++) owner.push(i);
    });
    const at = stream.indexOf(target);
    if (at >= 0) {
      const first = words[owner[at]!]!;
      const last = words[owner[at + target.length - 1]!]!;
      return { startSec: first.startSec, endSec: last.endSec, match: "exact" };
    }
  }

  // Fall back to the cue's position within the narration text.
  const text = squash(spokenText);
  const at = target ? text.indexOf(target) : -1;
  const span = speech.endSec - speech.startSec;
  const startRatio = at >= 0 && text.length ? at / text.length : 0;
  const endRatio = at >= 0 && text.length ? (at + target.length) / text.length : 0;
  return {
    startSec: round(speech.startSec + span * startRatio),
    endSec: round(speech.startSec + span * endRatio),
    match: "estimated",
  };
}

function squash(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
