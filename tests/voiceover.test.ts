import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScriptedApprover } from "../src/approval.js";
import { loadConfig } from "../src/config.js";
import type { StageContext } from "../src/context.js";
import { runPipeline } from "../src/pipeline.js";
import { Production } from "../src/production.js";
import { MockRunner } from "../src/runners/mock.js";
import type { Voiceover } from "../src/schemas.js";
import { PIPELINE_STAGES } from "../src/stages/index.js";
import { synthesize } from "../src/stages/voiceover.js";
import type { SpeechJob } from "../src/voice/engine.js";
import { applyPronunciations, findCueTiming, kokoroLanguage } from "../src/voice/text.js";

async function setup(voice: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-test-"));
  await fs.writeFile(path.join(root, "pronunciations.json"), JSON.stringify({ GPS: "G P S" }));
  const config = loadConfig({ runner: "mock", rootDir: root, productionsDir: path.join(root, "productions"), voice });
  const production = await Production.create(config, "How GPS works");
  const runner = new MockRunner();
  const ctx: StageContext = { config, runner, production, log: () => {} };
  return { root, config, production, runner, ctx };
}

const readVoiceover = async (p: Production) =>
  JSON.parse(await fs.readFile(p.path("voiceover.json"), "utf8")) as Voiceover;

test("the voiceover stage speaks every scene and times every storyboard cue", async () => {
  const { ctx, production } = await setup();
  const approver = new ScriptedApprover();
  assert.equal(await runPipeline(ctx, PIPELINE_STAGES, approver), "complete");

  const vo = await readVoiceover(production);
  assert.equal(vo.scenes.length, 5);
  assert.equal(vo.settings.voice, "af_heart");
  assert.equal(vo.settings.language, "a");
  assert.ok(existsSync(production.path("voice", "full.wav")));
  for (const scene of vo.scenes) {
    assert.ok(existsSync(production.path(scene.audioFile)), `${scene.audioFile} exists`);
    assert.equal(scene.speechStartSec, 0.3);
    assert.ok(scene.durationSec > scene.speechEndSec);
    for (const cue of scene.cues) {
      assert.equal(cue.match, "exact", `${scene.id} "${cue.cue}" found`);
      assert.ok(cue.startSec >= scene.speechStartSec && cue.endSec <= scene.speechEndSec);
    }
  }
  const total = vo.scenes.reduce((s, x) => s + x.durationSec, 0);
  assert.ok(Math.abs(vo.totalDurationSec - total) < 0.01);
  assert.match(approver.seen[3]!.summary, /cues timed: 1\/1/);
});

test("only scenes whose text or settings changed are spoken again", async () => {
  const { ctx, production, config } = await setup();
  await runPipeline(ctx, PIPELINE_STAGES.slice(0, 3), new ScriptedApprover());
  await synthesize(ctx);
  const first = await readVoiceover(production);

  // Change one scene's narration.
  const scriptFile = production.path("script.json");
  const script = JSON.parse(await fs.readFile(scriptFile, "utf8"));
  script.scenes[1].narration = script.scenes[1].narration.replace("About thirty", "Around thirty");
  await fs.writeFile(scriptFile, JSON.stringify(script));

  const { MockSpeechEngine } = await import("../src/voice/engine.js");
  const spoke: string[] = [];
  const original = MockSpeechEngine.prototype.speak;
  MockSpeechEngine.prototype.speak = async function (this: InstanceType<typeof MockSpeechEngine>, job: SpeechJob) {
    spoke.push(...job.items.map((i) => i.id));
    return original.call(this, job);
  };
  try {
    await synthesize(ctx);
    assert.deepEqual(spoke, ["s02"]);

    // A settings change (slower pace) re-speaks everything.
    spoke.length = 0;
    const slower = { ...ctx, config: { ...config, voice: { ...config.voice, speed: 0.8 } } };
    await synthesize(slower);
    assert.equal(spoke.length, 5);
  } finally {
    MockSpeechEngine.prototype.speak = original;
  }
  const second = await readVoiceover(production);
  assert.notEqual(first.scenes[1]!.cacheKey, second.scenes[1]!.cacheKey);
});

test("revision notes go to the Scriptwriter, and broken cues go to the Storyboard artist", async () => {
  const { ctx, runner, production } = await setup();
  const approver = new ScriptedApprover([
    { decision: "approve" },
    { decision: "approve" },
    { decision: "approve" },
    { decision: "revise", notes: "Scene 2: say 'around thirty' instead" },
  ]);
  await runPipeline(ctx, PIPELINE_STAGES, approver);
  const after = runner.calls.slice(-1);
  assert.deepEqual(
    after.map((c) => c.agent),
    ["scriptwriter"],
    "the mock script still matches the storyboard, so no cue fix is needed",
  );
  assert.match(after[0]!.prompt, /Change only the scenes the notes are about/);
  assert.equal(production.stage("voiceover").revision, 2);
  assert.ok(existsSync(production.path("history", "voiceover", "rev-1", "voiceover.json")));
  assert.ok(existsSync(production.path("history", "voiceover", "rev-1", "script.json")));
});

test("productions made before the voiceover stage existed pick it up as pending", async () => {
  const { config, production } = await setup();
  const state = JSON.parse(await fs.readFile(production.path("state.json"), "utf8"));
  delete state.stages.voiceover;
  await fs.writeFile(production.path("state.json"), JSON.stringify(state));
  const loaded = await Production.load(config, production.id);
  assert.equal(loaded.stage("voiceover").status, "pending");
});

test("respellings replace whole words only, matching case", () => {
  const p = { GPS: "G P S", km: "kilometers", "e.g.": "for example" };
  assert.equal(applyPronunciations("GPS uses 20 km orbits, e.g. MEO.", p), "G P S uses 20 kilometers orbits, for example MEO.");
  assert.equal(applyPronunciations("GPSX and gps stay", p), "GPSX and gps stay");
});

test("cue timing finds phrases across different word splits, and estimates when it cannot", () => {
  const words = [
    { text: "That", startSec: 1.0, endSec: 1.2 },
    { text: "'s", startSec: 1.2, endSec: 1.3 },
    { text: "you", startSec: 1.3, endSec: 1.6 },
    { text: "G", startSec: 2.0, endSec: 2.1 },
    { text: "P", startSec: 2.1, endSec: 2.2 },
    { text: "S", startSec: 2.2, endSec: 2.4 },
  ];
  const speech = { startSec: 0.3, endSec: 3.0 };
  assert.deepEqual(findCueTiming("That's you", "That's you GPS", words, speech, {}), { startSec: 1.0, endSec: 1.6, match: "exact" });
  assert.deepEqual(findCueTiming("GPS", "That's you G P S", words, speech, { GPS: "G P S" }), { startSec: 2.0, endSec: 2.4, match: "exact" });
  const est = findCueTiming("not said", "That's you", words, speech, {});
  assert.equal(est.match, "estimated");
});

test("language comes from the voice name unless it is set", () => {
  assert.equal(kokoroLanguage("auto", "af_heart"), "a");
  assert.equal(kokoroLanguage("auto", "bm_george"), "b");
  assert.equal(kokoroLanguage("en-gb", "af_heart"), "b");
  assert.throws(() => kokoroLanguage("klingon", "af_heart"), /Unknown voice.language/);
});
