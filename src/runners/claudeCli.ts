import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRunner, AgentRunRequest, AgentRunResult } from "./types.js";

/**
 * Runs each agent as a headless Claude Code session (`claude -p`).
 * Uses whatever Claude Code is signed in with, such as a Pro or Max plan,
 * so no API key is needed. Your plan's usage limits apply.
 */
export class ClaudeCliRunner implements AgentRunner {
  readonly kind = "claude-cli";

  constructor(private readonly claudeBin = "claude") {}

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    // The system prompt goes in a file and the task through stdin, so every
    // command-line argument stays short and simple. That keeps Windows happy.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-agent-"));
    const systemPromptFile = path.join(tmp, "system-prompt.md");
    await fs.writeFile(systemPromptFile, req.systemPrompt);
    try {
      return await this.spawnClaude(req, systemPromptFile);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  private spawnClaude(req: AgentRunRequest, systemPromptFile: string): Promise<AgentRunResult> {
    const tools = req.tools.join(",");
    const args = [
      "-p",
      "--output-format",
      "json",
      "--tools",
      tools,
      "--allowedTools",
      tools,
      "--permission-mode",
      "acceptEdits",
      "--append-system-prompt-file",
      systemPromptFile,
      "--no-session-persistence",
    ];
    for (const dir of req.addDirs ?? []) args.push("--add-dir", dir);
    if (req.model) args.push("--model", req.model);

    return new Promise((resolve, reject) => {
      // On Windows, Claude Code is usually a claude.cmd or claude.ps1 shim, which
      // Node can only start through the shell.
      const windows = process.platform === "win32";
      const child = windows
        ? spawn([this.claudeBin, ...args].map(quoteForCmd).join(" "), {
            cwd: req.cwd,
            shell: true,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          })
        : spawn(this.claudeBin, args, { cwd: req.cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) =>
        reject(new Error(`${notInstalled(this.claudeBin)} (${err.message})`)),
      );
      child.on("close", (code) => {
        let parsed: { result?: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number } | undefined;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          // fall through to the error below
        }
        if (code !== 0 && !parsed && /not recognized|not found/i.test(stderr)) {
          reject(new Error(notInstalled(this.claudeBin)));
          return;
        }
        if (code !== 0 || !parsed || parsed.is_error) {
          const detail = parsed?.result ?? (stderr.trim() || stdout.trim() || `exit code ${code}`);
          reject(new Error(`Agent "${req.agent}" failed: ${detail}`));
          return;
        }
        resolve({ text: parsed.result ?? "", costUsd: parsed.total_cost_usd, durationMs: parsed.duration_ms });
      });
      // The prompt goes through stdin so long tasks never hit argument length limits.
      child.stdin.end(req.prompt);
    });
  }
}

function notInstalled(bin: string) {
  return (
    `Could not start "${bin}". Check that "claude --version" works in this terminal. ` +
    `If Claude Code is installed somewhere else, set CLAUDE_BIN to its full path.`
  );
}

/** Quote one argument for cmd.exe when it contains spaces or special characters. */
export function quoteForCmd(arg: string): string {
  return /^[\w.,:\\/=+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}
