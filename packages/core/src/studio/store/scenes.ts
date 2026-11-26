import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newId, nowIso } from "../ids.js";
import { CODE_SCENE_TYPES, parseSpec, ScenePlanSchema, type ScenePlan, type ScenePlanInput, type SceneSpec, type SceneStatus, type SceneType } from "../model/scene.js";
import type { Studio } from "../studio.js";
import { getChapter, syncChapterStatus } from "./chapters.js";
import { fromRow, fromRows } from "./mapping.js";
import type { Theme } from "../model/project.js";
import { getProject, projectPaths, updateProject, type Project } from "./projects.js";

export interface Scene {
  id: string;
  projectId: string;
  chapterId: string;
  position: number;
  title: string;
  type: SceneType;
  plan: ScenePlan;
  status: SceneStatus;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  staleReason: string | null;
  updatedAt: string;
}

export interface Still {
  /** Path relative to the project folder. */
  file: string;
  frame: number;
}

export interface SceneVersion {
  id: string;
  sceneId: string;
  version: number;
  spec: SceneSpec;
  /** The scene's code file, relative to the project folder. Null for data-only scene types. */
  sourcePath: string | null;
  sourceHash: string | null;
  voiceTrackId: string | null;
  durationFrames: number | null;
  stills: Still[];
  checkProblems: string[];
  /** What the check found that does not stop a render but the person should know. */
  checkNotes: string[];
  summary: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const hashText = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);

export const sourceFileName = (type: SceneType) => (type === "manim" ? "scene.py" : CODE_SCENE_TYPES.includes(type) ? "scene.tsx" : null);

// ---------- Scenes ----------

export function getScene(studio: Studio, id: string): Scene {
  const row = fromRow<Scene>(studio.db.get("SELECT * FROM scenes WHERE id = ?", [id]));
  if (!row) throw new Error(`No scene with the id "${id}"`);
  return row;
}

export function listScenes(studio: Studio, projectId: string, chapterId?: string): Scene[] {
  return fromRows<Scene>(
    studio.db.all(
      `SELECT s.* FROM scenes s JOIN chapters c ON c.id = s.chapter_id
       WHERE s.project_id = :project AND (:chapter IS NULL OR s.chapter_id = :chapter)
       ORDER BY c.position, s.position`,
      { project: projectId, chapter: chapterId ?? null },
    ),
  );
}

/** "3.14": chapter 3, scene 14. What people see instead of ids. */
export function sceneLabel(studio: Studio, scene: Pick<Scene, "chapterId" | "position">): string {
  return `${getChapter(studio, scene.chapterId).position}.${scene.position}`;
}

/**
 * Find a scene the way people name it: by its id, or by its label, such as "2.3" for the
 * third scene of chapter two. A bare number means that scene of the first chapter.
 */
export function findScene(studio: Studio, projectId: string, ref: string): Scene {
  const scenes = listScenes(studio, projectId);
  const wanted = /^\d+$/.test(ref) ? `1.${ref}` : ref;
  const found = scenes.find((s) => s.id === ref) ?? scenes.find((s) => sceneLabel(studio, s) === wanted);
  if (!found) throw new Error(`There is no scene "${ref}" in this project. Use a label such as 1.2, or a scene id.`);
  return found;
}

export function addScene(studio: Studio, chapterId: string, plan: ScenePlanInput, position?: number): Scene {
  const chapter = getChapter(studio, chapterId);
  const data = ScenePlanSchema.parse(plan);
  const id = newId("sc");
  studio.db.tx(() => {
    const last = studio.db.get<{ n: number }>("SELECT COALESCE(MAX(position), 0) AS n FROM scenes WHERE chapter_id = ?", [chapterId])!.n;
    const at = Math.min(Math.max(1, position ?? last + 1), last + 1);
    studio.db.run("UPDATE scenes SET position = position + 1 WHERE chapter_id = ? AND position >= ?", [chapterId, at]);
    studio.db.run(
      "INSERT INTO scenes (id, project_id, chapter_id, position, title, type, plan_json, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)",
      [id, chapter.projectId, chapterId, at, data.title, data.type, JSON.stringify(data), nowIso()],
    );
  });
  studio.emit("scene.changed", { projectId: chapter.projectId, targetId: id });
  return getScene(studio, id);
}

