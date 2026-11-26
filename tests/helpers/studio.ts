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
  // Only a test that asks for a browser renders with one, so the rest stay fast when REMOTION_BROWSER_EXECUTABLE is set.
  if (!overrides.render?.browserExecutable) config.render.browserExecutable = "";
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

/** A tiny scene whose picture depends on `label`, so changing the label changes the clip. */
export const sceneCode = (label: string) => `import React from "react";
import { Background, Title, useAppear, useCueAppear } from "@pipeline/lib";

export default function Scene() {
  const titleIn = useAppear(0, 0.4);
  const cueIn = useCueAppear("sat", { durationSec: 0.3 });
  return (
    <>
      <Background stars />
      <Title progress={titleIn}>${label}</Title>
      <div style={{ position: "absolute", left: 200, top: 400, width: 80, height: 80, background: "white", opacity: cueIn }} />
    </>
  );
}
`;

export const BROWSER = process.env.REMOTION_BROWSER_EXECUTABLE;
export const needsBrowser = { skip: !BROWSER && "set REMOTION_BROWSER_EXECUTABLE to run", timeout: 900_000 } as const;
