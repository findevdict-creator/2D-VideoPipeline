import fs from "node:fs";
import path from "node:path";
import { newId, nowIso } from "../ids.js";
import type { Studio } from "../studio.js";
import { fromRow, fromRows } from "./mapping.js";
import { getProject, projectPaths } from "./projects.js";
import { addReview } from "./scenes.js";

export const DOCUMENT_KINDS = ["outline", "bible", "research", "chapter_script"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type DocumentStatus = "draft" | "needs_review" | "approved" | "superseded";

export interface StudioDocument {
  id: string;
  projectId: string;
  kind: DocumentKind;
  chapterId: string | null;
  version: number;
  /** Relative to the project folder. */
  path: string;
  status: DocumentStatus;
  createdBy: string;
  createdAt: string;
}

export function getDocument(studio: Studio, id: string): StudioDocument {
  const row = fromRow<StudioDocument>(studio.db.get("SELECT * FROM documents WHERE id = ?", [id]));
  if (!row) throw new Error(`No document with the id "${id}"`);
  return row;
}

export function listDocuments(studio: Studio, projectId: string): StudioDocument[] {
  return fromRows<StudioDocument>(studio.db.all("SELECT * FROM documents WHERE project_id = ? ORDER BY kind, chapter_id, version", [projectId]));
}

/** The newest version of a document, or the newest approved one. */
export function latestDocument(
  studio: Studio,
  projectId: string,
  kind: DocumentKind,
  opts: { chapterId?: string | null; approvedOnly?: boolean } = {},
): StudioDocument | undefined {
  return fromRow<StudioDocument>(
    studio.db.get(
      `SELECT * FROM documents WHERE project_id = :p AND kind = :k AND COALESCE(chapter_id, '') = :c
       AND (:approved = 0 OR status = 'approved') ORDER BY version DESC LIMIT 1`,
      { p: projectId, k: kind, c: opts.chapterId ?? "", approved: opts.approvedOnly ? 1 : 0 },
    ),
  );
}

export function readDocument(studio: Studio, doc: StudioDocument): string {
  const project = getProject(studio, doc.projectId);
  return fs.readFileSync(projectPaths(studio, project).abs(doc.path), "utf8");
}

/** Save a new version of a document. It waits for your review unless you wrote it yourself. */
export function saveDocument(
  studio: Studio,
  projectId: string,
  kind: DocumentKind,
  markdown: string,
  opts: { chapterId?: string | null; createdBy: string; status?: DocumentStatus },
): StudioDocument {
  const project = getProject(studio, projectId);
  const p = projectPaths(studio, project);
  const chapterId = opts.chapterId ?? null;
  const id = newId("doc");
  return studio.db.tx(() => {
    const version =
      (studio.db.get<{ n: number }>("SELECT COALESCE(MAX(version), 0) AS n FROM documents WHERE project_id = ? AND kind = ? AND COALESCE(chapter_id, '') = ?", [
        project.id,
        kind,
        chapterId ?? "",
      ])?.n ?? 0) + 1;
    const file = path.join(p.docs, chapterId ? `${kind}-${chapterId}` : kind, `v${version}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, markdown.trimEnd() + "\n");
    // Older versions still waiting for review are replaced by this one.
    studio.db.run(
      "UPDATE documents SET status = 'superseded' WHERE project_id = ? AND kind = ? AND COALESCE(chapter_id, '') = ? AND status IN ('draft', 'needs_review')",
      [project.id, kind, chapterId ?? ""],
    );
    studio.db.run("INSERT INTO documents (id, project_id, kind, chapter_id, version, path, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      project.id,
      kind,
      chapterId,
      version,
      p.rel(file),
      opts.status ?? "needs_review",
      opts.createdBy,
      nowIso(),
    ]);
    studio.emit("document.changed", { projectId: project.id, targetId: id, data: { kind } });
    return getDocument(studio, id);
  });
}

/** Approve a document version. Only people call this. */
export function approveDocument(studio: Studio, id: string, notes = ""): StudioDocument {
  const doc = getDocument(studio, id);
  studio.db.tx(() => {
    studio.db.run("UPDATE documents SET status = 'superseded' WHERE project_id = ? AND kind = ? AND COALESCE(chapter_id, '') = ? AND status = 'approved'", [
      doc.projectId,
      doc.kind,
      doc.chapterId ?? "",
    ]);
    studio.db.run("UPDATE documents SET status = 'approved' WHERE id = ?", [id]);
    addReview(studio, { projectId: doc.projectId, targetKind: "document", targetId: id, targetVersion: doc.version, decision: "approve", notes });
  });
  studio.emit("document.changed", { projectId: doc.projectId, targetId: id, data: { kind: doc.kind, status: "approved" } });
  return getDocument(studio, id);
}
