import fs from "node:fs";
import path from "node:path";
import { newId, nowIso } from "../ids.js";
import type { Studio } from "../studio.js";
import { fromRow, fromRows } from "./mapping.js";
import { getProject, projectPaths } from "./projects.js";

/** What a run is allowed to work on. The MCP server refuses writes outside it. */
export const RUN_KINDS = ["outline", "bible", "foundation", "chapter", "scene", "thumbnail"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface AgentRun {
  id: string;
  projectId: string;
  /** The kind of run: outline, bible, foundation, chapter, scene or thumbnail. */
  targetKind: RunKind;
  /** The chapter or scene the run works on. Empty for runs on the whole project. */
  targetId: string | null;
  agent: string;
  /** "build", or "revise" when it answers your review notes. */
  task: string;
  claudeSessionId: string | null;
  status: RunStatus;
  /** `continued`: this run picks up a run that the studio closing stopped part-way. */
  payload: { notes?: string; resumeFrom?: string; continued?: boolean };
  /** Relative to the project folder. One JSON object per line. */
  logPath: string | null;
  resultText: string | null;
  costUsd: number | null;
  durationMs: number | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function getRun(studio: Studio, id: string): AgentRun {
  const row = fromRow<AgentRun>(studio.db.get("SELECT * FROM agent_runs WHERE id = ?", [id]));
  if (!row) throw new Error(`No run with the id "${id}"`);
  return row;
}

export function listRuns(studio: Studio, projectId: string, opts: { targetId?: string; active?: boolean; limit?: number } = {}): AgentRun[] {
  return fromRows<AgentRun>(
    studio.db.all(
      `SELECT * FROM agent_runs WHERE project_id = :p AND (:t IS NULL OR target_id = :t)
       AND (:active = 0 OR status IN ('queued', 'running')) ORDER BY queued_at DESC, id DESC LIMIT :limit`,
      { p: projectId, t: opts.targetId ?? null, active: opts.active ? 1 : 0, limit: opts.limit ?? 200 },
    ),
  );
}

export function createRun(
  studio: Studio,
  input: { projectId: string; kind: RunKind; targetId?: string | null; agent: string; task?: string; notes?: string; resumeFrom?: string; continued?: boolean },
): AgentRun {
  const project = getProject(studio, input.projectId);
  const id = newId("run");
  const logPath = projectPaths(studio, project).rel(path.join(projectPaths(studio, project).runs, `${id}.jsonl`));
  studio.db.run(
    `INSERT INTO agent_runs (id, project_id, target_kind, target_id, agent, task, payload_json, log_path, queued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, project.id, input.kind, input.targetId ?? null, input.agent, input.task ?? "build", JSON.stringify({ notes: input.notes, resumeFrom: input.resumeFrom, ...(input.continued ? { continued: true } : {}) }), logPath, nowIso()],
  );
  studio.emit("run.changed", { projectId: project.id, targetId: id, data: { status: "queued", target: input.targetId ?? null } });
  return getRun(studio, id);
}

export function updateRun(
  studio: Studio,
  id: string,
  patch: Partial<Pick<AgentRun, "status" | "claudeSessionId" | "resultText" | "costUsd" | "durationMs" | "error" | "startedAt" | "finishedAt">>,
): AgentRun {
  const next = { ...getRun(studio, id), ...patch };
  studio.db.run(
    `UPDATE agent_runs SET status = :status, claude_session_id = :session, result_text = :result, cost_usd = :cost,
       duration_ms = :duration, error = :error, started_at = :started, finished_at = :finished WHERE id = :id`,
    {
      id,
      status: next.status,
      session: next.claudeSessionId,
      result: next.resultText,
      cost: next.costUsd,
      duration: next.durationMs,
      error: next.error,
      started: next.startedAt,
      finished: next.finishedAt,
    },
  );
  if (patch.status) studio.emit("run.changed", { projectId: next.projectId, targetId: id, data: { status: next.status, target: next.targetId } });
  return getRun(studio, id);
}

export interface RunLogLine {
  at: string;
  /** "text" is the agent talking, "tool" a tool call, "result" what came back, "info" and "error" are the studio's own notes. */
  kind: "text" | "tool" | "result" | "info" | "error";
  text: string;
}

export function runLogFile(studio: Studio, run: Pick<AgentRun, "projectId" | "logPath">): string | undefined {
  if (!run.logPath) return undefined;
  return projectPaths(studio, getProject(studio, run.projectId)).abs(run.logPath);
}

export function appendRunLog(studio: Studio, run: Pick<AgentRun, "projectId" | "logPath">, kind: RunLogLine["kind"], text: string) {
  const file = runLogFile(studio, run);
  if (!file || !text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line: RunLogLine = { at: nowIso(), kind, text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text };
  fs.appendFileSync(file, JSON.stringify(line) + "\n");
}

/** Log lines from `after` on, so a viewer can keep asking for what is new. */
export function readRunLog(studio: Studio, runId: string, after = 0): { lines: RunLogLine[]; next: number } {
  const file = runLogFile(studio, getRun(studio, runId));
  if (!file || !fs.existsSync(file)) return { lines: [], next: after };
  const all = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const lines = all.slice(after).flatMap((l) => {
    try {
      return [JSON.parse(l) as RunLogLine];
    } catch {
      return [];
    }
  });
  return { lines, next: all.length };
}

/** The Claude session of the last run on this target, so a revision can continue the same conversation. */
export function lastSessionFor(studio: Studio, kind: RunKind, targetId: string | null, projectId: string): string | undefined {
  return studio.db.get<{ s: string }>(
    `SELECT claude_session_id AS s FROM agent_runs WHERE project_id = ? AND target_kind = ? AND COALESCE(target_id, '') = ?
     AND claude_session_id IS NOT NULL ORDER BY queued_at DESC, id DESC LIMIT 1`,
    [projectId, kind, targetId ?? ""],
  )?.s;
}

/**
 * The error of a run that stopped because the studio closed, not because it went wrong or
 * you stopped it. Starting the same work again continues that run's Claude session.
 */
export const CLOSED_MID_RUN = "The studio was closed while this was running.";

/** Runs left "running" by a studio that was closed are marked as stopped by the close, so they can be continued. */
export function failInterruptedRuns(studio: Studio): number {
  const stuck = studio.db.all<{ id: string }>("SELECT id FROM agent_runs WHERE status IN ('queued', 'running')");
  for (const { id } of stuck) {
    updateRun(studio, id, { status: "failed", error: CLOSED_MID_RUN, finishedAt: nowIso() });
  }
  return stuck.length;
}

/** The newest run on one target, if the studio closing stopped it after Claude had started a session. */
export function closedMidRun(studio: Studio, kind: RunKind, targetId: string | null, projectId: string): AgentRun | undefined {
  const last = studio.db.get<{ id: string }>(
    `SELECT id FROM agent_runs WHERE project_id = ? AND target_kind = ? AND COALESCE(target_id, '') = ? ORDER BY queued_at DESC, id DESC LIMIT 1`,
    [projectId, kind, targetId ?? ""],
  );
  const run = last ? getRun(studio, last.id) : undefined;
  return run && run.status === "failed" && run.error === CLOSED_MID_RUN && run.claudeSessionId ? run : undefined;
}