/** A narration reduced to its words, for telling whether two scenes say the same thing. */
function spokenWords(narration: string): string[] {
  return narration.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/**
 * How alike two narrations are, from 0 to 1: the share of their distinct words they have in
 * common. Two scenes that say the same thing in nearly the same words score close to 1.
 */
export function narrationOverlap(a: string, b: string): number {
  const wa = new Set(spokenWords(a));
  const wb = new Set(spokenWords(b));
  if (!wa.size || !wb.size) return 0;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  return both / (wa.size + wb.size - both);
}

/** At or above this, two narrations are the same scene said twice. Short lines are left alone: they share words by chance. */
export const SAME_SCENE_OVERLAP = 0.8;
const MIN_WORDS_TO_COMPARE = 6;

export function sayTheSame(a: string, b: string): boolean {
  if (spokenWords(a).length < MIN_WORDS_TO_COMPARE || spokenWords(b).length < MIN_WORDS_TO_COMPARE) return false;
  return narrationOverlap(a, b) >= SAME_SCENE_OVERLAP;
}

/**
 * Set a chapter's scene list: it replaces the list that was there. A scene of the old list
 * that is also in the new one is kept with everything built for it. It is recognised by its
 * title, or by its narration when the title was reworded. Scenes of the old list that are not
 * in the new one are removed, built or not; `removed` names the built ones.
 */
export function proposeScenes(studio: Studio, chapterId: string, plans: ScenePlanInput[]): Scene[] & { removed?: { id: string; title: string }[] } {
  const chapter = getChapter(studio, chapterId);
  const parsed = plans.map((p) => ScenePlanSchema.parse(p));
  const removed: { id: string; title: string }[] = [];
  const folders: string[] = [];
  studio.db.tx(() => {
    const existing = listScenes(studio, chapter.projectId, chapterId);
    const kept = new Set<string>();
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    // Titles first for every scene, so a reworded title never takes the scene another plan names outright.
    const matches = parsed.map((plan) => {
      const match = existing.find((s) => !kept.has(s.id) && same(s.title, plan.title));
      if (match) kept.add(match.id);
      return match;
    });
    parsed.forEach((plan, i) => {
      if (matches[i]) return;
      const match = existing.find((s) => !kept.has(s.id) && sayTheSame(sceneNarration(studio, s), plan.narration));
      if (match) kept.add(match.id);
      matches[i] = match;
    });
    // Positions are unique only by convention, so park everything out of the way first.
    studio.db.run("UPDATE scenes SET position = position + 100000 WHERE chapter_id = ?", [chapterId]);
    parsed.forEach((plan, i) => {
      const match = matches[i];
      if (match?.currentVersionId) {
        studio.db.run("UPDATE scenes SET position = ? WHERE id = ?", [i + 1, match.id]);
      } else if (match) {
        studio.db.run("UPDATE scenes SET position = ?, title = ?, type = ?, plan_json = ?, updated_at = ? WHERE id = ?", [i + 1, plan.title, plan.type, JSON.stringify(plan), nowIso(), match.id]);
      } else {
        studio.db.run(
          "INSERT INTO scenes (id, project_id, chapter_id, position, title, type, plan_json, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)",
          [newId("sc"), chapter.projectId, chapterId, i + 1, plan.title, plan.type, JSON.stringify(plan), nowIso()],
        );
      }
    });
    for (const old of existing) {
      if (kept.has(old.id)) continue;
      // Left in place, a built scene the new list dropped would play after the scenes that replaced it.
      if (old.currentVersionId) {
        removed.push({ id: old.id, title: old.title });
        folders.push(projectPaths(studio, getProject(studio, chapter.projectId)).sceneDir(old.id));
      }
      studio.db.run("DELETE FROM scenes WHERE id = ?", [old.id]);
    }
  });
  for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
  studio.emit("scene.changed", { projectId: chapter.projectId });
  return Object.assign(listScenes(studio, chapter.projectId, chapterId), { removed });
}

/** Put a chapter's scenes in the order given. Scenes not named keep their order, after the named ones. */
export function reorderScenes(studio: Studio, chapterId: string, orderedIds: string[]) {
  const chapter = getChapter(studio, chapterId);
  studio.db.tx(() => {
    const ids = listScenes(studio, chapter.projectId, chapterId).map((s) => s.id);
    const order = [...orderedIds.filter((id) => ids.includes(id)), ...ids.filter((id) => !orderedIds.includes(id))];
    order.forEach((id, i) => studio.db.run("UPDATE scenes SET position = ? WHERE id = ?", [i + 1, id]));
  });
  studio.emit("scene.changed", { projectId: chapter.projectId });
}

/**
 * Move a scene one place earlier or later in the video. At the edge of its chapter it crosses
 * into the neighbouring chapter: earlier puts it last in the chapter before, later puts it
 * first in the chapter after. Nothing is built or rendered again, because a scene's clip and
 * narration are its own; videos already joined are out of date until they are joined again.
 */
export function moveScene(studio: Studio, sceneId: string, direction: "earlier" | "later"): Scene {
  const scene = getScene(studio, sceneId);
  if (scene.status === "in_production") throw new Error("Claude is working on this scene right now. Wait for that run to finish, or stop it, before moving the scene.");
  const siblings = listScenes(studio, scene.projectId, scene.chapterId);
  const at = siblings.findIndex((s) => s.id === sceneId);
  const swapWith = siblings[at + (direction === "earlier" ? -1 : 1)];
  if (swapWith) {
    const order = siblings.map((s) => s.id);
    [order[at], order[order.indexOf(swapWith.id)]] = [swapWith.id, sceneId];
    reorderScenes(studio, scene.chapterId, order);
  } else {
    const chapters = studio.db.all<{ id: string }>("SELECT id FROM chapters WHERE project_id = ? ORDER BY position", [scene.projectId]).map((c) => c.id);
    const next = chapters[chapters.indexOf(scene.chapterId) + (direction === "earlier" ? -1 : 1)];
    if (!next) throw new Error(direction === "earlier" ? "This is already the first scene of the video." : "This is already the last scene of the video.");
    studio.db.tx(() => {
      studio.db.run("UPDATE scenes SET position = position - 1 WHERE chapter_id = ? AND position > ?", [scene.chapterId, scene.position]);
      if (direction === "earlier") {
        const last = studio.db.get<{ n: number }>("SELECT COALESCE(MAX(position), 0) AS n FROM scenes WHERE chapter_id = ?", [next])!.n;
        studio.db.run("UPDATE scenes SET chapter_id = ?, position = ?, updated_at = ? WHERE id = ?", [next, last + 1, nowIso(), sceneId]);
      } else {
        studio.db.run("UPDATE scenes SET position = position + 1 WHERE chapter_id = ?", [next]);
        studio.db.run("UPDATE scenes SET chapter_id = ?, position = 1, updated_at = ? WHERE id = ?", [next, nowIso(), sceneId]);
      }
    });
    syncChapterStatus(studio, scene.chapterId);
    syncChapterStatus(studio, next);
  }
  studio.emit("scene.changed", { projectId: scene.projectId, targetId: sceneId });
  return getScene(studio, sceneId);
}

/**
 * Remove a scene from the video, with every version, clip and recording made for it. The
 * scenes after it move up. This cannot be undone.
 */
export function deleteScene(studio: Studio, sceneId: string) {
  const scene = getScene(studio, sceneId);
  if (scene.status === "in_production") throw new Error("Claude is working on this scene right now. Wait for that run to finish, or stop it, before deleting the scene.");
  if (listScenes(studio, scene.projectId).length === 1) throw new Error("This is the only scene of the video. A video needs at least one scene.");
  const folder = projectPaths(studio, getProject(studio, scene.projectId)).sceneDir(sceneId);
  studio.db.tx(() => {
    studio.db.run("DELETE FROM scenes WHERE id = ?", [sceneId]);
    studio.db.run("UPDATE scenes SET position = position - 1 WHERE chapter_id = ? AND position > ?", [scene.chapterId, scene.position]);
  });
  fs.rmSync(folder, { recursive: true, force: true });
  studio.emit("scene.changed", { projectId: scene.projectId, targetId: sceneId });
  syncChapterStatus(studio, scene.chapterId);
}

/** Set a scene's status. For "stale" and "failed", `staleReason` says why the scene needs attention. */
export function setSceneStatus(studio: Studio, sceneId: string, status: SceneStatus, staleReason: string | null = null) {
  const scene = getScene(studio, sceneId);
  studio.db.run("UPDATE scenes SET status = ?, stale_reason = ?, updated_at = ? WHERE id = ?", [status, status === "stale" || status === "failed" ? staleReason : null, nowIso(), sceneId]);
  studio.emit("scene.changed", { projectId: scene.projectId, targetId: sceneId, data: { status } });
  syncChapterStatus(studio, scene.chapterId);
}

/**
 * Change the look every scene shares. Scenes that are already rendered were drawn with the
 * old one, so they are marked out of date; rendering them again brings them into line.
 * Returns the scenes marked.
 */
export function setTheme(studio: Studio, projectId: string, theme: Theme): string[] {
  const before = getProject(studio, projectId).settings.theme;
  const after = updateProject(studio, projectId, { settings: { theme } }).settings.theme;
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const why = before.look !== after.look ? `The look changed to ${after.look === "hand-drawn" ? "hand-drawn" : "clean"}` : "The video's colours or font changed";
  const drawn = listScenes(studio, projectId).filter((s) => ["rendered", "needs_review", "approved"].includes(s.status));
  for (const scene of drawn) setSceneStatus(studio, scene.id, "stale", why);
  return drawn.map((s) => s.id);
}

/** Change a planned scene's idea, narration or type before any work has gone into it. */
export function updatePlan(studio: Studio, sceneId: string, patch: Partial<ScenePlanInput>): Scene {
  const scene = getScene(studio, sceneId);
  // A field left out of the patch keeps its value.
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const plan = ScenePlanSchema.parse({ ...scene.plan, title: scene.title, type: scene.type, ...given });
  studio.db.run("UPDATE scenes SET title = ?, type = ?, plan_json = ?, updated_at = ? WHERE id = ?", [plan.title, plan.type, JSON.stringify(plan), nowIso(), sceneId]);
  studio.emit("scene.changed", { projectId: scene.projectId, targetId: sceneId });
  return getScene(studio, sceneId);
}

// ---------- Versions ----------

export function getVersion(studio: Studio, versionId: string): SceneVersion {
  const row = fromRow<SceneVersion>(studio.db.get("SELECT * FROM scene_versions WHERE id = ?", [versionId]));
  if (!row) throw new Error(`No scene version with the id "${versionId}"`);
  return row;
}

export function listVersions(studio: Studio, sceneId: string): SceneVersion[] {
  return fromRows<SceneVersion>(studio.db.all("SELECT * FROM scene_versions WHERE scene_id = ? ORDER BY version", [sceneId]));
}

export function currentVersion(studio: Studio, scene: Scene): SceneVersion | undefined {
  return scene.currentVersionId ? getVersion(studio, scene.currentVersionId) : undefined;
}

export function versionByNumber(studio: Studio, sceneId: string, version: number): SceneVersion {
  const row = fromRow<SceneVersion>(studio.db.get("SELECT * FROM scene_versions WHERE scene_id = ? AND version = ?", [sceneId, version]));
  if (!row) throw new Error(`Scene ${sceneId} has no version ${version}`);
  return row;
}

/** What the narrator says in this scene right now: the current spec's narration, or the plan's. */
export function sceneNarration(studio: Studio, scene: Scene): string {
  return currentVersion(studio, scene)?.spec.narration ?? scene.plan.narration;
}

/** Full paths of a version's files. */
export function versionPaths(studio: Studio, project: Project, v: Pick<SceneVersion, "sceneId" | "version" | "sourcePath">) {
  const p = projectPaths(studio, project);
  const dir = p.versionDir(v.sceneId, v.version);
  return {
    dir,
    spec: path.join(dir, "spec.json"),
    source: v.sourcePath ? p.abs(v.sourcePath) : null,
    stills: path.join(dir, "stills"),
    clip: (quality: string) => path.join(dir, `clip-${quality}.mp4`),
    /** The clip with its narration, for watching. */
    review: (quality: string) => path.join(dir, `review-${quality}.mp4`),
    log: path.join(dir, "render.log"),
  };
}

/**
 * Start a new version of a scene, carrying the previous version's spec and code forward.
 * Every round of changes gets its own version, so you can compare and roll back.
 */
export function beginVersion(studio: Studio, sceneId: string, createdBy: string, spec?: SceneSpec): SceneVersion {
  const scene = getScene(studio, sceneId);
  const project = getProject(studio, scene.projectId);
  const p = projectPaths(studio, project);
  const previous = currentVersion(studio, scene);
  const nextSpec = spec ?? previous?.spec;
  if (!nextSpec) throw new Error(`Scene ${sceneId} has no spec yet. Save a spec first.`);

  const id = newId("sv");
  const version = (studio.db.get<{ n: number }>("SELECT COALESCE(MAX(version), 0) AS n FROM scene_versions WHERE scene_id = ?", [sceneId])?.n ?? 0) + 1;
  const dir = p.versionDir(sceneId, version);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = sourceFileName(nextSpec.type);
  const sourcePath = fileName ? p.rel(path.join(dir, fileName)) : null;
  let sourceHash: string | null = null;
  // Code is carried forward only while the scene keeps its type.
  if (sourcePath && previous?.sourcePath && previous.spec.type === nextSpec.type && fs.existsSync(p.abs(previous.sourcePath))) {
    fs.copyFileSync(p.abs(previous.sourcePath), p.abs(sourcePath));
    fs.chmodSync(p.abs(sourcePath), 0o644);
    sourceHash = previous.sourceHash;
  }
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(nextSpec, null, 2) + "\n");
  const stamp = nowIso();
  studio.db.tx(() => {
    studio.db.run(
      `INSERT INTO scene_versions (id, scene_id, version, spec_json, source_path, source_hash, voice_track_id, created_by, created_at, updated_at)
       VALUES (:id, :scene, :version, :spec, :sourcePath, :sourceHash, :voice, :by, :stamp, :stamp)`,
      { id, scene: sceneId, version, spec: JSON.stringify(nextSpec), sourcePath, sourceHash, voice: previous?.voiceTrackId ?? null, by: createdBy, stamp },
    );
    studio.db.run("UPDATE scenes SET current_version_id = ?, title = ?, type = ?, updated_at = ? WHERE id = ?", [id, nextSpec.title, nextSpec.type, stamp, sceneId]);
  });
  studio.emit("scene.changed", { projectId: scene.projectId, targetId: sceneId, data: { version } });
  return getVersion(studio, id);
}

