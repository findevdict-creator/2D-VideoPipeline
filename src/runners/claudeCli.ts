import { spawn } from "node:child_process";
import type { AgentRunner, AgentRunRequest, AgentRunResult } from "./types.js";

/**
 * Runs each agent as a headless Claude Code session (`claude -p`).
 * Uses whatever Claude Code is signed in with, such as a Pro or Max plan,
 * so no API key is needed. Your plan's usage limits apply.
 */
export class ClaudeCliRunner implements AgentRunner {
  readonly kind = "claude-cli";

  constructor(private readonly claudeBin = "claude") {}

  run(req: AgentRunRequest): Promise<AgentRunResult> {
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
      "--append-system-prompt",
      req.systemPrompt,
      "--no-session-persistence",
    ];
    if (req.model) args.push("--model", req.model);

    return new Promise((resolve, reject) => {
      const child = spawn(this.claudeBin, args, { cwd: req.cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) =>
        reject(new Error(`Could not start "${this.claudeBin}". Is Claude Code installed and on your PATH? (${err.message})`)),
      );
      child.on("close", (code) => {
        let parsed: { result?: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number } | undefined;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          // fall through to the error below
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
