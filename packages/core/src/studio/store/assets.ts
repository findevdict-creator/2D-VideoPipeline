import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newId, nowIso } from "../ids.js";
import { guessAsset, type AssetKind } from "../model/asset.js";
import { probe } from "../media/ffmpeg.js";
import { inspectModel, type ModelInfo } from "../assets/gltf.js";
import { imageSize } from "../media/imageSize.js";
import type { Studio } from "../studio.js";
import { fromRow, fromRows } from "./mapping.js";
import { getProject, projectPaths } from "./projects.js";

export interface Asset {
  id: string;
  projectId: string;
  kind: AssetKind;
  /** Relative to the project folder. */
  path: string;
  sha256: string;
  originalName: string;
  mime: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  meta: Record<string, unknown>;
  label: string;
  sourceNote: string;
  createdAt: string;
}

export function getAsset(studio: Studio, id: string): Asset {
  const row = fromRow<Asset>(studio.db.get("SELECT * FROM assets WHERE id = ?", [id]));
  if (!row) throw new Error(`No asset with the id "${id}"`);
  return row;
}

export function findAsset(studio: Studio, projectId: string, id: string): Asset | undefined {
  return fromRow<Asset>(studio.db.get("SELECT * FROM assets WHERE id = ? AND project_id = ?", [id, projectId]));
}

export function listAssets(studio: Studio, projectId: string, kind?: AssetKind): Asset[] {
  return fromRows<Asset>(
    studio.db.all("SELECT * FROM assets WHERE project_id = :p AND (:k IS NULL OR kind = :k) ORDER BY created_at", { p: projectId, k: kind ?? null }),
  );
}

export interface ImportAssetOptions {
  /** The name to keep for display, when the file on disk is a temporary upload. */
  originalName?: string;
  label?: string;
  kind?: AssetKind;
  sourceNote?: string;
}

/**
 * Copy a file into the project's asset store. Files are stored once by content hash,
 * so importing the same file twice returns the same asset.
 */
export async function importAsset(studio: Studio, projectId: string, file: string, opts: ImportAssetOptions = {}): Promise<Asset> {
  const project = getProject(studio, projectId);
  const p = projectPaths(studio, project);
  const name = opts.originalName ?? path.basename(file);
  const sha256 = await hashFile(file);
  const existing = fromRow<Asset>(studio.db.get("SELECT * FROM assets WHERE project_id = ? AND sha256 = ?", [project.id, sha256]));
  if (existing) return existing;

  const guess = guessAsset(name);
  const ext = path.extname(name).toLowerCase();
  // A model is read before it is stored: one that cannot load is refused with the reason, not kept.
  let model: ModelInfo | undefined;
  if ((opts.kind ?? guess.kind) === "model") {
    model = inspectModel(file, { triangleBudget: studio.config.studio.modelTriangleBudget });
    if (model.errors.length) throw new Error(`"${name}" cannot be used as it is:\n  - ${model.errors.join("\n  - ")}`);
  }
  const target = path.join(p.assets, `${sha256.slice(0, 24)}${ext}`);
  fs.mkdirSync(p.assets, { recursive: true });
  fs.copyFileSync(file, target);

  let kind = opts.kind ?? guess.kind;
  let info: Awaited<ReturnType<typeof probe>> | undefined;
  if (["image", "video", "audio_sfx", "audio_music"].includes(kind) && ext !== ".svg") {
    try {
      info = await probe(target);
    } catch {
      // An unreadable file is still stored; rendering will report it if it is used.
    }
  }
  if (kind === "image" && !info?.width) {
    const size = imageSize(target);
    if (size) info = { hasVideo: true, hasAudio: false, ...size };
  }
  // Long audio is more likely music than a sound effect.
  if (!opts.kind && kind === "audio_sfx" && (info?.durationSec ?? 0) > 30) kind = "audio_music";

  const id = newId("as");
  studio.db.run(
    `INSERT INTO assets (id, project_id, kind, path, sha256, original_name, mime, width, height, duration_sec, meta_json, label, source_note, created_at)
     VALUES (:id, :project, :kind, :path, :sha, :name, :mime, :w, :h, :dur, :meta, :label, :note, :stamp)`,
    {
      id,
      project: project.id,
      kind,
      path: p.rel(target),
      sha: sha256,
      name,
      mime: guess.mime,
      w: info?.width ?? null,
      h: info?.height ?? null,
      dur: kind === "image" ? null : (info?.durationSec ?? null),
      meta: JSON.stringify(model ? { model } : info ? { fps: info.fps, hasAudio: info.hasAudio, codec: info.codec } : {}),
      label: opts.label ?? name.replace(/\.[^.]+$/, ""),
      note: opts.sourceNote ?? "",
      stamp: nowIso(),
    },
  );
  studio.emit("asset.changed", { projectId: project.id, targetId: id });
  return getAsset(studio, id);
}

export function updateAsset(studio: Studio, id: string, patch: Partial<Pick<Asset, "label" | "kind" | "sourceNote" | "meta">>): Asset {
  const a = getAsset(studio, id);
  studio.db.run("UPDATE assets SET label = ?, kind = ?, source_note = ?, meta_json = ? WHERE id = ?", [
    patch.label ?? a.label,
    patch.kind ?? a.kind,
    patch.sourceNote ?? a.sourceNote,
    JSON.stringify(patch.meta ? { ...a.meta, ...patch.meta } : a.meta),
    id,
  ]);
  studio.emit("asset.changed", { projectId: a.projectId, targetId: id });
  return getAsset(studio, id);
}

/** Scenes whose current spec uses this asset. */
export function assetUsage(studio: Studio, assetId: string): string[] {
  return studio.db
    .all<{ id: string }>(
      `SELECT s.id FROM scenes s JOIN scene_versions v ON v.id = s.current_version_id WHERE v.spec_json LIKE ?`,
      [`%"${assetId}"%`],
    )
    .map((r) => r.id);
}

export function deleteAsset(studio: Studio, id: string) {
  const a = getAsset(studio, id);
  const used = assetUsage(studio, id);
  if (used.length) throw new Error(`This asset is used by ${used.length} scene(s). Remove it from them first.`);
  const project = getProject(studio, a.projectId);
  studio.db.run("DELETE FROM assets WHERE id = ?", [id]);
  fs.rmSync(projectPaths(studio, project).abs(a.path), { force: true });
  studio.emit("asset.changed", { projectId: a.projectId, targetId: id });
}

// ---------- References for the whole video ----------

export interface ProjectReference {
  assetId: string;
  role: "style" | "layout" | "motion";
  note: string;
}

export function listProjectReferences(studio: Studio, projectId: string): ProjectReference[] {
  return fromRows<ProjectReference>(studio.db.all("SELECT asset_id, role, note FROM project_references WHERE project_id = ?", [projectId]));
}

export function setProjectReference(studio: Studio, projectId: string, ref: ProjectReference | { assetId: string; role: null }) {
  if (ref.role === null) {
    studio.db.run("DELETE FROM project_references WHERE project_id = ? AND asset_id = ?", [projectId, ref.assetId]);
  } else {
    studio.db.run(
      "INSERT INTO project_references (project_id, asset_id, role, note) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, asset_id) DO UPDATE SET role = excluded.role, note = excluded.note",
      [projectId, ref.assetId, ref.role, ref.note],
    );
  }
  studio.emit("asset.changed", { projectId });
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
