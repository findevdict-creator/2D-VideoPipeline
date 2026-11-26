import fs from "node:fs";
import path from "node:path";
import { newId, nowIso } from "../ids.js";
import type { Studio } from "../studio.js";
import { fromRow, fromRows } from "./mapping.js";
import { getProject, projectPaths } from "./projects.js";
import { addReview, hashText, setSceneStatus } from "./scenes.js";

/**
 * A shared asset is a React component, or a character: a component made with the library's
 * defineCharacter, which fixes its proportions, colours, poses and expressions.
 */
export const SHARED_KINDS = ["component", "character"] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];
export type SharedStatus = "planned" | "needs_review" | "approved";

export interface SharedAsset {
  id: string;
  projectId: string;
  /** PascalCase. Scenes import it as "@shared/<name>". */
  name: string;
  kind: SharedKind;
  /** What it is and how scenes should use it. */
  brief: string;
  currentVersion: number;
  approvedVersion: number | null;
  status: SharedStatus;
}

export interface SharedAssetVersion {
  id: string;
  sharedAssetId: string;
  version: number;
  /** Relative to the project folder: the frozen copy of this version. */
  path: string;
  sourceHash: string | null;
  /** Relative to the project folder: a still of the component's demo, when one could be rendered. */
  previewPath: string | null;
  notes: string;
  createdBy: string;
  createdAt: string;
}

export const SHARED_NAME = /^[A-Z][A-Za-z0-9]{1,39}$/;

export function listShared(studio: Studio, projectId: string): SharedAsset[] {
  return fromRows<SharedAsset>(studio.db.all("SELECT * FROM shared_assets WHERE project_id = ? ORDER BY name", [projectId]));
}

export function findShared(studio: Studio, projectId: string, name: string): SharedAsset | undefined {
  return fromRow<SharedAsset>(studio.db.get("SELECT * FROM shared_assets WHERE project_id = ? AND name = ?", [projectId, name]));
}

export function getShared(studio: Studio, projectId: string, name: string): SharedAsset {
  const found = findShared(studio, projectId, name);
  if (!found) throw new Error(`There is no shared asset called "${name}". Use shared_list to see what exists.`);
  return found;
}

export function sharedVersions(studio: Studio, sharedAssetId: string): SharedAssetVersion[] {
  return fromRows<SharedAssetVersion>(studio.db.all("SELECT * FROM shared_asset_versions WHERE shared_asset_id = ? ORDER BY version", [sharedAssetId]));
}

/** The file scenes import: always the newest version. */
export function sharedFile(studio: Studio, projectId: string, name: string): string {
  return path.join(projectPaths(studio, getProject(studio, projectId)).sharedComponents, `${name}.tsx`);
}

