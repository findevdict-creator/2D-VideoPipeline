export interface AgentRunRequest {
  /** Agent name, used for logs and by the mock runner. */
  agent: string;
  /** The agent's role and rules. Appended to Claude Code's own system prompt. */
  systemPrompt: string;
  /** The task for this run. */
  prompt: string;
  /** Working directory: the production folder. */
  cwd: string;
  /** Built-in Claude Code tools the agent may use, for example ["Read", "Write"]. */
  tools: string[];
  /** Files (absolute paths) the agent is expected to write. */
  expectedOutputs: string[];
  model?: string;
}

export interface AgentRunResult {
  /** The agent's final message. */
  text: string;
  /** Reported cost. With a Claude subscription this is an estimate, not a bill. */
  costUsd?: number;
  durationMs?: number;
}

export interface AgentRunner {
  readonly kind: string;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