export type SaveSpecResult = { ok: true; version: SceneVersion } | { ok: false; problems: string[] };

/**
 * Save a scene's spec after validating it. The first save creates version 1. An approved
 * version is frozen, so saving over it starts a new version instead.
 */
export function saveSpec(studio: Studio, sceneId: string, raw: unknown, createdBy: string, extraChecks?: (spec: SceneSpec) => string[]): SaveSpecResult {
  const parsed = parseSpec(raw);
  if (!parsed.ok) return parsed;
  const more = extraChecks?.(parsed.spec) ?? [];
  if (more.length) return { ok: false, problems: more };

  const scene = getScene(studio, sceneId);
  const current = currentVersion(studio, scene);
  if (!current || current.id === scene.approvedVersionId) {
    const version = beginVersion(studio, sceneId, createdBy, parsed.spec);
    setSceneStatus(studio, sceneId, "spec_ready");
    return { ok: true, version };
  }

  const project = getProject(studio, scene.projectId);
  const p = projectPaths(studio, project);
  const fileName = sourceFileName(parsed.spec.type);
  const dir = p.versionDir(sceneId, current.version);
  const typeChanged = current.spec.type !== parsed.spec.type;
  const sourcePath = fileName ? p.rel(path.join(dir, fileName)) : null;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(parsed.spec, null, 2) + "\n");
  const stamp = nowIso();
  studio.db.tx(() => {
    studio.db.run(
      "UPDATE scene_versions SET spec_json = ?, source_path = ?, source_hash = CASE WHEN ? THEN NULL ELSE source_hash END, updated_at = ? WHERE id = ?",
      [JSON.stringify(parsed.spec), sourcePath, typeChanged ? 1 : 0, stamp, current.id],
    );
    studio.db.run("UPDATE scenes SET title = ?, type = ?, updated_at = ? WHERE id = ?", [parsed.spec.title, parsed.spec.type, stamp, sceneId]);
  });
  if (scene.status === "planned") setSceneStatus(studio, sceneId, "spec_ready");
  else studio.emit("scene.changed", { projectId: scene.projectId, targetId: sceneId });
  return { ok: true, version: getVersion(studio, current.id) };
}

