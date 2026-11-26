import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../media/ffmpeg.js";
import type { Studio } from "../studio.js";
import { getAsset } from "../store/assets.js";
import { getProject, projectPaths } from "../store/projects.js";

export interface PreviewImage {
  /** Absolute path of an image small enough to look at. */
  file: string;
  /** For video: the moment this frame was taken at. */
  atSec?: number;
}

/**
 * Pictures of an asset for an agent to look at: an image scaled down if it is large, or a
 * handful of evenly spaced frames of a video. Made once and kept in the project's work folder.
 */
export async function assetPreview(studio: Studio, assetId: string, opts: { frames?: number; maxSide?: number } = {}): Promise<PreviewImage[]> {
  const asset = getAsset(studio, assetId);
  const p = projectPaths(studio, getProject(studio, asset.projectId));
  const source = p.abs(asset.path);
  const maxSide = opts.maxSide ?? 1280;
  const dir = path.join(p.work, "previews");
  const stem = path.join(dir, asset.sha256.slice(0, 16));
  // Scale the long side down to maxSide, keeping even dimensions.
  const scale = (asset.width ?? 0) >= (asset.height ?? 0) ? `scale=${maxSide}:-2` : `scale=-2:${maxSide}`;
  const big = Math.max(asset.width ?? 0, asset.height ?? 0) > maxSide;

  if (asset.kind === "image") {
    if (!big || path.extname(source).toLowerCase() === ".svg") return [{ file: source }];
    const file = `${stem}-${maxSide}.jpg`;
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      await ffmpeg(["-y", "-i", source, "-vf", scale, "-frames:v", "1", "-q:v", "3", file]);
    }
    return [{ file }];
  }
  if (asset.kind === "video") {
    const count = Math.min(12, Math.max(1, opts.frames ?? 4));
    const length = asset.durationSec ?? 0;
    const out: PreviewImage[] = [];
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      const atSec = Math.round(((i + 0.5) / count) * length * 100) / 100;
      const file = `${stem}-${maxSide}-${i + 1}of${count}.jpg`;
      if (!fs.existsSync(file)) {
        await ffmpeg(["-y", "-ss", String(atSec), "-i", source, ...(big ? ["-vf", scale] : []), "-frames:v", "1", "-q:v", "3", file]);
      }
      out.push({ file, atSec });
    }
    return out;
  }
  throw new Error(`Asset "${asset.label}" is ${asset.kind}, which has no picture to show.`);
}
