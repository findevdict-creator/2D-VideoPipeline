import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Box, CaptionPage, VideoData } from "@pipeline/lib/types";
import { slugify } from "../production.js";
import { gatherClips, joinClips, type Render } from "./assemble.js";
import { newId, nowIso } from "./ids.js";
import { ffmpeg } from "./media/ffmpeg.js";
import { loadPronunciations } from "../voice/text.js";
import { rendererFor } from "./renderers/registry.js";
import { captionPages } from "./renderers/sceneData.js";
import { libHash, renderClip, templateBundle } from "./renderers/remotion.js";
import type { RenderContext } from "./renderers/types.js";
import { clipCacheKey, qualitySettings, renderSceneClip, sceneContext } from "./scenes/render.js";
import { checkSpecAssets } from "./scenes/validate.js";
import type { Studio } from "./studio.js";
import { getChapter, listChapters } from "./store/chapters.js";
import { fromRow, fromRows } from "./store/mapping.js";
import { getProject, projectPaths, type Project } from "./store/projects.js";
import { getScene, type Scene } from "./store/scenes.js";

/** The shapes a video can be exported in. Each is made from the same approved scenes. */
export const EXPORT_FORMATS = {
  landscape: { aspect: "16:9", name: "16:9 landscape", about: "YouTube, a website or a presentation." },
  shorts: { aspect: "9:16", name: "9:16 vertical", about: "YouTube Shorts, Instagram Reels and TikTok. The picture fills the frame, or is shown whole with larger captions under it." },
  square: { aspect: "1:1", name: "1:1 square", about: "Feeds that show square video. The picture fills the frame, or is shown whole with captions under it." },
} as const;

export type ExportFormat = keyof typeof EXPORT_FORMATS;

const ALIASES: Record<string, ExportFormat> = { "16:9": "landscape", wide: "landscape", "9:16": "shorts", vertical: "shorts", short: "shorts", portrait: "shorts", "1:1": "square" };

/** A format by its name, or by its shape: "shorts", "9:16" and "vertical" are the same thing. */
export function exportFormat(name: string): ExportFormat {
  const key = name.trim().toLowerCase();
  if (key in EXPORT_FORMATS) return key as ExportFormat;
  const alias = ALIASES[key];
  if (alias) return alias;
  throw new Error(`"${name}" is not an export format. Choose one of: ${Object.keys(EXPORT_FORMATS).join(", ")}.`);
}

/** YouTube takes a Short of up to three minutes. */
const SHORTS_MAX_SEC = 180;
/** The most a picture may be enlarged: beyond this it is mostly cropped away. */
export const MAX_ZOOM = 2;

/**
 * How a picture of one shape is put in a frame of another.
 * "fill" covers the whole frame and crops what does not fit, with captions over the picture.
 * "whole" shows all of it on the background colour, with captions in a band of their own.
 * "blur" is "whole" with an enlarged, blurred copy of the picture behind it instead of a flat colour.
 */
export const FITS = ["fill", "whole", "blur"] as const;
export type Fit = (typeof FITS)[number];

export interface Size {
  width: number;
  height: number;
}

/** The frame a format gives a project, keeping the project's short side: 1080p becomes 1080 by 1920 for Shorts. */
export function exportSize(project: Pick<Project, "width" | "height">, format: ExportFormat): Size {
  const short = Math.min(project.width, project.height);
  const even = (n: number) => Math.round(n / 2) * 2;
  const aspect = EXPORT_FORMATS[format].aspect;
  if (aspect === "9:16") return { width: short, height: even((short * 16) / 9) };
  if (aspect === "1:1") return { width: short, height: short };
  return { width: even((short * 16) / 9), height: short };
}

