import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../paths.js";
import { quoteForCmd } from "../../runners/claudeCli.js";
import type { Studio } from "../studio.js";
import type { Project } from "../store/projects.js";
import { projectPaths } from "../store/projects.js";
import type { AgentRun, RunLogLine } from "../store/runs.js";
import { parseUsageLimit, UsageLimitError } from "./limits.js";

export interface StudioRunRequest {
  run: AgentRun;
  project: Project;
  systemPrompt: string;
  prompt: string;
  /** The folder the run starts in. It must stay the same across runs on one target, or a session cannot be resumed. */
  cwd: string;
  /** True when the agent writes code files in cwd. Planning runs only use the studio's tools. */
  writesFiles: boolean;
  /** Continue this Claude session instead of starting a new one. */
  resumeSessionId?: string;
  model?: string;
  onLog: (kind: RunLogLine["kind"], text: string) => void;
  /** Called as soon as the session id is known, so a revision can resume even a run that later failed. */
  onSession: (sessionId: string) => void;
  signal?: AbortSignal;
}

export interface StudioRunResult {
  text: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
}

/**
 * Something that carries out one run: Claude Code, or a stand-in for tests. When Claude's
 * usage limit stops a run, `run` throws a UsageLimitError and the studio waits and continues.
 */
export interface StudioRunner {
  readonly kind: string;
  run(studio: Studio, request: StudioRunRequest): Promise<StudioRunResult>;
}

export const MCP_ENTRY = path.join(REPO_ROOT, "packages", "mcp", "src", "server.ts");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

/** The MCP settings that give one run its studio tools, scoped to that run. */
export function mcpConfig(studio: Studio, run: AgentRun) {
  const env: Record<string, string> = {
    STUDIO_WORKSPACE: studio.workspaceDir,
    STUDIO_PROJECT_ID: run.projectId,
    STUDIO_RUN_ID: run.id,
    PIPELINE_RUNNER: studio.config.runner,
    PIPELINE_VOICE_ENGINE: studio.config.voice.engine,
  };
  if (studio.config.render.browserExecutable) env.REMOTION_BROWSER_EXECUTABLE = studio.config.render.browserExecutable;
  if (studio.config.voice.python) env.PIPELINE_PYTHON = studio.config.voice.python;
  if (process.env.PIPELINE_CONFIG) env.PIPELINE_CONFIG = path.resolve(studio.config.rootDir, process.env.PIPELINE_CONFIG);
  return { mcpServers: { studio: { command: process.execPath, args: [TSX_CLI, MCP_ENTRY], env } } };
}

/**
 * Runs an agent as a headless Claude Code session with the studio's MCP server attached.
 * It uses whatever Claude Code is signed in with, so no API key is needed.
 */
export class ClaudeCliStudioRunner implements StudioRunner {
  readonly kind = "claude-cli";

  constructor(private readonly claudeBin = "claude") {}

  async run(studio: Studio, req: StudioRunRequest): Promise<StudioRunResult> {
    const p = projectPaths(studio, req.project);
    const dir = path.join(p.work, "runs", req.run.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(req.cwd, { recursive: true });
    const mcpFile = path.join(dir, "mcp.json");
    const systemFile = path.join(dir, "system-prompt.md");
    fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig(studio, req.run), null, 2));
    fs.writeFileSync(systemFile, req.systemPrompt);

