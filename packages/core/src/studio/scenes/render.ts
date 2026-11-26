import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { framesToCheck } from "../../render/remotion.js";
import { loadPronunciations } from "../../voice/text.js";
import { buildSceneData } from "../renderers/sceneData.js";
import { rendererFor } from "../renderers/registry.js";
import type { QualitySettings, RenderContext } from "../renderers/types.js";
import type { Studio } from "../studio.js";
import { getClip, saveClip, type Clip, type ClipQuality } from "../store/clips.js";
import { fromRow } from "../store/mapping.js";
import { getProject, projectPaths } from "../store/projects.js";
import { currentVersion, getScene, getVersion, hashText, setSceneStatus, updateVersion, versionPaths, type SceneVersion, type Still } from "../store/scenes.js";
import { ensureVoice } from "../voice.js";
import { checkSpecAssets } from "./validate.js";

type Log = (message: string) => void;
const quiet: Log = () => {};

export function qualitySettings(studio: Studio, quality: ClipQuality): QualitySettings {
  const rc = studio.config.render;
  return quality === "final" ? { quality, scale: 1, crf: rc.crf } : { quality, scale: rc.previewScale, crf: rc.previewCrf };
}

/**
 * Gather everything needed to check or render a scene's version: its recorded narration,
 * the data the library draws from, and where its files are. `versionId` picks an older
 * version; without it, the scene's current one.
 */
export async function sceneContext(studio: Studio, sceneId: string, log: Log = quiet, versionId?: string): Promise<RenderContext> {
  let scene = getScene(studio, sceneId);
  const project = getProject(studio, scene.projectId);
  if (!scene.currentVersionId) throw new Error(`Scene "${scene.title}" has no spec yet. Save a spec before checking or rendering it.`);
  const tracks = await ensureVoice(studio, [sceneId], log);
  scene = getScene(studio, sceneId);
  let version: SceneVersion = versionId ? getVersion(studio, versionId) : currentVersion(studio, scene)!;
  let track = tracks.get(sceneId)!;
  if (versionId && version.voiceTrackId && version.voiceTrackId !== track.id) {
    // An older version keeps the narration it was made with.
    const old = fromRow<typeof track>(studio.db.get("SELECT * FROM voice_tracks WHERE id = ?", [version.voiceTrackId]));
    if (old) track = old;
  }
  const paths = versionPaths(studio, project, version);
  if (paths.source && fs.existsSync(paths.source)) {
    const hash = hashText(fs.readFileSync(paths.source, "utf8"));
    if (hash !== version.sourceHash) version = updateVersion(studio, version.id, { sourceHash: hash });
  }
  const data = buildSceneData(studio, project, scene, version, track, await loadPronunciations(studio.config));
  return {
    studio,
    project,
    scene,
    version,
    track,
    data,
    sourceFile: paths.source,
    workDir: path.join(projectPaths(studio, project).work, sceneId),
    log,
  };
}

/** Problems that would stop this scene from rendering. Saved on the version, so the GUI can show them. */
export async function checkScene(studio: Studio, sceneId: string, log: Log = quiet): Promise<string[]> {
  const ctx = await sceneContext(studio, sceneId, log);
  const problems = checkSpecAssets(studio, ctx.project.id, ctx.version.spec);
  if (!problems.length) problems.push(...(await rendererFor(ctx.version.spec.type).check(ctx)));
  updateVersion(studio, ctx.version.id, { checkProblems: problems });
  return problems;
}

/** Still frames of the scene for review. Without `frames`, picks moments just after each cue and near the end. */
export async function renderSceneStills(studio: Studio, sceneId: string, opts: { frames?: number[]; cues?: string[] } = {}, log: Log = quiet): Promise<Still[]> {
  const ctx = await sceneContext(studio, sceneId, log);
  const sceneData = ctx.data.scenes[0]!;
  const last = sceneData.durationInFrames - 1;
  let frames = opts.frames?.map((f) => Math.min(last, Math.max(0, Math.round(f)))) ?? [];
  for (const id of opts.cues ?? []) {
    const cue = sceneData.cues.find((c) => c.elementId === id.replace(/__\d+$/, ""));
    if (!cue) throw new Error(`There is no cue with the id "${id}" in this scene.`);
    frames.push(Math.min(last, cue.startFrame + Math.round(ctx.project.fps * 0.7)));
  }
  if (!frames.length) frames = framesToCheck(sceneData, ctx.project.fps, studio.config.animator.stillsPerScene);
  frames = [...new Set(frames)].sort((a, b) => a - b);

  const paths = versionPaths(studio, ctx.project, ctx.version);
  const data = { ...ctx.data, assetBase: await studio.assetBase(ctx.project.slug) };
  const files = await rendererFor(ctx.version.spec.type).stills({ ...ctx, data }, frames, paths.stills, studio.config.render.stillScale);
  const p = projectPaths(studio, ctx.project);
  const stills = files.map((file, i) => ({ file: p.rel(file), frame: frames[i]! }));
  updateVersion(studio, ctx.version.id, { stills });
  studio.emit("scene.changed", { projectId: ctx.project.id, targetId: sceneId });
  return stills;
}