export function updateVersion(
  studio: Studio,
  versionId: string,
  patch: Partial<Pick<SceneVersion, "sourceHash" | "voiceTrackId" | "durationFrames" | "stills" | "checkProblems" | "checkNotes" | "summary">>,
): SceneVersion {
  const v = getVersion(studio, versionId);
  const next = { ...v, ...patch };
  studio.db.run(
    `UPDATE scene_versions SET source_hash = :sourceHash, voice_track_id = :voice, duration_frames = :frames,
       stills_json = :stills, check_problems_json = :problems, check_notes_json = :notes, summary = :summary, updated_at = :stamp WHERE id = :id`,
    {
      id: versionId,
      sourceHash: next.sourceHash,
      voice: next.voiceTrackId,
      frames: next.durationFrames,
      stills: JSON.stringify(next.stills),
      problems: JSON.stringify(next.checkProblems),
      notes: JSON.stringify(next.checkNotes),
      summary: next.summary,
      stamp: nowIso(),
    },
  );
  return getVersion(studio, versionId);
}

/** Read a version's code file and record its hash. Returns the code, or undefined when there is none yet. */
export function readSource(studio: Studio, project: Project, v: SceneVersion): string | undefined {
  const file = versionPaths(studio, project, v).source;
  if (!file || !fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, "utf8");
}

