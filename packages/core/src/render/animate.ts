import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SceneData, VideoData } from "@pipeline/lib/types";
import { ANIMATOR } from "../agents/definitions.js";
import { LIB_EXAMPLE, LIB_README } from "../paths.js";
import { FALLBACK_SCENE } from "../agents/fallbackScene.js";
import { runAgentForFile, validateJsonFile, type Validation } from "../agents/runAgent.js";
import type { StageContext } from "../context.js";
import { files } from "../stages/files.js";
import { renderPaths } from "./project.js";
import { bundleProduction, framesToCheck, renderSceneStills, typecheckScenes } from "./remotion.js";
import { checkSceneSource } from "./sceneCheck.js";

/** What the Animator writes after looking at its test frames. */
export const SceneReviewSchema = z.object({
  verdict: z.enum(["good", "fixed"]),
  notes: z.array(z.string()).default([]),
});

export interface SceneStatus {
  /**
   * good: the Animator looked at the frames and found nothing to fix.
   * fixed: the Animator fixed what it saw, and the fix was checked again.
   * unreviewed: it renders, but the rounds ran out before the last change was looked at.
   * placeholder: the Animator's scene kept failing, so a simple stand-in scene is used.
   * edited: you edited the file by hand; it was checked but not reviewed.
   */
  status: "good" | "fixed" | "unreviewed" | "placeholder" | "edited";
  agentRounds: number;
  notes: string[];
  problems: string[];
  stills: string[];
  sourceHash: string;
  updatedAt: string;
}

export interface AnimationStatus {
  scenes: Record<string, SceneStatus>;
}

/** render/animation-status.json, written as each scene finishes, so an interrupted run can resume. */
export class StatusStore {
  private writes = Promise.resolve();

  private constructor(
    private readonly file: string,
    readonly data: AnimationStatus,
  ) {}

  static async load(ctx: StageContext): Promise<StatusStore> {
    const file = renderPaths(ctx).status;
    let data: AnimationStatus = { scenes: {} };
    if (existsSync(file)) {
      try {
        data = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        // A damaged status file only means scenes get checked again.
      }
    }
    return new StatusStore(file, data);
  }

  get(id: string): SceneStatus | undefined {
    return this.data.scenes[id];
  }

  async set(id: string, status: SceneStatus) {
    this.data.scenes[id] = status;
    this.writes = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.data, null, 2) + "\n");
    });
    await this.writes;
  }

  /** True when the scene was finished and its file has not changed since. */
  async isDone(ctx: StageContext, id: string) {
    const s = this.get(id);
    const file = renderPaths(ctx).scene(id);
    return !!s && existsSync(file) && s.sourceHash === hashOf(await fs.readFile(file, "utf8"));
  }
}

export const hashOf = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);

/**
 * Scene ids named in your notes: "s03", "scene 3", "scenes 2 and 4".
 * Empty when the notes name no scene, which means they apply to every scene.
 */
export function scenesInNotes(notes: string, ids: string[]): string[] {
  const found = new Set<string>();
  const add = (n: string) => {
    const id = `s${n.padStart(2, "0")}`;
    if (ids.includes(id)) found.add(id);
  };
  for (const m of notes.matchAll(/\bs(\d{1,2})\b/gi)) add(m[1]!);
  for (const m of notes.matchAll(/\bscenes?\s+(\d{1,2}(?:\s*(?:,|and|&|to|-)\s*\d{1,2})*)/gi)) {
    const nums = m[1]!.match(/\d{1,2}/g) ?? [];
    if (/\bto\b|-/.test(m[1]!) && nums.length === 2) {
      for (let n = Number(nums[0]); n <= Number(nums[1]); n++) add(String(n));
    } else {
      nums.forEach(add);
    }
  }
  return ids.filter((id) => found.has(id));
}

export interface SceneCheck {
  problems: string[];
  stills: { file: string; frame: number }[];
}

/** Check one scene without any agent: source rules, types, then render its test frames. */
export async function checkScene(ctx: StageContext, data: VideoData, id: string): Promise<SceneCheck> {
  const r = renderPaths(ctx);
  const scene = sceneOf(data, id);
  if (!existsSync(r.scene(id))) return { problems: [`${r.scene(id)} does not exist`], stills: [] };

  const problems = checkSceneSource(await fs.readFile(r.scene(id), "utf8"));
  problems.push(...((await typecheckScenes(ctx))[id] ?? []));
  if (problems.length) return { problems, stills: [] };

  const frames = framesToCheck(scene, data.fps, ctx.config.animator.stillsPerScene);
  try {
    const serveUrl = await bundleProduction(ctx, id);
    const stills = await renderSceneStills(ctx, serveUrl, id, frames);
    return { problems: [], stills: stills.map((file, i) => ({ file, frame: frames[i]! })) };
  } catch (err) {
    return { problems: [`Rendering the scene failed: ${shortError(err)}`], stills: [] };
  } finally {
    await fs.rm(path.join(r.dir, `.bundle-${id}`), { recursive: true, force: true });
    await fs.rm(path.join(r.dir, `check-${id}.tsx`), { force: true });
  }
}

