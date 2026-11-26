import fs from "node:fs";
import path from "node:path";
import { serializeSrt, type Caption } from "@remotion/captions";
import { slugify } from "../production.js";
import { loadPronunciations } from "../voice/text.js";
import { newId, nowIso } from "./ids.js";
import { ffmpeg } from "./media/ffmpeg.js";
import { captionPages } from "./renderers/sceneData.js";
import { renderSceneClip } from "./scenes/render.js";
import { buildSoundtrack, mixArgs } from "./sound/mix.js";
import type { Studio } from "./studio.js";
import { getChapter } from "./store/chapters.js";
import type { Clip, ClipQuality } from "./store/clips.js";
import { fromRow, fromRows } from "./store/mapping.js";
import { getProject, projectPaths } from "./store/projects.js";
import { getVersion, listScenes, sceneLabel, type Scene } from "./store/scenes.js";
import { ensureVoice, getVoiceTrack } from "./voice.js";

export interface Render {
  id: string;
  projectId: string;
  kind: ClipQuality;
  /** "project", or a chapter id. */
  scope: string;
  /** Relative to the project folder. */
  path: string;
  srtPath: string | null;
  /** Which version of each scene went in, in order. */
  sceneVersions: { sceneId: string; versionId: string; version: number; startFrame: number; frames: number }[];
  durationSec: number;
  createdAt: string;
}

export interface AssembleOptions {
  quality?: ClipQuality;
  /** Assemble one chapter instead of the whole video. */
  chapterId?: string;
  /**
   * Use only versions you approved. On by default for final renders, where every scene
   * must be approved. Off by default for previews, which show each scene as it stands.
   */
  approvedOnly?: boolean;
  /** How many missing clips are rendered at once. */
  concurrency?: number;
  onProgress?: (done: number, total: number, label: string) => void;
  log?: (message: string) => void;
}

export interface AssembleResult {
  render: Render;
  file: string;
  /** Scenes left out, and why. Only previews leave scenes out. */
  skipped: { sceneId: string; label: string; title: string; reason: string }[];
  /** How many clips were rendered now, as opposed to reused. */
  rendered: number;
  reused: number;
}

export function listRenders(studio: Studio, projectId: string): Render[] {
  return fromRows<Render>(studio.db.all("SELECT * FROM renders WHERE project_id = ? ORDER BY created_at DESC", [projectId]));
}

/**
 * Join scene clips into one video with narration, music, sound effects and a subtitle file. Clips are
 * joined without re-encoding, so this takes seconds once the clips exist; only scenes
 * whose clip is missing or out of date are rendered.
 */