export interface ReframeLayout {
  /** Where the whole picture is drawn. Wider than the frame when zoomed in, which crops its sides. */
  picture: Box;
  /** Where captions are laid out, and how large. Null without captions. */
  captions: (Box & { fontSize: number }) | null;
  /** The enlargement used, which is less than the one asked for when that would leave no room for captions. */
  zoom: number;
  /** The longest caption that fits on two lines. */
  maxChars: number;
  /** The share of the picture's area that is inside the frame, from 0 to 1. */
  shown: number;
}

/**
 * Place a picture of one shape in a frame of another. In a taller frame the picture
 * takes the full width (more with `zoom`, which crops its sides) and the captions get a
 * band of their own under it, clear of the buttons a phone app draws over the bottom of
 * a vertical video. In a wider frame the picture takes the full height, with bars of the
 * background colour at its sides and the captions across the bottom.
 * `fontSize` is the caption size of a 1080p video.
 */
export function reframeLayout(source: Size, target: Size, opts: { zoom?: number; fit?: Fit; captions: boolean; fontSize: number }): ReframeLayout {
  const W = target.width;
  const H = target.height;
  const shape = source.width / source.height;
  const perPixel = opts.fontSize / 1080;
  const lines = (fontSize: number) => Math.round(fontSize * 3);
  const fits = (width: number, fontSize: number) => Math.max(8, Math.floor(width / (fontSize * 0.56)) * 2);
  const shownOf = (p: Box) => Math.round(((Math.min(p.width, W) * Math.min(p.height, H)) / (p.width * p.height)) * 1000) / 1000;
  const wider = W / H >= shape - 0.01;

  if (opts.fit === "fill" && Math.abs(W / H - shape) > 0.01) {
    // Cover the frame: the picture is as tall as a taller frame (or as wide as a wider one) and its middle is kept.
    const scale = Math.max(W / source.width, H / source.height);
    const picture = { width: Math.round(source.width * scale), height: Math.round(source.height * scale), x: 0, y: 0 };
    picture.x = Math.round((W - picture.width) / 2);
    picture.y = Math.round((H - picture.height) / 2);
    const vertical = W / H < 0.7;
    const fontSize = Math.max(8, Math.round(perPixel * (wider ? Math.min(W, H) : W * 1.2)));
    const block = lines(fontSize);
    // Over the picture, above the buttons a phone app draws on the bottom of a vertical video.
    const box = { x: Math.round(W * 0.1), y: H - Math.round(H * (vertical ? 0.2 : 0.06)) - block, width: Math.round(W * 0.8), height: block, fontSize };
    return { picture, captions: opts.captions ? box : null, zoom: Math.round((picture.width / W) * 1000) / 1000, maxChars: fits(box.width, fontSize), shown: shownOf(picture) };
  }

  if (wider) {
    const width = Math.round(H * shape);
    const fontSize = Math.max(8, Math.round(perPixel * Math.min(W, H)));
    const block = lines(fontSize);
    const box = { x: Math.round(W * 0.08), y: H - Math.round(H * 0.05) - block, width: Math.round(W * 0.84), height: block, fontSize };
    return { picture: { x: Math.round((W - width) / 2), y: 0, width, height: H }, captions: opts.captions ? box : null, zoom: 1, maxChars: fits(box.width, fontSize), shown: 1 };
  }

  const vertical = W / H < 0.7;
  const top = Math.round(H * (vertical ? 0.08 : 0.04));
  const bottom = Math.round(H * (vertical ? 0.2 : 0.05));
  const fontSize = Math.max(8, Math.round(perPixel * W * 1.2));
  const gap = opts.captions ? Math.round(fontSize * 0.9) : 0;
  const block = opts.captions ? lines(fontSize) : 0;
  const room = H - top - bottom - gap - block;
  const zoom = Math.min(Math.max(1, opts.zoom ?? 1), MAX_ZOOM, Math.max(1, (room * shape) / W));
  const width = Math.round(W * zoom);
  const height = Math.round(width / shape);
  const y = top + Math.max(0, Math.round((room - height) / 2));
  const box = { x: Math.round(W * 0.1), y: y + height + gap, width: Math.round(W * 0.8), height: block, fontSize };
  const picture = { x: Math.round((W - width) / 2), y, width, height };
  return { picture, captions: opts.captions ? box : null, zoom: Math.round(zoom * 1000) / 1000, maxChars: fits(box.width, fontSize), shown: shownOf(picture) };
}

