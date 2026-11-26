import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner, AgentRunRequest, AgentRunResult } from "./types.js";

/**
 * Runs each agent through the Claude Agent SDK (Claude Code as a library).
 * Authenticates with ANTHROPIC_API_KEY and bills per use.
 */
export class AgentSdkRunner implements AgentRunner {
  readonly kind = "agent-sdk";

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("The agent-sdk runner needs ANTHROPIC_API_KEY. Set it, or use --runner claude-cli.");
    }
    const stream = query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        systemPrompt: { type: "preset", preset: "claude_code", append: req.systemPrompt },
        tools: req.tools,
        allowedTools: req.tools,
        permissionMode: "acceptEdits",
        persistSession: false,
        ...(req.addDirs?.length ? { additionalDirectories: req.addDirs } : {}),
        // Project settings hold the skills in .claude/skills.
        ...(req.useProjectSkills ? { settingSources: ["project" as const] } : {}),
        ...(req.model ? { model: req.model } : {}),
      },
    });

    for await (const message of stream) {
      if (message.type !== "result") continue;
      if (message.subtype === "success" && !message.is_error) {
        return { text: message.result, costUsd: message.total_cost_usd, durationMs: message.duration_ms };
      }
      const detail = message.subtype === "success" ? message.result : message.subtype;
      throw new Error(`Agent "${req.agent}" failed: ${detail}`);
    }
    throw new Error(`Agent "${req.agent}" ended without a result`);
  }
}