/**
 * Have the Animator write (or revise) one scene, then check it and let the Animator
 * fix what the checks or its own look at the frames turn up, for up to maxFixRounds rounds.
 */
export async function animateScene(
  ctx: StageContext,
  data: VideoData,
  id: string,
  store: StatusStore,
  notes?: string,
): Promise<SceneStatus> {
  const r = renderPaths(ctx);
  const file = r.scene(id);
  const scene = sceneOf(data, id);
  const max = ctx.config.animator.maxFixRounds;
  const log = (m: string) => ctx.log(`  ${id}: ${m}`);

  const fresh = !existsSync(file) || store.get(id)?.status === "placeholder";
  log(fresh ? "drafting the animation" : "revising the animation");
  try {
    await runAgentForFile(
      ctx,
      ANIMATOR,
      fresh ? draftTask(ctx, data, scene, notes) : reviseTask(ctx, data, scene, notes ?? ""),
      file,
      () => validateSource(file),
    );
  } catch (err) {
    return placeholder(ctx, store, id, [`The Animator could not write a usable scene: ${shortError(err)}`], 0);
  }

  let rounds = 0;
  // "unreviewed" until the Animator has looked at frames of the scene as it now stands.
  let status: SceneStatus["status"] = "unreviewed";
  const reviewNotes: string[] = [];
  let last: SceneCheck;
  for (;;) {
    log("checking: types, then rendering test frames");
    last = await checkScene(ctx, data, id);
    if (last.problems.length) {
      if (rounds >= max) return placeholder(ctx, store, id, last.problems, rounds);
      rounds++;
      status = "unreviewed";
      log(`${last.problems.length} problem(s) found, asking the Animator to fix them (round ${rounds} of ${max})`);
      await runAnimator(ctx, fixTask(ctx, data, scene, last.problems), file, () => validateSource(file));
      continue;
    }
    if (rounds >= max) break;
    rounds++;
    log(`renders cleanly; the Animator is reviewing ${last.stills.length} test frames (round ${rounds} of ${max})`);
    const before = hashOf(await fs.readFile(file, "utf8"));
    await fs.rm(r.review(id), { force: true });
    const review = await runAnimator(ctx, reviewTask(ctx, data, scene, last.stills), r.review(id), () =>
      validateJsonFile(r.review(id), SceneReviewSchema),
    );
    if (hashOf(await fs.readFile(file, "utf8")) === before) {
      // Nothing to fix. If an earlier round fixed things, this look confirms the fix.
      status = status === "unreviewed" && reviewNotes.length === 0 ? "good" : "fixed";
      break;
    }
    status = "unreviewed";
    reviewNotes.push(...(review?.notes.length ? review.notes : ["Changed the scene after looking at the test frames."]));
    // Loop: the change is checked again, and looked at again if rounds remain.
  }

  const final: SceneStatus = {
    status,
    agentRounds: rounds,
    notes: reviewNotes,
    problems: [],
    stills: last.stills.map((s) => path.relative(ctx.production.dir, s.file)),
    sourceHash: hashOf(await fs.readFile(file, "utf8")),
    updatedAt: new Date().toISOString(),
  };
  await store.set(id, final);
  log(`done (${final.status})`);
  return final;
}

/** After you edit scene files by hand: check them the same way, without asking the Animator. */
export async function recheckScene(ctx: StageContext, data: VideoData, id: string, store: StatusStore) {
  const file = renderPaths(ctx).scene(id);
  const check = await checkScene(ctx, data, id);
  const status: SceneStatus = {
    status: "edited",
    agentRounds: 0,
    notes: [],
    problems: check.problems,
    stills: check.stills.map((s) => path.relative(ctx.production.dir, s.file)),
    sourceHash: existsSync(file) ? hashOf(await fs.readFile(file, "utf8")) : "",
    updatedAt: new Date().toISOString(),
  };
  await store.set(id, status);
  return status;
}

/** Run up to `limit` jobs at a time. */
export async function inParallel<T>(items: T[], limit: number, job: (item: T) => Promise<unknown>) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await job(items[next++]!);
  });
  await Promise.all(workers);
}