/** What decides how a clip looks, as one hash. An unchanged key means the old clip is still right. */
export async function clipCacheKey(ctx: RenderContext, q: QualitySettings): Promise<string> {
  const renderer = rendererFor(ctx.version.spec.type);
  return createHash("sha1")
    .update(JSON.stringify({ data: ctx.data, inputs: await renderer.cacheInputs(ctx), renderer: `${renderer.type}@${renderer.revision}`, scale: q.scale, crf: q.crf }))
    .digest("hex")
    .slice(0, 20);
}

export interface RenderedClip {
  clip: Clip;
  /** True when nothing had changed and the existing clip was kept. */
  cached: boolean;
}

/**
 * Render a scene version to its clip, or keep the clip it already has when nothing that
 * affects the picture has changed.
 */
export async function renderSceneClip(
  studio: Studio,
  sceneId: string,
  quality: ClipQuality = "preview",
  onProgress: (progress: number) => void = () => {},
  log: Log = quiet,
  versionId?: string,
): Promise<RenderedClip> {
  const ctx = await sceneContext(studio, sceneId, log, versionId);
  const q = qualitySettings(studio, quality);
  const key = await clipCacheKey(ctx, q);
  const p = projectPaths(studio, ctx.project);
  const output = versionPaths(studio, ctx.project, ctx.version).clip(quality);

  const existing = getClip(studio, ctx.version.id, quality);
  if (existing && existing.cacheKey === key && fs.existsSync(p.abs(existing.path))) {
    afterRender(studio, sceneId, versionId);
    return { clip: existing, cached: true };
  }
  // The same picture may already exist on another version, for example after a rollback.
  const twin = fromRow<Clip>(
    studio.db.get(
      `SELECT c.* FROM clips c JOIN scene_versions v ON v.id = c.scene_version_id
       WHERE v.scene_id = ? AND c.cache_key = ? AND c.quality = ? AND c.scene_version_id != ?`,
      [sceneId, key, quality, ctx.version.id],
    ),
  );
  if (twin && fs.existsSync(p.abs(twin.path))) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(p.abs(twin.path), output);
    const clip = saveClip(studio, { sceneVersionId: ctx.version.id, quality, cacheKey: key, path: p.rel(output), durationFrames: twin.durationFrames, width: twin.width, height: twin.height });
    afterRender(studio, sceneId, versionId);
    return { clip, cached: true };
  }

  const problems = checkSpecAssets(studio, ctx.project.id, ctx.version.spec);
  if (problems.length) throw new Error(`The scene cannot be rendered:\n  - ${problems.join("\n  - ")}`);
  const data = { ...ctx.data, assetBase: await studio.assetBase(ctx.project.slug) };
  const result = await rendererFor(ctx.version.spec.type).render({ ...ctx, data }, q, output, onProgress);
  const expected = ctx.data.scenes[0]!.durationInFrames;
  if (result.durationFrames !== expected) {
    throw new Error(`The clip is ${result.durationFrames} frames long but the narration needs ${expected}.`);
  }
  const clip = saveClip(studio, {
    sceneVersionId: ctx.version.id,
    quality,
    cacheKey: key,
    path: p.rel(result.file),
    durationFrames: result.durationFrames,
    width: result.width,
    height: result.height,
  });
  afterRender(studio, sceneId, versionId);
  return { clip, cached: false };
}

function afterRender(studio: Studio, sceneId: string, versionId?: string) {
  const scene = getScene(studio, sceneId);
  if (versionId && versionId !== scene.currentVersionId) return;
  if (["planned", "spec_ready", "failed"].includes(scene.status)) setSceneStatus(studio, sceneId, "rendered");
  else studio.emit("scene.changed", { projectId: scene.projectId, targetId: sceneId });
}