export async function assemble(studio: Studio, projectId: string, opts: AssembleOptions = {}): Promise<AssembleResult> {
  const project = getProject(studio, projectId);
  const quality = opts.quality ?? "preview";
  const approvedOnly = opts.approvedOnly ?? quality === "final";
  const log = opts.log ?? (() => {});
  const p = projectPaths(studio, project);
  const scenes = listScenes(studio, project.id, opts.chapterId);
  if (!scenes.length) throw new Error("There are no scenes to assemble yet.");

  const skipped: AssembleResult["skipped"] = [];
  const skip = (scene: Scene, reason: string) => skipped.push({ sceneId: scene.id, label: sceneLabel(studio, scene), title: scene.title, reason });
  const chosen: { scene: Scene; versionId: string }[] = [];
  for (const scene of scenes) {
    // A scene an agent is working on right now is half-written: show the version you last approved instead, if there is one.
    const building = !approvedOnly && scene.status === "in_production";
    const versionId = approvedOnly || building ? scene.approvedVersionId : scene.currentVersionId;
    if (versionId) chosen.push({ scene, versionId });
    else skip(scene, approvedOnly ? "not approved yet" : building ? "still being built" : "not built yet");
  }
  if (quality === "final" && skipped.length) {
    throw new Error(
      `The final video needs every scene approved. Still open:\n${skipped.map((s) => `  ${s.label} ${s.title}: ${s.reason}`).join("\n")}`,
    );
  }

  // One recording pass for every scene that still needs narration, instead of one per scene.
  await ensureVoice(studio, chosen.filter((c) => c.versionId === c.scene.currentVersionId).map((c) => c.scene.id), log);

  let rendered = 0;
  let reused = 0;
  // Clips that exist are reused as they are; the missing ones are rendered a few at a time, which is what makes a long video's final render bearable.
  const slots: ({ scene: Scene; versionId: string; clip: Clip } | undefined)[] = new Array(chosen.length);
  let next = 0;
  let finished = 0;
  let failure: Error | undefined;
  const worker = async () => {
    while (next < chosen.length && !failure) {
      const i = next++;
      const item = chosen[i]!;
      const label = `${sceneLabel(studio, item.scene)} ${item.scene.title}`;
      try {
        const result = await renderSceneClip(studio, item.scene.id, quality, () => {}, log, item.versionId);
        if (result.cached) reused++;
        else {
          rendered++;
          log(`Rendered ${label}`);
        }
        slots[i] = { ...item, clip: result.clip };
      } catch (err) {
        if (quality === "final") failure ??= new Error(`Scene ${label} could not be rendered: ${(err as Error).message}`);
        else skip(item.scene, `could not be rendered: ${(err as Error).message.split("\n")[0]}`);
      }
      opts.onProgress?.(++finished, chosen.length, label);
    }
  };
  opts.onProgress?.(0, chosen.length, "");
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 1, chosen.length)) }, worker));
  if (failure) throw failure;
  const parts = slots.filter((s) => s !== undefined);
  if (!parts.length) throw new Error(`No scene could be included:\n${skipped.map((s) => `  ${s.label} ${s.title}: ${s.reason}`).join("\n")}`);
  opts.onProgress?.(chosen.length, chosen.length, "Joining clips");

  // Lay everything out on the frame grid.
  const pronunciations = await loadPronunciations(studio.config);
  const captions: Caption[][] = [];
  const sceneVersions: Render["sceneVersions"] = [];
  let start = 0;
  for (const part of parts) {
    const version = getVersion(studio, part.versionId);
    const track = version.voiceTrackId ? getVoiceTrack(studio, version.voiceTrackId) : undefined;
    const frames = part.clip.durationFrames;
    if (track) {
      const ms = (frame: number) => ((start + frame) / project.fps) * 1000;
      for (const page of captionPages(studio, track, project.fps, pronunciations)) {
        captions.push(page.tokens.map((t) => ({ text: t.text, startMs: ms(t.startFrame), endMs: ms(t.endFrame), timestampMs: null, confidence: null })));
      }
    }
    sceneVersions.push({ sceneId: part.scene.id, versionId: version.id, version: version.version, startFrame: start, frames });
    start += frames;
  }
  const totalFrames = start;
  const durationSec = totalFrames / project.fps;

  const work = path.join(p.work, "assembly", newId("a"));
  fs.mkdirSync(work, { recursive: true });
  try {
    const list = path.join(work, "clips.txt");
    fs.writeFileSync(list, parts.map((part) => `file '${p.abs(part.clip.path).split(path.sep).join("/").replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const sound = await buildSoundtrack(studio, project, sceneVersions, work, log);

    const scope = opts.chapterId ? `chapter-${getChapter(studio, opts.chapterId).position}` : "video";
    const n = (studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM renders WHERE project_id = ?", [project.id])?.n ?? 0) + 1;
    const name = `${slugify(project.title, 8)}-${scope}-${quality}-${String(n).padStart(3, "0")}`;
    fs.mkdirSync(p.renders, { recursive: true });
    const output = path.join(p.renders, `${name}.mp4`);

    // Narration, music dipped under it, and the scenes' sound effects, mixed in one pass.
    const mix = mixArgs(sound, 1);
    const args = ["-f", "concat", "-safe", "0", "-i", list, ...mix.inputs];
    if (mix.filter) args.push("-filter_complex", mix.filter);
    args.push("-map", "0:v", "-map", mix.map, "-ar", "48000");
    args.push("-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", durationSec.toFixed(3), "-movflags", "+faststart", output);
    await ffmpeg(args);

    const srt = path.join(p.renders, `${name}.srt`);
    fs.writeFileSync(srt, serializeSrt({ lines: captions }));

    const id = newId("rn");
    studio.db.run(
      "INSERT INTO renders (id, project_id, kind, scope, path, srt_path, scene_versions_json, duration_sec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, project.id, quality, opts.chapterId ?? "project", p.rel(output), p.rel(srt), JSON.stringify(sceneVersions), durationSec, nowIso()],
    );
    studio.emit("render.created", { projectId: project.id, targetId: id });
    const render = fromRow<Render>(studio.db.get("SELECT * FROM renders WHERE id = ?", [id]))!;
    log(`Assembled ${parts.length} scene(s), ${durationSec.toFixed(1)}s: ${output}`);
    return { render, file: output, skipped, rendered, reused };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
