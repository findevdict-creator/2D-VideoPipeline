import type { PipelineConfig } from "./config.js";
import type { Production } from "./production.js";
import type { AgentRunner } from "./runners/types.js";

export interface StageContext {
  config: PipelineConfig;
  runner: AgentRunner;
  production: Production;
  log: (message: string) => void;
}
