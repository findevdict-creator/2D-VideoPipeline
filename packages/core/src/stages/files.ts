import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import type { StageContext } from "../context.js";
import { validateJsonFile } from "../agents/runAgent.js";
import {
  BriefSchema,
  DirectorNotesSchema,
  ScriptSchema,
  StoryboardSchema,
  type Brief,
  type DirectorNotes,
  type Script,
  type Storyboard,
} from "../schemas.js";

/** Where each stage's files live, plus validators shared by stages. */
export const files = (ctx: StageContext) => ({
  prompt: ctx.production.path("prompt.md"),
  inputs: ctx.production.path("inputs"),
  brief: ctx.production.path("brief.json"),
  research: ctx.production.path("research.md"),
  script: ctx.production.path("script.json"),
  storyboard: ctx.production.path("storyboard.json"),
  directorNotes: (stage: string, revision: number, round: number) =>
    ctx.production.path("director-notes", `rev-${revision}`, `${stage}-round-${round}.json`),
});

export const validateBrief = (ctx: StageContext) => validateJsonFile(files(ctx).brief, BriefSchema);

export const validateScript = (ctx: StageContext) =>
  validateJsonFile(files(ctx).script, ScriptSchema, (script) => checkScript(script));

export const validateStoryboard = (ctx: StageContext) =>
  validateJsonFile(files(ctx).storyboard, StoryboardSchema, async (board) => {
    const script = await readJson<Script>(files(ctx).script);
    return checkStoryboard(board, script);
  });

export const validateDirectorNotes = (file: string) => validateJsonFile(file, DirectorNotesSchema);

export async function validateResearch(ctx: StageContext) {
  const file = files(ctx).research;
  if (!existsSync(file)) return { ok: false as const, errors: [`${file} does not exist`] };
  const text = await fs.readFile(file, "utf8");
  const errors: string[] = [];
  if (text.trim().length < 200) errors.push("research.md is too short to support a script");
  if (!/https?:\/\//.test(text)) errors.push("research.md must cite source URLs");
  return errors.length ? { ok: false as const, errors } : { ok: true as const, value: text };
}

export function checkScript(script: Script): string[] {
  const errors: string[] = [];
  script.scenes.forEach((scene, i) => {
    const expected = `s${String(i + 1).padStart(2, "0")}`;
    if (scene.id !== expected) errors.push(`scenes.${i}.id is "${scene.id}" but should be "${expected}" (ids run s01, s02, ... in order)`);
  });
  return errors;
}

export function checkStoryboard(board: Storyboard, script: Script): string[] {
  const errors: string[] = [];
  const scriptIds = script.scenes.map((s) => s.id);
  const boardIds = board.scenes.map((s) => s.id);
  if (scriptIds.join(",") !== boardIds.join(",")) {
    errors.push(`Storyboard scene ids [${boardIds.join(", ")}] must match script.json scene ids [${scriptIds.join(", ")}] in order`);
  }
  for (const scene of board.scenes) {
    const narration = script.scenes.find((s) => s.id === scene.id)?.narration;
    const elementIds = new Set(scene.elements.map((e) => e.id));
    for (const anim of scene.animations) {
      if (!elementIds.has(anim.elementId)) {
        errors.push(`${scene.id}: animation refers to unknown element "${anim.elementId}"`);
      }
      if (narration && !normalise(narration).includes(normalise(anim.cue))) {
        errors.push(`${scene.id}: animation cue "${anim.cue}" is not a word-for-word phrase from the scene's narration`);
      }
    }
  }
  return errors;
}

/** Spoken duration estimate at about 150 words per minute. */
export function estimateSpokenSeconds(text: string, wordsPerMinute = 150) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / wordsPerMinute) * 60);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

/** The Director's most recent review of a stage's current revision, if any. */
export async function latestDirectorNotes(
  ctx: StageContext,
  stage: "script" | "storyboard",
): Promise<{ round: number; notes: DirectorNotes } | undefined> {
  const revision = ctx.production.stage(stage).revision;
  for (let round = ctx.config.maxDirectorRounds; round >= 1; round--) {
    const file = files(ctx).directorNotes(stage, revision, round);
    if (existsSync(file)) return { round, notes: await readJson<DirectorNotes>(file) };
  }
  return undefined;
}

function normalise(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

export type { Brief, Script, Storyboard, DirectorNotes };
