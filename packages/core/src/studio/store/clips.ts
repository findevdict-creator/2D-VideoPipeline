import { newId, nowIso } from "../ids.js";
import type { Studio } from "../studio.js";
import { fromRow } from "./mapping.js";

export type ClipQuality = "preview" | "final";

export interface Clip {
  id: string;
  sceneVersionId: string;
  quality: ClipQuality;
  cacheKey: string;
  /** Relative to the project folder. */
  path: string;
  durationFrames: number;
  width: number;
  height: number;
  createdAt: string;
}

export function getClip(studio: Studio, sceneVersionId: string, quality: ClipQuality): Clip | undefined {
  return fromRow<Clip>(studio.db.get("SELECT * FROM clips WHERE scene_version_id = ? AND quality = ?", [sceneVersionId, quality]));
}

export function saveClip(studio: Studio, clip: Omit<Clip, "id" | "createdAt">): Clip {
  studio.db.run(
    `INSERT INTO clips (id, scene_version_id, quality, cache_key, path, duration_frames, width, height, created_at)
     VALUES (:id, :version, :quality, :key, :path, :frames, :w, :h, :stamp)
     ON CONFLICT (scene_version_id, quality) DO UPDATE SET cache_key = excluded.cache_key, path = excluded.path,
       duration_frames = excluded.duration_frames, width = excluded.width, height = excluded.height, created_at = excluded.created_at`,
    { id: newId("cl"), version: clip.sceneVersionId, quality: clip.quality, key: clip.cacheKey, path: clip.path, frames: clip.durationFrames, w: clip.width, h: clip.height, stamp: nowIso() },
  );
  return getClip(studio, clip.sceneVersionId, clip.quality)!;
}