/**
 * Captions made for a wide frame, cut to fit a narrow one: a page too long for two lines
 * is split into equal parts between words. Every word keeps its own time, so the
 * highlight still follows the voice.
 */
export function refitPages(pages: CaptionPage[], maxChars: number): CaptionPage[] {
  const out: CaptionPage[] = [];
  for (const page of pages) {
    const length = page.tokens.reduce((n, t) => n + t.text.length, 0);
    const parts = Math.min(page.tokens.length, Math.ceil(length / Math.max(1, maxChars)));
    if (parts <= 1) {
      out.push(page);
      continue;
    }
    const share = length / parts;
    const groups: CaptionPage["tokens"][] = [[]];
    let used = 0;
    for (const token of page.tokens) {
      const group = groups.at(-1)!;
      // A word goes to the next part when most of it lies past this part's share.
      if (group.length && groups.length < parts && used + token.text.length / 2 > share * groups.length) groups.push([token]);
      else group.push(token);
      used += token.text.length;
    }
    groups.forEach((tokens, i) =>
      out.push({ startFrame: i === 0 ? page.startFrame : tokens[0]!.startFrame, endFrame: i === groups.length - 1 ? page.endFrame : groups[i + 1]![0]!.startFrame, tokens }),
    );
  }
  return out;
}

const sha = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 20);

/** Keep one file per kind in a scene's export folder: an older one is for a version or a framing that was replaced. */
function prune(dir: string, prefix: string) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) if (name.startsWith(prefix)) fs.rmSync(path.join(dir, name), { force: true });
}

/** The same scene with its captions switched on or off, whatever the project says. */
async function withCaptions(studio: Studio, ctx: RenderContext, on: boolean): Promise<RenderContext> {
  if (ctx.data.captions.enabled === on) return ctx;
  const pages = on ? captionPages(studio, ctx.track, ctx.project.fps, await loadPronunciations(studio.config)) : [];
  return { ...ctx, data: { ...ctx.data, captions: { ...ctx.data.captions, enabled: on, pages } } };
}

/**
 * A scene's clip in final quality with captions on or off. When that is how the project
 * has them, it is the scene's own clip. Otherwise it is rendered once and kept, so every
 * export made from the scene starts from the same picture.
 */
async function sceneClip(studio: Studio, ctx: RenderContext, captions: boolean, log: (m: string) => void): Promise<{ file: string; key: string; frames: number; cached: boolean }> {
  const p = projectPaths(studio, ctx.project);
  if (ctx.data.captions.enabled === captions) {
    const { clip, cached } = await renderSceneClip(studio, ctx.scene.id, "final", () => {}, log, ctx.version.id);
    return { file: p.abs(clip.path), key: clip.cacheKey, frames: clip.durationFrames, cached };
  }
  const q = qualitySettings(studio, "final");
  const changed = await withCaptions(studio, ctx, captions);
  const data = changed.data;
  const key = await clipCacheKey(changed, q);
  const frames = data.scenes[0]!.durationInFrames;
  const dir = path.join(ctx.workDir, "export");
  const prefix = captions ? "subs-" : "clean-";
  const file = path.join(dir, `${prefix}${key}.mp4`);
  if (fs.existsSync(file)) return { file, key, frames, cached: true };
  const problems = checkSpecAssets(studio, ctx.project.id, ctx.version.spec);
  if (problems.length) throw new Error(`The scene cannot be rendered:\n  - ${problems.join("\n  - ")}`);
  prune(dir, prefix);
  const result = await rendererFor(ctx.version.spec.type).render({ ...changed, data: { ...data, assetBase: await studio.assetBase(ctx.project.slug) } }, q, file, () => {});
  if (result.durationFrames !== frames) throw new Error(`The clip is ${result.durationFrames} frames long but the narration needs ${frames}.`);
  return { file, key, frames, cached: false };
}

