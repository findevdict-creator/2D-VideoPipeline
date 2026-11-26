import path from "node:path";
import type { WebpackOverrideFn } from "@remotion/bundler";

/**
 * Lets scene files in productions/<id>/scenes import "@pipeline/lib", and find
 * react and remotion even when the productions folder is outside the repo.
 * Used by the pipeline's renders and by Remotion Studio (remotion.config.ts).
 */
export function pipelineWebpackOverride(repoRoot: string): WebpackOverrideFn {
  return (config) => ({
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...((config.resolve?.alias as Record<string, string> | undefined) ?? {}),
        "@pipeline/lib": path.join(repoRoot, "packages", "lib", "src", "index.ts"),
      },
      modules: [path.join(repoRoot, "node_modules"), "node_modules", ...(config.resolve?.modules ?? [])],
    },
  });
}
