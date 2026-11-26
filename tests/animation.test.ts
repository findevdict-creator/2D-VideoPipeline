import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScriptedApprover } from "../packages/core/src/approval.js";
import { loadConfig } from "../packages/core/src/config.js";
import type { StageContext } from "../packages/core/src/context.js";
import { runPipeline } from "../packages/core/src/pipeline.js";
import { Production } from "../packages/core/src/production.js";
import { animateScene, scenesInNotes, StatusStore } from "../packages/core/src/render/animate.js";
import { buildVideoData, dimensions, renderPaths, unRespell, writeProject } from "../packages/core/src/render/project.js";
import { framesToCheck, typecheckScenes } from "../packages/core/src/render/remotion.js";
import { checkSceneSource } from "../packages/core/src/render/sceneCheck.js";
import { MockRunner } from "../packages/core/src/runners/mock.js";
import type { AgentRunRequest } from "../packages/core/src/runners/types.js";
import { PIPELINE_STAGES } from "../packages/core/src/stages/index.js";
import { captionsToSrt } from "../packages/core/src/stages/render.js";

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "animation-test-"));
  await fs.writeFile(path.join(root, "pronunciations.json"), JSON.stringify({ GPS: "G P S" }));
  const config = loadConfig({ runner: "mock", rootDir: root, productionsDir: path.join(root, "productions") });
  const production = await Production.create(config, "How GPS works");
  const ctx: StageContext = { config, runner: new MockRunner(), production, log: () => {} };
  await runPipeline(ctx, PIPELINE_STAGES.slice(0, 4), new ScriptedApprover());
  return { ctx, production };
}

test("animation and render come after the voiceover", () => {
  assert.deepEqual(
    PIPELINE_STAGES.map((s) => s.id),
    ["brief", "script", "storyboard", "voiceover", "animation", "render"],
  );
});

test("video data has every scene back to back, with cue frames and caption pages", async () => {
  const { ctx } = await setup();
  const data = await buildVideoData(ctx);
  assert.equal(data.width, 1920);
  assert.equal(data.height, 1080);
  assert.equal(data.scenes.length, 5);
  let start = 0;
  for (const s of data.scenes) {
    assert.equal(s.startFrame, start);
    start += s.durationInFrames;
    for (const c of s.cues) assert.ok(c.startFrame >= s.speechStartFrame && c.startFrame < s.durationInFrames);
    assert.ok(s.cues.every((c) => c.action.length > 0), `${s.id} cues carry the storyboard action`);
  }
  assert.ok(data.captions.pages.length > 5);
  // Captions show what the script says ("GPS"), not the respelling the narrator was given ("G P S").
  const text = data.captions.pages.flatMap((p) => p.tokens.map((t) => t.text)).join("");
  assert.match(text, /GPS/);
  assert.doesNotMatch(text, /\bG P S\b/);
  assert.equal(data.music.src, null);
});

test("respelled words are joined back for captions", () => {
  const words = ["The", "G", "P", "S", "works"].map((text, i) => ({ text, startSec: i, endSec: i + 0.5 }));
  assert.deepEqual(
    unRespell(words, { GPS: "G P S" }).map((w) => [w.text, w.startSec, w.endSec]),
    [["The", 0, 0.5], ["GPS", 1, 3.5], ["works", 4, 4.5]],
  );
});

test("frame sizes follow the brief's aspect ratio", () => {
  assert.deepEqual(dimensions("16:9", 1080), { width: 1920, height: 1080 });
  assert.deepEqual(dimensions("9:16", 1080), { width: 1080, height: 1920 });
  assert.deepEqual(dimensions("1:1", 720), { width: 720, height: 720 });
});

test("notes are routed to the scenes they name, or to all scenes", () => {
  const ids = ["s01", "s02", "s03", "s04", "s05"];
  assert.deepEqual(scenesInNotes("s03: make the pin bigger", ids), ["s03"]);
  assert.deepEqual(scenesInNotes("Scene 2 is too busy, and scene 4 is slow", ids), ["s02", "s04"]);
  assert.deepEqual(scenesInNotes("scenes 1 and 5 need a brighter title", ids), ["s01", "s05"]);
  assert.deepEqual(scenesInNotes("scenes 2-4 feel empty", ids), ["s02", "s03", "s04"]);
  assert.deepEqual(scenesInNotes("Use bigger labels everywhere", ids), []);
  assert.deepEqual(scenesInNotes("scene 9", ids), []);
});

test("scene source rules catch what breaks renders", () => {
  const good = `import React from "react";
import {
  useCurrentFrame,
} from "remotion";
const caption = 'Signals from "space" arrive';
export default function Scene() { return <div>Data comes from "it works the same way"</div>; } // see https://remotion.dev`;
  assert.deepEqual(checkSceneSource(good), []);
  const bad = `import x from "lodash";
const y2 = await import("fs");
export * from "./other";
const y = Math.random();
const s = { transition: "opacity 0.3s ease" };
const img = "https://example.com/a.png";
setTimeout(() => {}, 10);
function Scene() { return null; }`;
  const problems = checkSceneSource(bad);
  assert.equal(problems.length, 8, problems.join("\n"));
});

