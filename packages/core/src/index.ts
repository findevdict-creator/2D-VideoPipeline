/**
 * @studio/core: everything with state or side effects. The CLI, the MCP server
 * and the GUI server are thin layers over this package.
 */
export { REPO_ROOT, LIB_DIR, PYTHON_DIR } from "./paths.js";
export { loadConfig, type PipelineConfig, type RunnerKind } from "./config.js";
export { Production } from "./production.js";
export { runPipeline } from "./pipeline.js";
export { createRunner } from "./runners/index.js";
