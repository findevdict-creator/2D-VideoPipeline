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
import { MockRunner, MOCK_SCRIPT, MOCK_STORYBOARD } from "../packages/core/src/runners/mock.js";
import { checkStoryboard } from "../packages/core/src/stages/files.js";
import { PREPRODUCTION_STAGES } from "../packages/core/src/stages/index.js";

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-test-"));
  const config = loadConfig({ runner: "mock", productionsDir: dir });
  const production = await Production.create(config, "How GPS works");
  const runner = new MockRunner();
  const logs: string[] = [];
  const ctx: StageContext = { config, runner, production, log: (m) => logs.push(m) };
  return { config, production, runner, ctx, logs };
}

test("runs all pre-production stages to an approved storyboard", async () => {
  const { ctx, production, runner } = await setup();
  const approver = new ScriptedApprover();

  assert.equal(await runPipeline(ctx, PREPRODUCTION_STAGES, approver), "complete");

  for (const id of ["brief", "script", "storyboard"] as const) {
    assert.equal(production.stage(id).status, "approved");
  }
  for (const file of ["brief.json", "research.md", "script.json", "storyboard.json"]) {
    assert.ok(existsSync(production.path(file)), `${file} exists`);
  }
  // The Director asked for one script revision, so the Scriptwriter ran twice.
  assert.deepEqual(
    runner.calls.map((c) => c.agent),
    ["producer", "researcher", "scriptwriter", "director", "scriptwriter", "director", "storyboard-artist", "director"],
  );
  assert.equal(approver.seen.length, 3);
  assert.match(approver.seen[1]!.summary, /Estimated length: \d+s spoken \(target 75s\)/);
  assert.match(approver.seen[2]!.summary, /on "That point is you": pin drops in/);
  assert.equal(production.state.agentRuns, 8);
});

test("a revision request archives the old version and passes your notes to the agent", async () => {
  const { ctx, production, runner } = await setup();
  const approver = new ScriptedApprover([{ decision: "revise", notes: "Make it 60 seconds" }]);

  await runPipeline(ctx, PREPRODUCTION_STAGES, approver);

  const brief = production.stage("brief");
  assert.equal(brief.revision, 2);
  assert.deepEqual(brief.humanNotes, ["Make it 60 seconds"]);
  assert.ok(existsSync(production.path("history", "brief", "rev-1", "brief.json")));
  const producerCalls = runner.calls.filter((c) => c.agent === "producer");
  assert.equal(producerCalls.length, 2);
  assert.match(producerCalls[1]!.prompt, /Make it 60 seconds/);
});

test("quitting pauses, and a later run resumes without redoing approved stages", async () => {
  const { ctx, config, production, runner } = await setup();
  const first = new ScriptedApprover([{ decision: "approve" }, { decision: "quit" }]);
  assert.equal(await runPipeline(ctx, PREPRODUCTION_STAGES, first), "paused");
  assert.equal(production.stage("script").status, "awaiting_approval");
  const callsBefore = runner.calls.length;

  const reloaded = await Production.load(config, production.id);
  const resumed = { ...ctx, production: reloaded };
  assert.equal(await runPipeline(resumed, PREPRODUCTION_STAGES, new ScriptedApprover()), "complete");

  // Only the storyboard work ran on resume: the script was waiting for approval, not redone.
  assert.deepEqual(
    runner.calls.slice(callsBefore).map((c) => c.agent),
    ["storyboard-artist", "director"],
  );
});

test("storyboard checks catch mismatched scenes, unknown elements and cues not in the narration", () => {
  assert.deepEqual(checkStoryboard(MOCK_STORYBOARD, MOCK_SCRIPT), []);

  const broken = structuredClone(MOCK_STORYBOARD);
  broken.scenes.pop();
  broken.scenes[0]!.animations = [{ elementId: "ghost", action: "appears", cue: "words nobody says" }];
  const errors = checkStoryboard(broken, MOCK_SCRIPT);
  assert.equal(errors.length, 3);
  assert.match(errors[0]!, /must match script.json scene ids/);
  assert.match(errors[1]!, /unknown element "ghost"/);
  assert.match(errors[2]!, /not a word-for-word phrase/);
});
