import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, type ConfigOverrides } from "../../packages/core/src/config.js";
import { Studio } from "../../packages/core/src/studio/studio.js";

export const REPO = path.resolve(import.meta.dirname, "..", "..");

/** A studio in a fresh temporary workspace, with the mock runner and the mock voice. */
export async function tempStudio(overrides: ConfigOverrides = {}): Promise<Studio> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-test-"));
  const config = loadConfig({ rootDir: REPO, runner: "mock", ...overrides });
  return new Studio(config, dir);
}

export const SAMPLE_SPEC = {
  type: "remotion-2d" as const,
  title: "Satellites send time",
  purpose: "Show that each satellite broadcasts the time",
  narration: "Each satellite carries a clock and keeps shouting the time. Your phone listens for it.",
  visual: { description: "A satellite pulses rings toward a phone", elements: [{ id: "sat", kind: "icon", description: "satellite" }] },
  cues: [
    { id: "sat", phrase: "Each satellite", action: "satellite fades in" },
    { id: "phone", phrase: "Your phone listens", action: "phone appears" },
  ],
};