export function readShared(studio: Studio, projectId: string, name: string): string | undefined {
  const file = sharedFile(studio, projectId, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
}

/** Put shared assets on the plan: what the foundation step will build before any scene starts. */
export function planShared(studio: Studio, projectId: string, items: { name: string; brief: string; kind?: SharedKind }[]): SharedAsset[] {
  studio.db.tx(() => {
    for (const item of items) {
      if (!SHARED_NAME.test(item.name)) throw new Error(`"${item.name}" is not a usable name. Use PascalCase letters and digits, such as CameraBody.`);
      studio.db.run(
        `INSERT INTO shared_assets (id, project_id, name, kind, brief) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, name) DO UPDATE SET brief = excluded.brief, kind = excluded.kind`,
        [newId("sh"), projectId, item.name, item.kind ?? "component", item.brief],
      );
    }
  });
  studio.emit("shared.changed", { projectId });
  return listShared(studio, projectId);
}

/**
 * Save a new version of a shared component. Scenes built on an older version that have
 * already been rendered are marked stale, because their picture may have changed.
 */
export function saveShared(
  studio: Studio,
  projectId: string,
  input: { name: string; code: string; brief?: string; notes?: string; createdBy: string; kind?: SharedKind },
): { asset: SharedAsset; version: SharedAssetVersion; staleScenes: string[] } {
  if (!SHARED_NAME.test(input.name)) throw new Error(`"${input.name}" is not a usable name. Use PascalCase letters and digits, such as CameraBody.`);
  const project = getProject(studio, projectId);
  const p = projectPaths(studio, project);
  const sourceHash = hashText(input.code);
  const staleScenes: string[] = [];
  const versionId = newId("shv");
  studio.db.tx(() => {
    if (!findShared(studio, projectId, input.name)) {
      studio.db.run("INSERT INTO shared_assets (id, project_id, name, kind, brief) VALUES (?, ?, ?, ?, ?)", [newId("sh"), projectId, input.name, input.kind ?? "component", input.brief ?? ""]);
    }
    const asset = getShared(studio, projectId, input.name);
    const version = asset.currentVersion + 1;
    const frozen = path.join(p.shared, "versions", input.name, `v${version}.tsx`);
    fs.mkdirSync(path.dirname(frozen), { recursive: true });
    fs.writeFileSync(frozen, input.code);
    fs.mkdirSync(p.sharedComponents, { recursive: true });
    fs.writeFileSync(sharedFile(studio, projectId, input.name), input.code);
    studio.db.run(
      "INSERT INTO shared_asset_versions (id, shared_asset_id, version, path, source_hash, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [versionId, asset.id, version, p.rel(frozen), sourceHash, input.notes ?? "", input.createdBy, nowIso()],
    );
    studio.db.run("UPDATE shared_assets SET current_version = ?, status = 'needs_review', brief = COALESCE(?, brief) WHERE id = ?", [version, input.brief ?? null, asset.id]);
    if (version > 1) {
      const users = studio.db.all<{ id: string; status: string }>(
        `SELECT s.id, s.status FROM scenes s JOIN scene_versions v ON v.id = s.current_version_id
         WHERE s.project_id = ? AND EXISTS (SELECT 1 FROM json_each(v.spec_json, '$.uses') u WHERE json_extract(u.value, '$.name') = ?)`,
        [projectId, input.name],
      );
      for (const scene of users) {
        if (["rendered", "needs_review", "approved"].includes(scene.status)) {
          setSceneStatus(studio, scene.id, "stale", `${input.name} changed to version ${version}`);
          staleScenes.push(scene.id);
        }
      }
    }
  });
  studio.emit("shared.changed", { projectId, data: { name: input.name } });
  const asset = getShared(studio, projectId, input.name);
  return { asset, version: fromRow<SharedAssetVersion>(studio.db.get("SELECT * FROM shared_asset_versions WHERE id = ?", [versionId]))!, staleScenes };
}

/**
 * The poses and expressions a character's code declares, read from its source. Good
 * enough to tell people and agents what there is; the code itself is what counts.
 */
export function characterInfo(code: string | undefined): { poses: string[]; expressions: string[] } | null {
  if (!code || !/\bdefineCharacter\s*\(/.test(code)) return null;
  const list = (key: string) => {
    const found = new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(code)?.[1] ?? "";
    return [...found.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
  };
  return { poses: list("poses"), expressions: list("expressions") };
}

export function setSharedPreview(studio: Studio, versionId: string, previewPath: string) {
  studio.db.run("UPDATE shared_asset_versions SET preview_path = ? WHERE id = ?", [previewPath, versionId]);
}

/** Approve the newest version. Only people call this. */
export function approveShared(studio: Studio, projectId: string, name: string, notes = ""): SharedAsset {
  const asset = getShared(studio, projectId, name);
  if (!asset.currentVersion) throw new Error(`"${name}" has not been built yet.`);
  studio.db.tx(() => {
    studio.db.run("UPDATE shared_assets SET approved_version = current_version, status = 'approved' WHERE id = ?", [asset.id]);
    addReview(studio, { projectId, targetKind: "shared_asset", targetId: asset.id, targetVersion: asset.currentVersion, decision: "approve", notes });
  });
  studio.emit("shared.changed", { projectId, data: { name } });
  return getShared(studio, projectId, name);
}

export interface SharedRequest {
  id: string;
  projectId: string;
  sceneId: string;
  name: string;
  why: string;
  status: "open" | "done" | "declined";
  createdAt: string;
}

/** A scene asks for a shared asset it does not have. People decide whether to build it. */
export function requestShared(studio: Studio, projectId: string, sceneId: string, name: string, why: string): SharedRequest {
  const id = newId("shr");
  studio.db.run("INSERT INTO shared_asset_requests (id, project_id, scene_id, name, why, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, projectId, sceneId, name, why, nowIso()]);
  studio.emit("shared.changed", { projectId, data: { request: name } });
  return fromRow<SharedRequest>(studio.db.get("SELECT * FROM shared_asset_requests WHERE id = ?", [id]))!;
}

export function listSharedRequests(studio: Studio, projectId: string, status?: SharedRequest["status"]): SharedRequest[] {
  return fromRows<SharedRequest>(
    studio.db.all("SELECT * FROM shared_asset_requests WHERE project_id = ? AND (? IS NULL OR status = ?) ORDER BY created_at", [projectId, status ?? null, status ?? null]),
  );
}

export function closeSharedRequest(studio: Studio, id: string, status: "done" | "declined") {
  studio.db.run("UPDATE shared_asset_requests SET status = ? WHERE id = ?", [status, id]);
}