/** A scene's clip in the project's own shape, with captions switched the way this export wants them. */
export async function captionedClip(studio: Studio, scene: Scene, versionId: string, captions: boolean, log: (m: string) => void = () => {}): Promise<{ file: string; frames: number; cached: boolean }> {
  return sceneClip(studio, await sceneContext(studio, scene.id, log, versionId), captions, log);
}

export interface Framing {
  zoom: number;
  fit: Fit;
  /** Captions drawn in the picture. Without it, the project's own setting. */
  captions?: boolean;
}

/**
 * A scene's clip in a frame of another shape: its picture placed by `reframeLayout` and
 * its captions drawn again to fit. Kept until the scene, the framing or the captions change.
 */
export async function reframedClip(
  studio: Studio,
  scene: Scene,
  versionId: string,
  target: Size,
  framing: number | Framing,
  log: (m: string) => void = () => {},
): Promise<{ file: string; frames: number; cached: boolean }> {
  const base = await sceneContext(studio, scene.id, log, versionId);
  const { zoom, fit, captions = base.data.captions.enabled } = typeof framing === "number" ? ({ zoom: framing, fit: "whole" } as Framing) : framing;
  const p = projectPaths(studio, base.project);
  const q = qualitySettings(studio, "final");
  const clean = await sceneClip(studio, base, false, log);
  const ctx = await withCaptions(studio, base, captions);
  const layout = reframeLayout(ctx.project, target, { zoom, fit, captions, fontSize: studio.config.render.captions.fontSize });
  const data: VideoData = {
    ...ctx.data,
    width: target.width,
    height: target.height,
    captionSafeArea: 0,
    captions: { ...ctx.data.captions, pages: layout.captions ? refitPages(ctx.data.captions.pages, layout.maxChars) : [] },
    reframe: { src: p.rel(clean.file), picture: layout.picture, captions: layout.captions, ...(fit === "blur" ? { backdrop: "blur" as const } : {}) },
  };
  const key = sha(JSON.stringify({ clean: clean.key, data, lib: libHash(), crf: q.crf }));
  const dir = path.join(ctx.workDir, "export");
  const prefix = `${target.width}x${target.height}-`;
  const file = path.join(dir, `${prefix}${key}.mp4`);
  if (fs.existsSync(file)) return { file, frames: clean.frames, cached: clean.cached };
  prune(dir, prefix);
  const serveUrl = await templateBundle(studio, ctx.project);
  const result = await renderClip({ ...ctx, data: { ...data, assetBase: await studio.assetBase(ctx.project.slug) } }, serveUrl, q, file, () => {});
  if (result.durationFrames !== clean.frames) throw new Error(`The reframed clip is ${result.durationFrames} frames long but the scene is ${clean.frames}.`);
  return { file, frames: result.durationFrames, cached: false };
}

export interface ExportRecord {
  id: string;
  projectId: string;
  format: ExportFormat;
  /** "project", or a chapter id. */
  scope: string;
  /** The package folder, relative to the project folder. */
  folder: string;
  /** The files in the package, relative to the project folder. */
  files: { video: string; subtitles: string; thumbnail: string | null; description: string; manifest: string };
  width: number;
  height: number;
  durationSec: number;
  sceneVersions: Render["sceneVersions"];
  /** Things worth knowing about this export, such as a Short that is too long for YouTube. */
  notes: string[];
  createdAt: string;
}