async function runAnimator<T>(ctx: StageContext, task: string, outFile: string, validate: () => Promise<Validation<T>>) {
  try {
    return await runAgentForFile(ctx, ANIMATOR, task, outFile, validate);
  } catch (err) {
    // A failed round is not fatal: the next check finds out where the scene stands.
    ctx.log(`  ${(err as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

async function placeholder(ctx: StageContext, store: StatusStore, id: string, problems: string[], rounds: number) {
  const r = renderPaths(ctx);
  const file = r.scene(id);
  const keptAs = path.join(r.scenesDir, "broken", `${id}.tsx`);
  if (existsSync(file)) {
    await fs.mkdir(path.dirname(keptAs), { recursive: true });
    await fs.copyFile(file, keptAs);
  }
  await fs.writeFile(file, FALLBACK_SCENE);
  ctx.log(`  ${id}: still failing after ${rounds} round(s); using a simple stand-in scene. The Animator's file is kept in ${keptAs}`);
  const status: SceneStatus = {
    status: "placeholder",
    agentRounds: rounds,
    notes: [],
    problems,
    stills: [],
    sourceHash: hashOf(FALLBACK_SCENE),
    updatedAt: new Date().toISOString(),
  };
  await store.set(id, status);
  return status;
}

async function validateSource(file: string): Promise<Validation<string>> {
  if (!existsSync(file)) return { ok: false, errors: [`${file} does not exist`] };
  const code = await fs.readFile(file, "utf8");
  const problems = checkSceneSource(code);
  return problems.length ? { ok: false, errors: problems } : { ok: true, value: code };
}

function sceneOf(data: VideoData, id: string): SceneData {
  const scene = data.scenes.find((s) => s.id === id);
  if (!scene) throw new Error(`Scene ${id} is not in the video`);
  return scene;
}

function shortError(err: unknown, max = 1500) {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > max ? text.slice(0, max) + " …" : text;
}

// ---------- The Animator's tasks ----------

const README = LIB_README;
const EXAMPLE = LIB_EXAMPLE;

function sceneBrief(data: VideoData, scene: SceneData) {
  const { words, audio, startFrame, ...rest } = scene;
  void audio;
  void startFrame;
  const seconds = (scene.durationInFrames / data.fps).toFixed(1);
  return `The video is ${data.width}x${data.height} pixels at ${data.fps} fps. This scene is ${scene.durationInFrames} frames (${seconds}s) long.

This scene's storyboard and timing, as useScene() returns it. Frames count from the scene's first frame:
${JSON.stringify(rest, null, 2)}

When the narrator says each word (frame: word):
${words.map((w) => `${w.startFrame}: ${w.text}`).join(", ")}`;
}

function draftTask(ctx: StageContext, data: VideoData, scene: SceneData, notes?: string) {
  const file = renderPaths(ctx).scene(scene.id);
  return `Animate scene ${scene.id}, "${scene.title}".

Write the scene component to ${file}

Read these first:
- ${README}: the library you build with, and its rules
- ${EXAMPLE}: a finished scene
- ${files(ctx).storyboard}: the whole storyboard and its style guide, for context (your scene is ${scene.id})

${sceneBrief(data, scene)}
${notes ? `\nThe human producer's notes (they may cover other scenes too; use what applies to ${scene.id}):\n${notes}\n` : ""}`;
}

function reviseTask(ctx: StageContext, data: VideoData, scene: SceneData, notes: string) {
  const file = renderPaths(ctx).scene(scene.id);
  return `The human producer watched the animation and wants changes. Their notes may also cover other scenes;
act only on what applies to scene ${scene.id}, "${scene.title}":
${notes}

The scene's current file is ${file}. Read it, and ${README} for the library, then change what the notes ask for.
Keep everything else as it is.

${sceneBrief(data, scene)}`;
}

function fixTask(ctx: StageContext, data: VideoData, scene: SceneData, problems: string[]) {
  const file = renderPaths(ctx).scene(scene.id);
  return `The scene file ${file} (scene ${scene.id}) has problems that stop it from rendering correctly:
${problems.map((p) => `- ${p}`).join("\n")}

Read the file, and ${README} if you need the library's API. Fix every problem in place and keep the rest of the animation as it is.

${sceneBrief(data, scene)}`;
}

function reviewTask(ctx: StageContext, data: VideoData, scene: SceneData, stills: SceneCheck["stills"]) {
  const r = renderPaths(ctx);
  const describe = (frame: number) => {
    const cue = [...scene.cues].reverse().find((c) => c.startFrame <= frame);
    const sec = (frame / data.fps).toFixed(1);
    return cue
      ? `frame ${frame}, ${sec}s in, ${((frame - cue.startFrame) / data.fps).toFixed(1)}s after the cue "${cue.cue}" for ${cue.elementId}`
      : `frame ${frame}, ${sec}s in`;
  };
  return `Review your animation of scene ${scene.id} the way a viewer will see it. These test frames were rendered from
${r.scene(scene.id)} at ${Math.round(ctx.config.render.stillScale * 100)}% size, with the captions the pipeline adds:
${stills.map((s) => `- ${s.file}: ${describe(s.frame)}`).join("\n")}

Open each image with the Read tool and compare it with the storyboard below. Look for:
- elements the storyboard describes that are missing, or that appear at the wrong moment
- text or shapes that overlap, are cut off, leave the safe area or sit under the captions
- text too small or too low in contrast to read
- frames that look empty, cluttered or lopsided

If you find real problems, fix them in ${r.scene(scene.id)}. Small matters of taste are not worth a change.
Then write ${r.review(scene.id)} as JSON: {"verdict": "good", "notes": []} if nothing needed fixing,
or {"verdict": "fixed", "notes": ["what you changed", ...]}.

${sceneBrief(data, scene)}`;
}