    // Built-in tools: reading always, writing only for runs that produce code. No shell, no web.
    const builtIn = req.writesFiles ? "Read,Glob,Grep,Edit,Write" : "Read,Glob,Grep";
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--mcp-config", mcpFile,
      "--strict-mcp-config",
      "--tools", builtIn,
      "--allowedTools", `mcp__studio,${builtIn}`,
      "--permission-mode", "acceptEdits",
      "--append-system-prompt-file", systemFile,
    ];
    if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
    if (req.model) args.push("--model", req.model);

    try {
      return await this.spawnClaude(req, args);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private spawnClaude(req: StudioRunRequest, args: string[]): Promise<StudioRunResult> {
    return new Promise((resolve, reject) => {
      const windows = process.platform === "win32";
      const child = windows
        ? spawn([this.claudeBin, ...args].map(quoteForCmd).join(" "), { cwd: req.cwd, shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
        : spawn(this.claudeBin, args, { cwd: req.cwd, stdio: ["pipe", "pipe", "pipe"] });
      const abort = () => child.kill();
      req.signal?.addEventListener("abort", abort, { once: true });

      let buffer = "";
      let stderr = "";
      let result: { result?: string; is_error?: boolean; subtype?: string; total_cost_usd?: number; duration_ms?: number; session_id?: string } | undefined;
      let sessionId: string | undefined;
      /** What Claude Code itself reported about limits while it ran. */
      let refused: { resetsAt?: number } | undefined;
      let apiError: string | undefined;
      const onLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.session_id && !sessionId) {
          sessionId = event.session_id as string;
          req.onSession(sessionId);
        }
        if (event.type === "rate_limit_event" && event.rate_limit_info?.status === "rejected") refused = event.rate_limit_info;
        if (event.type === "assistant") {
          if (typeof event.error === "string") apiError = event.error;
          for (const block of event.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) req.onLog("text", block.text.trim());
            if (block.type === "tool_use") req.onLog("tool", describeToolUse(block.name, block.input));
          }
        } else if (event.type === "user") {
          for (const block of event.message?.content ?? []) {
            if (block.type === "tool_result") req.onLog("result", describeToolResult(block.content, block.is_error));
          }
        } else if (event.type === "result") {
          result = event;
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let at: number;
        while ((at = buffer.indexOf("\n")) >= 0) {
          onLine(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
        }
      });
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => reject(new Error(`Could not start "${this.claudeBin}". Check that "claude --version" works in this terminal, or set CLAUDE_BIN to its full path. (${err.message})`)));
      child.on("close", (code) => {
        req.signal?.removeEventListener("abort", abort);
        onLine(buffer);
        if (req.signal?.aborted) return reject(new Error("Cancelled"));
        if (code !== 0 || !result || result.is_error) {
          const detail = result?.result ?? (stderr.trim() || `exit code ${code}`);
          const limit = usageLimitFrom(detail, refused, apiError);
          if (limit) return reject(new UsageLimitError(`Claude stopped at a usage limit: ${detail}`, limit.resetAt, limit.cause));
          return reject(new Error(`Claude stopped with an error: ${detail}`));
        }
        resolve({ text: result.result ?? "", sessionId: result.session_id ?? sessionId, costUsd: result.total_cost_usd, durationMs: result.duration_ms });
      });
      child.stdin.end(req.prompt);
    });
  }
}

/** Whether a failed run failed because of a usage limit, going by what Claude Code reported and by its last words. */
export function usageLimitFrom(detail: string, refused?: { resetsAt?: number }, apiError?: string): { cause: "limit" | "busy"; resetAt?: Date } | undefined {
  const said = parseUsageLimit(detail);
  if (refused || apiError === "rate_limit") {
    // The reset time arrives as seconds since 1970.
    const at = refused?.resetsAt ? new Date(refused.resetsAt < 1e12 ? refused.resetsAt * 1000 : refused.resetsAt) : undefined;
    return { cause: "limit", resetAt: at ?? said?.resetAt };
  }
  if (apiError === "overloaded") return { cause: "busy" };
  return said;
}

function describeToolUse(name: string, input: unknown): string {
  const short = name.replace(/^mcp__studio__/, "");
  const obj = (input ?? {}) as Record<string, unknown>;
  if (typeof obj.file_path === "string") return `${short} ${path.basename(obj.file_path)}`;
  const json = JSON.stringify(obj);
  return json === "{}" ? short : `${short} ${json.length > 300 ? `${json.slice(0, 300)}…` : json}`;
}

function describeToolResult(content: unknown, isError?: boolean): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c: any) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : "")).join(" ")
        : "";
  const short = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  return isError ? `error: ${short}` : short;
}
