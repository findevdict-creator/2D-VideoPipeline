import type { PipelineConfig } from "../config.js";
import { AgentSdkRunner } from "./agentSdk.js";
import { ClaudeCliRunner } from "./claudeCli.js";
import { MockRunner } from "./mock.js";
import type { AgentRunner } from "./types.js";

export function createRunner(config: PipelineConfig): AgentRunner {
  switch (config.runner) {
    case "claude-cli":
      return new ClaudeCliRunner(config.claudeBin);
    case "agent-sdk":
      return new AgentSdkRunner();
    case "mock":
      return new MockRunner();
  }
}

export type { AgentRunner, AgentRunRequest, AgentRunResult } from "./types.js";
