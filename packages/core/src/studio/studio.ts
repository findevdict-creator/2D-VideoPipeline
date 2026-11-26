import os from "node:os";
import path from "node:path";
import { loadConfig, type PipelineConfig } from "../config.js";
import { Db } from "./db/connection.js";
import { nowIso } from "./ids.js";

export interface StudioEvent {
  id: number;
  projectId: string | null;
  kind: string;
  targetId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

/**
 * One workspace: a folder with studio.db and a projects/ folder. Everything the
 * CLI, the MCP server and the GUI server do goes through a Studio.
 */
export class Studio {
  readonly db: Db;
  readonly workspaceDir: string;

  constructor(
    readonly config: PipelineConfig,
    workspaceDir?: string,
  ) {
    this.workspaceDir = resolveWorkspace(workspaceDir ?? config.studio.workspace, config.rootDir);
    this.db = new Db(path.join(this.workspaceDir, "studio.db"));
  }

  static open(overrides: Parameters<typeof loadConfig>[0] = {}, workspaceDir?: string): Studio {
    return new Studio(loadConfig(overrides), workspaceDir);
  }

  projectDir(slug: string) {
    return path.join(this.workspaceDir, "projects", slug);
  }

  /**
   * Record that something changed. The GUI server reads these rows to push live
   * updates, which is how a change made by a Claude run's MCP process reaches the page.
   */
  emit(kind: string, event: { projectId?: string | null; targetId?: string | null; data?: Record<string, unknown> } = {}) {
    this.db.run("INSERT INTO events (project_id, kind, target_id, data_json, created_at) VALUES (?, ?, ?, ?, ?)", [
      event.projectId ?? null,
      kind,
      event.targetId ?? null,
      JSON.stringify(event.data ?? {}),
      nowIso(),
    ]);
  }

  eventsAfter(id: number, limit = 500): StudioEvent[] {
    return this.db
      .all<{ id: number; project_id: string | null; kind: string; target_id: string | null; data_json: string; created_at: string }>(
        "SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?",
        [id, limit],
      )
      .map((r) => ({ id: r.id, projectId: r.project_id, kind: r.kind, targetId: r.target_id, data: JSON.parse(r.data_json), createdAt: r.created_at }));
  }

  lastEventId(): number {
    return this.db.get<{ id: number | null }>("SELECT MAX(id) AS id FROM events")?.id ?? 0;
  }

  close() {
    this.db.close();
  }
}

export function resolveWorkspace(setting: string, rootDir: string): string {
  if (setting === "~" || setting.startsWith("~/") || setting.startsWith("~\\")) {
    return path.join(os.homedir(), setting.slice(2));
  }
  return path.resolve(rootDir, setting);
}