// ---------- Review: only people call these ----------

export interface Review {
  id: string;
  projectId: string;
  targetKind: "scene" | "document" | "shared_asset" | "render";
  targetId: string;
  targetVersion: number | null;
  decision: "approve" | "revise";
  notes: string;
  createdAt: string;
}

export function addReview(studio: Studio, review: Omit<Review, "id" | "createdAt">): Review {
  const id = newId("rv");
  studio.db.run(
    "INSERT INTO reviews (id, project_id, target_kind, target_id, target_version, decision, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, review.projectId, review.targetKind, review.targetId, review.targetVersion, review.decision, review.notes, nowIso()],
  );
  return fromRow<Review>(studio.db.get("SELECT * FROM reviews WHERE id = ?", [id]))!;
}

export function listReviews(studio: Studio, targetKind: Review["targetKind"], targetId: string): Review[] {
  return fromRows<Review>(studio.db.all("SELECT * FROM reviews WHERE target_kind = ? AND target_id = ? ORDER BY created_at", [targetKind, targetId]));
}

/** Approve the scene's current version. There is no agent-facing way to reach this. */
export function approveScene(studio: Studio, sceneId: string, notes = ""): Scene {
  const scene = getScene(studio, sceneId);
  const version = currentVersion(studio, scene);
  if (!version) throw new Error("This scene has nothing to approve yet.");
  const hasClip = studio.db.get("SELECT 1 FROM clips WHERE scene_version_id = ? LIMIT 1", [version.id]);
  if (!hasClip) throw new Error("Render the scene before approving it, so you approve what you have seen.");
  studio.db.tx(() => {
    addReview(studio, { projectId: scene.projectId, targetKind: "scene", targetId: sceneId, targetVersion: version.version, decision: "approve", notes });
    studio.db.run("UPDATE scenes SET approved_version_id = ?, status = 'approved', stale_reason = NULL, updated_at = ? WHERE id = ?", [version.id, nowIso(), sceneId]);
  });
  // An approved version is frozen: later runs work on a new version and cannot edit this one's code.
  const source = versionPaths(studio, getProject(studio, scene.projectId), version).source;
  if (source && fs.existsSync(source)) fs.chmodSync(source, 0o444);
  studio.emit("scene.changed", { projectId: scene.projectId, targetId: sceneId, data: { status: "approved" } });
  syncChapterStatus(studio, scene.chapterId);
  return getScene(studio, sceneId);
}