test("test frames land after cues and near the end", () => {
  const scene = {
    durationInFrames: 300,
    cues: [{ startFrame: 40 }, { startFrame: 150 }],
  } as unknown as Parameters<typeof framesToCheck>[0];
  assert.deepEqual(framesToCheck(scene, 30, 3), [61, 171, 290]);
  assert.equal(framesToCheck(scene, 30, 8).length, 4);
});

test("type errors are reported against the scene that has them", { timeout: 120_000 }, async () => {
  const { ctx } = await setup();
  const r = renderPaths(ctx);
  await fs.mkdir(r.scenesDir, { recursive: true });
  await fs.writeFile(r.scene("s01"), `import React from "react";\nexport default function Scene() { return <div />; }\n`);
  await fs.writeFile(r.scene("s02"), `import React from "react";\nconst n: number = "x";\nexport default function Scene() { return <div>{n}</div>; }\n`);
  await writeProject(ctx);
  const errors = await typecheckScenes(ctx);
  assert.deepEqual(Object.keys(errors), ["s02"]);
  assert.match(errors.s02![0]!, /scenes\/s02\.tsx\(2,7\).*TS2322/);
});

test("a scene that keeps breaking the rules becomes a placeholder, keeping the Animator's file", async () => {
  const { ctx } = await setup();
  class RuleBreaker extends MockRunner {
    override async run(req: AgentRunRequest) {
      if (req.agent !== "animator") return super.run(req);
      this.calls.push(req);
      await fs.writeFile(req.expectedOutputs[0]!, `export default function Scene() { return Math.random(); }\n`);
      return { text: "wrote it" };
    }
  }
  const runner = new RuleBreaker();
  const c = { ...ctx, runner };
  const data = await writeProject(c);
  const store = await StatusStore.load(c);
  const status = await animateScene(c, data, "s01", store);

  assert.equal(status.status, "placeholder");
  assert.match(status.problems[0]!, /Math\.random/);
  assert.equal(runner.calls.length, 1 + c.config.maxFixAttempts, "first try plus the fix attempts");
  // The Animator ran from the repo root, so it can load the Remotion skills, with the production folder added.
  assert.ok(existsSync(path.join(runner.calls[0]!.cwd, ".claude", "skills", "remotion-best-practices")));
  assert.deepEqual(runner.calls[0]!.addDirs, [c.production.dir]);
  const r = renderPaths(c);
  assert.match(await fs.readFile(path.join(r.scenesDir, "broken", "s01.tsx"), "utf8"), /Math\.random/);
  assert.doesNotMatch(await fs.readFile(r.scene("s01"), "utf8"), /Math\.random/);
  assert.equal((await StatusStore.load(c)).get("s01")?.status, "placeholder");
  assert.ok(await store.isDone(c, "s01"));
});

test("subtitles come from the caption pages", async () => {
  const { ctx } = await setup();
  const data = await buildVideoData(ctx);
  const srt = captionsToSrt(data);
  assert.match(srt, /^1\n00:00:00,\d{3} --> 00:00:0\d,\d{3}\n\S/);
  assert.equal(srt.match(/-->/g)?.length, data.captions.pages.length);
});

// Rendering needs a browser. Set REMOTION_BROWSER_EXECUTABLE to a Chrome or Chrome Headless Shell to run this one.
test(
  "the mock run renders a preview and a final video",
  { skip: !process.env.REMOTION_BROWSER_EXECUTABLE && "set REMOTION_BROWSER_EXECUTABLE to run", timeout: 900_000 },
  async () => {
    const { ctx, production } = await setup();
    ctx.config.render.resolution = 360;
    ctx.config.animator.maxFixRounds = 1;
    ctx.config.animator.stillsPerScene = 1;
    const approver = new ScriptedApprover();
    assert.equal(await runPipeline(ctx, PIPELINE_STAGES, approver), "complete");
    assert.ok(existsSync(renderPaths(ctx).preview));
    const final = await fs.readdir(production.path("final"));
    assert.deepEqual(final.sort(), ["how-gps-works.mp4", "how-gps-works.srt"]);
    const store = await StatusStore.load(ctx);
    for (const id of ["s01", "s02", "s03", "s04", "s05"]) assert.equal(store.get(id)?.status, "good");
    // setup() approved the first four stages, so this approver saw animation, then render.
    assert.match(approver.seen[0]!.summary, /s05 {2}looks good/);
    assert.match(approver.seen[1]!.summary, /640x360/);
  },
);
