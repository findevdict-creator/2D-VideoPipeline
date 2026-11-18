import path from "node:path";

export type RunnerKind = "claude-cli" | "agent-sdk" | "mock";

export interface PipelineConfig {
  /** How agents are run. claude-cli uses your Claude Code login; agent-sdk uses ANTHROPIC_API_KEY. */
  runner: RunnerKind;
  /** Model for every agent, for example "opus" (default) or "sonnet". */
  model?: string;
  /** Where production folders are created. */
  productionsDir: string;
  /** How many Director review rounds an agent gets before the work goes to you. */
  maxDirectorRounds: number;
  /** How many times an agent may retry when its file fails validation. */
  maxFixAttempts: number;
  /** Path to the claude executable for the claude-cli runner. */
  claudeBin: string;
}

const RUNNERS: RunnerKind[] = ["claude-cli", "agent-sdk", "mock"];

export function loadConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  const envRunner = process.env.PIPELINE_RUNNER as RunnerKind | undefined;
  const runner = overrides.runner ?? envRunner ?? "claude-cli";
  if (!RUNNERS.includes(runner)) {
    throw new Error(`Unknown runner "${runner}". Use one of: ${RUNNERS.join(", ")}`);
  }
  return {
    runner,
    // Pinned so a Claude Code default that needs extra usage credits does not stop the run.
    model: overrides.model ?? process.env.PIPELINE_MODEL ?? "opus",
    productionsDir: path.resolve(overrides.productionsDir ?? process.env.PIPELINE_PRODUCTIONS_DIR ?? "productions"),
    maxDirectorRounds: overrides.maxDirectorRounds ?? Number(process.env.PIPELINE_DIRECTOR_ROUNDS ?? 2),
    maxFixAttempts: overrides.maxFixAttempts ?? 2,
    claudeBin: overrides.claudeBin ?? process.env.CLAUDE_BIN ?? "claude",
  };
}