/** Record your notes and open a new version for the changes. */
export function reviseScene(studio: Studio, sceneId: string, notes: string): SceneVersion {
  const scene = getScene(studio, sceneId);
  const version = currentVersion(studio, scene);
  if (!version) throw new Error("This scene has no version to revise yet.");
  return studio.db.tx(() => {
    addReview(studio, { projectId: scene.projectId, targetKind: "scene", targetId: sceneId, targetVersion: version.version, decision: "revise", notes });
    const next = beginVersion(studio, sceneId, "human");
    setSceneStatus(studio, sceneId, "spec_ready");
    return next;
  });
}

/** Make an earlier version the current one again. Its clip is still on disk, so nothing re-renders. */
export function rollbackScene(studio: Studio, sceneId: string, version: number): Scene {
  const scene = getScene(studio, sceneId);
  if (scene.status === "in_production") throw new Error("Claude is working on this scene right now. Wait for that run to finish, or stop it, before going back to an earlier version.");
  const target = versionByNumber(studio, sceneId, version);
  const hasClip = studio.db.get("SELECT 1 FROM clips WHERE scene_version_id = ? LIMIT 1", [target.id]);
  const wasApproved = studio.db.get("SELECT 1 FROM reviews WHERE target_kind = 'scene' AND target_id = ? AND target_version = ? AND decision = 'approve' LIMIT 1", [sceneId, version]);
  const status: SceneStatus = wasApproved && hasClip ? "approved" : hasClip ? "rendered" : "spec_ready";
  studio.db.run("UPDATE scenes SET current_version_id = ?, approved_version_id = ?, title = ?, type = ?, status = ?, stale_reason = NULL, updated_at = ? WHERE id = ?", [
    target.id,
    status === "approved" ? target.id : scene.approvedVersionId,
    target.spec.title,
    target.spec.type,
    status,
    nowIso(),
    sceneId,
  ]);
  studio.emit("scene.changed", { projectId: scene.projectId, targetId: sceneId, data: { status } });
  syncChapterStatus(studio, scene.chapterId);
  return getScene(studio, sceneId);
}
