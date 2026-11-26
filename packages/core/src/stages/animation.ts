import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { StageContext } from "../context.js";
import { animateScene, inParallel, recheckScene, scenesInNotes, StatusStore } from "../render/animate.js";
import { reloadRenderSettings, renderPaths, writeProject } from "../render/project.js";
import { bundleProduction, renderVideo, typecheckScenes } from "../render/remotion.js";
import { checkSceneSource } from "../render/sceneCheck.js";
import { readJson } from "./files.js";
import type { Stage } from "./types.js";
import type { VideoData } from "@pipeline/lib/types";

/**
 * Have the Animator animate the scenes. With notes, only the scenes the notes name
 * (or every scene, if they name none). Without notes, every scene not yet finished.
 */
export async function animate(ctx: StageContext, notes?: string) {
  const data = await writeProject(ctx);
  const store = await StatusStore.load(ctx);
  const ids = data.scenes.map((s) => s.id);
  let targets: string[];
  if (notes) {
    const named = scenesInNotes(notes, ids);
    targets = named.length ? named : ids;
  } else {
    targets = [];
    for (const id of ids) if (!(await store.isDone(ctx, id))) targets.push(id);
  }
  if (targets.length) {
    const parallel = ctx.config.animator.parallelScenes;
    ctx.log(
      `▸ Animating ${targets.length} scene(s): ${targets.join(", ")}` +
        (parallel > 1 ? `, ${parallel} at a time` : "") +
        (targets.length < ids.length ? ` (the others are unchanged)` : ""),
    );
    await inParallel(targets, parallel, (id) => animateScene(ctx, data, id, store, notes));
  }
  return data;
}

/** Render the whole video at preview size. */
export async function renderPreview(ctx: StageContext) {
  await writeProject(ctx);
  ctx.log("▸ Rendering the preview...");
  const serveUrl = await bundleProduction(ctx);
  const rc = ctx.config.render;
  const out = await renderVideo(ctx, serveUrl, {
    output: renderPaths(ctx).preview,
    scale: rc.previewScale,
    crf: rc.previewCrf,
    label: "Preview",
  });
  ctx.log(`✓ Preview: ${out.output} (${out.width}x${out.height}, ${out.durationSec.toFixed(1)}s)`);
}

/** Problems in the scene files: rule breaks and type errors. Used after hand edits. */
export async function sceneProblems(ctx: StageContext): Promise<string[]> {
  const r = renderPaths(ctx);
  if (!existsSync(r.data)) return [];
  const data = await readJson<VideoData>(r.data);
  const problems: string[] = [];
  for (const s of data.scenes) {
    if (!existsSync(r.scene(s.id))) continue;
    for (const p of checkSceneSource(await fs.readFile(r.scene(s.id), "utf8"))) problems.push(`scenes/${s.id}.tsx: ${p}`);
  }
  for (const errors of Object.values(await typecheckScenes(ctx))) problems.push(...errors);
  return problems;
}

export const animationStage: Stage = {
  id: "animation",
  title: "Animation",

  outputs: (ctx) => [renderPaths(ctx).preview, renderPaths(ctx).stills, renderPaths(ctx).scenesDir],

  archiveFiles: (ctx) => {
    const r = renderPaths(ctx);
    const ids = existsSync(r.data) ? (JSON.parse(readFileSync(r.data, "utf8")) as VideoData).scenes.map((s) => s.id) : [];
    return [r.status, ...ids.map((id) => r.scene(id))];
  },

  async produce(ctx, notes) {
    await animate(ctx, notes);
    await renderPreview(ctx);
  },

  async afterEdit(ctx) {
    reloadRenderSettings(ctx);
    const data = await writeProject(ctx);
    const store = await StatusStore.load(ctx);
    ctx.log("▸ Checking the scenes you edited...");
    for (const s of data.scenes) {
      if (await store.isDone(ctx, s.id)) continue;
      const result = await recheckScene(ctx, data, s.id, store);
      ctx.log(result.problems.length ? `  ${s.id}: ${result.problems.join("; ")}` : `  ${s.id}: renders cleanly`);
    }
    try {
      await renderPreview(ctx);
    } catch (err) {
      ctx.log(`The preview could not be rendered: ${(err as Error).message.split("\n")[0]}`);
    }
  },

  async summarize(ctx) {
    const r = renderPaths(ctx);
    const store = await StatusStore.load(ctx);
    const data = await readJson<VideoData>(r.data);
    const label: Record<string, string> = {
      good: "looks good to the Animator",
      fixed: "fixed after a look at the test frames",
      unreviewed: "renders, but the last change was not looked at again",
      placeholder: "PLACEHOLDER: the Animator's version kept failing",
      edited: "edited by you",
    };
    const lines = [`${data.scenes.length} scenes, ${(data.scenes.reduce((n, s) => n + s.durationInFrames, 0) / data.fps).toFixed(1)}s, ${data.width}x${data.height} at ${data.fps} fps`, ""];
    for (const s of data.scenes) {
      const st = store.get(s.id);
      if (!st) {
        lines.push(`${s.id}  not animated`);
        continue;
      }
      const rounds = st.agentRounds ? ` (${st.agentRounds} check round${st.agentRounds > 1 ? "s" : ""})` : "";
      lines.push(`${s.id}  ${label[st.status] ?? st.status}${rounds}`);
      for (const n of st.notes.slice(0, 4)) lines.push(`      - ${n}`);
      for (const p of st.problems.slice(0, 3)) lines.push(`      ! ${p.split("\n")[0]}`);
      if (st.status === "placeholder") lines.push(`      The Animator's file is kept in ${path.join(r.scenesDir, "broken", `${s.id}.tsx`)}`);
    }
    lines.push(
      "",
      `Watch the preview: ${r.preview}`,
      `Test frames: ${r.stills}   Scene code: ${r.scenesDir}`,
      `Scrub through it in Remotion Studio: npm run pipeline -- studio ${ctx.production.id}`,
      "To change things, choose [r] and describe it. Name scenes (\"s03\" or \"scene 3\") to redo only those;",
      "notes that name no scene go to every scene. Or edit scenes/*.tsx yourself and choose [e].",
    );
    return lines.join("\n");
  },

  async validate(ctx) {
    return sceneProblems(ctx);
  },
};
