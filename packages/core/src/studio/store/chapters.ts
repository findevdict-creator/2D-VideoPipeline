import { newId } from "../ids.js";
import type { Studio } from "../studio.js";
import { fromRow, fromRows } from "./mapping.js";

export type ChapterStatus = "planned" | "scripting" | "script_review" | "in_production" | "done";

export interface Chapter {
  id: string;
  projectId: string;
  position: number;
  title: string;
  goal: string;
  targetDurationSec: number;
  status: ChapterStatus;
}

export function listChapters(studio: Studio, projectId: string): Chapter[] {
  return fromRows<Chapter>(studio.db.all("SELECT * FROM chapters WHERE project_id = ? ORDER BY position", [projectId]));
}

export function getChapter(studio: Studio, id: string): Chapter {
  const row = fromRow<Chapter>(studio.db.get("SELECT * FROM chapters WHERE id = ?", [id]));
  if (!row) throw new Error(`No chapter with the id "${id}"`);
  return row;
}

export function addChapter(
  studio: Studio,
  projectId: string,
  input: { title: string; goal?: string; targetDurationSec?: number },
): Chapter {
  const id = newId("ch");
  studio.db.tx(() => {
    const next = studio.db.get<{ n: number }>("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM chapters WHERE project_id = ?", [projectId])!.n;
    studio.db.run("INSERT INTO chapters (id, project_id, position, title, goal, target_duration_sec) VALUES (?, ?, ?, ?, ?, ?)", [
      id,
      projectId,
      next,
      input.title,
      input.goal ?? "",
      Math.round(input.targetDurationSec ?? 0),
    ]);
  });
  studio.emit("chapter.changed", { projectId, targetId: id });
  return getChapter(studio, id);
}

/**
 * Replace the chapter plan. Chapters that already have scenes are kept and matched by title,
 * so re-planning the outline never throws away finished work.
 */
export function proposeChapters(
  studio: Studio,
  projectId: string,
  chapters: { title: string; goal?: string; targetDurationSec?: number }[],
): Chapter[] {
  studio.db.tx(() => {
    const existing = listChapters(studio, projectId);
    const keep = new Set<string>();
    chapters.forEach((c, i) => {
      const match = existing.find((e) => !keep.has(e.id) && e.title.trim().toLowerCase() === c.title.trim().toLowerCase());
      if (match) {
        keep.add(match.id);
        studio.db.run("UPDATE chapters SET position = ?, goal = ?, target_duration_sec = ? WHERE id = ?", [
          i + 1,
          c.goal ?? match.goal,
          Math.round(c.targetDurationSec ?? match.targetDurationSec),
          match.id,
        ]);
      } else {
        const id = newId("ch");
        keep.add(id);
        studio.db.run("INSERT INTO chapters (id, project_id, position, title, goal, target_duration_sec) VALUES (?, ?, ?, ?, ?, ?)", [
          id,
          projectId,
          i + 1,
          c.title,
          c.goal ?? "",
          Math.round(c.targetDurationSec ?? 0),
        ]);
      }
    });
    let tail = chapters.length;
    for (const old of existing) {
      if (keep.has(old.id)) continue;
      const hasScenes = studio.db.get("SELECT 1 FROM scenes WHERE chapter_id = ? LIMIT 1", [old.id]);
      if (hasScenes) studio.db.run("UPDATE chapters SET position = ? WHERE id = ?", [++tail, old.id]);
      else studio.db.run("DELETE FROM chapters WHERE id = ?", [old.id]);
    }
  });
  studio.emit("chapter.changed", { projectId });
  return listChapters(studio, projectId);
}

export function updateChapter(studio: Studio, id: string, patch: Partial<Pick<Chapter, "title" | "goal" | "targetDurationSec" | "status">>): Chapter {
  const c = getChapter(studio, id);
  studio.db.run("UPDATE chapters SET title = ?, goal = ?, target_duration_sec = ?, status = ? WHERE id = ?", [
    patch.title ?? c.title,
    patch.goal ?? c.goal,
    Math.round(patch.targetDurationSec ?? c.targetDurationSec),
    patch.status ?? c.status,
    id,
  ]);
  studio.emit("chapter.changed", { projectId: c.projectId, targetId: id });
  return getChapter(studio, id);
}