export interface ExportOptions {
  format?: ExportFormat;
  /** Export one chapter instead of the whole video. */
  chapterId?: string;
  /** How much larger than the frame's width the picture is drawn in a taller frame. 1 shows all of it; more crops the sides. */
  zoom?: number;
  /** How the picture is put in a frame of another shape. Without it: "fill", or "whole" when a zoom is given. */
  fit?: Fit;
  /** Captions drawn in the picture. Without it, the project's own setting. The subtitle file is written either way. */
  captions?: boolean;
  concurrency?: number;
  onProgress?: (done: number, total: number, label: string) => void;
  log?: (message: string) => void;
}

export interface ExportResult {
  export: ExportRecord;
  /** Full path of the package folder. */
  folder: string;
  /** Full path of the video. */
  file: string;
  /** How many clips were rendered now, as opposed to reused. */
  rendered: number;
  reused: number;
}

export function listExports(studio: Studio, projectId: string): ExportRecord[] {
  return fromRows<ExportRecord>(studio.db.all("SELECT * FROM exports WHERE project_id = ? ORDER BY created_at DESC, rowid DESC", [projectId]));
}

/** "1:02" or "1:02:03", the way video sites write chapter times. */
export function timestamp(sec: number): string {
  const s = Math.floor(sec);
  const two = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/**
 * Export the approved video, or one chapter of it, as a package: the video in the asked
 * shape, its subtitles, a thumbnail, and a description with chapter times. A shape other
 * than the project's own is made from the same scene clips, placed in the new frame with
 * their captions laid out again; no scene is built again, and a second export of the
 * same shape reuses every clip.
 */
export async function exportVideo(studio: Studio, projectId: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const project = getProject(studio, projectId);
  const p = projectPaths(studio, project);
  const log = opts.log ?? (() => {});
  const format = opts.format ?? (Object.keys(EXPORT_FORMATS) as ExportFormat[]).find((f) => EXPORT_FORMATS[f].aspect === project.aspect)!;
  const size = exportSize(project, format);
  const asBuilt = EXPORT_FORMATS[format].aspect === project.aspect;
  const notes: string[] = [];
  const asked = opts.zoom ?? 1;
  if (!(asked >= 1 && asked <= MAX_ZOOM)) throw new Error(`The zoom is a number from 1 (the whole picture) to ${MAX_ZOOM}.`);
  if (opts.fit && !(FITS as readonly string[]).includes(opts.fit)) throw new Error(`The fit is one of: ${FITS.join(", ")}.`);
  const ownCaptions = project.settings.captions && studio.config.render.captions.enabled;
  const captions = opts.captions ?? ownCaptions;
  const fit: Fit = opts.fit ?? (opts.zoom === undefined ? "fill" : "whole");
  const layout = asBuilt ? undefined : reframeLayout(project, size, { zoom: asked, fit, captions, fontSize: studio.config.render.captions.fontSize });
  if (layout && fit === "fill") {
    notes.push(`The picture fills the frame, which shows the middle ${Math.round(layout.shown * 100)}% of it and crops the rest. To show all of it, export with "The whole picture".`);
  } else if (layout && asked > layout.zoom + 0.001) {
    notes.push(
      size.width / size.height >= project.width / project.height
        ? "This shape is wider than the video, so the whole picture is shown with bars at its sides and the zoom was left at 1."
        : `A zoom of ${asked} would leave no room for captions, so ${layout.zoom} was used.`,
    );
  }

  const { parts, rendered, reused } = await gatherClips(studio, projectId, {
    quality: "final",
    chapterId: opts.chapterId,
    concurrency: opts.concurrency,
    onProgress: opts.onProgress,
    log,
    clipFor: !asBuilt
      ? (scene, versionId) => reframedClip(studio, scene, versionId, size, { zoom: fit === "fill" ? 1 : layout!.zoom, fit, captions }, log)
      : captions !== ownCaptions
        ? (scene, versionId) => captionedClip(studio, scene, versionId, captions, log)
        : undefined,
  });

  const scope = opts.chapterId ? `chapter-${getChapter(studio, opts.chapterId).position}` : "video";
  const n = (studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM exports WHERE project_id = ?", [project.id])?.n ?? 0) + 1;
  const name = `${slugify(project.title, 8)}-${scope}-${format}-${String(n).padStart(3, "0")}`;
  const folder = path.join(p.exports, name);
  fs.mkdirSync(folder, { recursive: true });
  const video = path.join(folder, `${name}.mp4`);
  const { sceneVersions, durationSec, srt } = await joinClips(studio, projectId, parts, video, log);

  // The thumbnail: late in the first scene, when what it shows has arrived.
  const thumbnail = path.join(folder, "thumbnail.jpg");
  const first = sceneVersions[0]!;
  try {
    await ffmpeg(["-ss", ((first.frames * 0.8) / project.fps).toFixed(3), "-i", video, "-frames:v", "1", "-q:v", "2", thumbnail]);
  } catch (err) {
    notes.push(`The thumbnail could not be made: ${(err as Error).message.split("\n")[0]}`);
  }

  // Chapter times, as video sites read them from a description.
  const chapters: { title: string; startSec: number }[] = [];
  if (!opts.chapterId) {
    for (const chapter of listChapters(studio, project.id)) {
      const start = sceneVersions.find((v) => getScene(studio, v.sceneId).chapterId === chapter.id);
      if (start) chapters.push({ title: chapter.title, startSec: start.startFrame / project.fps });
    }
  }
  const description = path.join(folder, "description.txt");
  const about = [opts.chapterId ? `${project.title}: ${getChapter(studio, opts.chapterId).title}` : project.title, "", project.description];
  if (chapters.length > 1) about.push("", "Chapters", ...chapters.map((c) => `${timestamp(c.startSec)} ${c.title}`));
  fs.writeFileSync(description, about.join("\n") + "\n");

  if (format === "shorts" && durationSec > SHORTS_MAX_SEC) {
    notes.push(`This video is ${timestamp(durationSec)} long. YouTube takes Shorts of up to ${SHORTS_MAX_SEC / 60} minutes, so a longer one is treated as an ordinary video. One chapter can be exported by itself.`);
  }

  const id = newId("ex");
  const createdAt = nowIso();
  const manifest = path.join(folder, "export.json");
  const files = { video: p.rel(video), subtitles: p.rel(srt), thumbnail: fs.existsSync(thumbnail) ? p.rel(thumbnail) : null, description: p.rel(description), manifest: p.rel(manifest) };
  fs.writeFileSync(
    manifest,
    JSON.stringify(
      {
        project: project.title,
        format,
        shape: EXPORT_FORMATS[format].aspect,
        width: size.width,
        height: size.height,
        fps: project.fps,
        durationSec,
        zoom: layout?.zoom ?? 1,
        fit: asBuilt ? null : fit,
        captionsInPicture: captions,
        createdAt,
        files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v ? path.basename(v) : null])),
        chapters,
        scenes: sceneVersions.map((v) => ({ title: getScene(studio, v.sceneId).title, version: v.version, startSec: v.startFrame / project.fps, durationSec: v.frames / project.fps })),
        notes,
      },
      null,
      2,
    ) + "\n",
  );
  studio.db.run(
    `INSERT INTO exports (id, project_id, format, scope, folder, files_json, width, height, duration_sec, scene_versions_json, notes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, project.id, format, opts.chapterId ?? "project", p.rel(folder), JSON.stringify(files), size.width, size.height, durationSec, JSON.stringify(sceneVersions), JSON.stringify(notes), createdAt],
  );
  studio.emit("export.created", { projectId: project.id, targetId: id });
  log(`Exported ${parts.length} scene(s) as ${EXPORT_FORMATS[format].name}, ${durationSec.toFixed(1)}s: ${folder}`);
  return { export: fromRow<ExportRecord>(studio.db.get("SELECT * FROM exports WHERE id = ?", [id]))!, folder, file: video, rendered, reused };
}
