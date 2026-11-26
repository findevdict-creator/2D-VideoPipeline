import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../packages/server/src/server.js";
import { parseLengthAdvice, recommendLength, sampleLengthAdvice, statedLength, tidyLength } from "../packages/core/src/studio/length.js";
import { NewProjectSchema } from "../packages/core/src/studio/model/project.js";
import { createProject } from "../packages/core/src/studio/store/projects.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { tempStudio } from "./helpers/studio.js";

test("a project takes any length from 10 seconds to 60 minutes, not only the ones in the list", async () => {
  const studio = await tempStudio();
  const description = "How the tides follow the moon, for curious adults.";
  assert.equal(createProject(studio, { description, targetDurationSec: 420 }).targetDurationSec, 420);
  assert.equal(createProject(studio, { description, targetDurationSec: 437 }).targetDurationSec, 437);
  assert.equal(NewProjectSchema.safeParse({ description, targetDurationSec: 3600 }).success, true);
  const tooLong = NewProjectSchema.safeParse({ description, targetDurationSec: 3601 });
  assert.equal(tooLong.success, false);
  assert.match(tooLong.error!.issues[0]!.message, /at most 60 minutes/);
  assert.match(NewProjectSchema.safeParse({ description, targetDurationSec: 5 }).error!.issues[0]!.message, /at least 10 seconds/);
  studio.close();
});

test("a recommended length is read from Claude's answer and brought to a round number inside the limits", () => {
  assert.deepEqual(parseLengthAdvice('{"seconds": 420, "reason": "Four parts, about a minute and a half each."}'), { seconds: 420, reason: "Four parts, about a minute and a half each." });
  // Claude sometimes wraps the answer in a sentence or a code fence.
  assert.equal(parseLengthAdvice('Here you go:\n```json\n{"seconds": 47, "reason": "One fact."}\n```').seconds, 45);
  assert.equal(parseLengthAdvice('{"seconds": 9000, "reason": "A whole course."}').seconds, 3600);
  assert.equal(parseLengthAdvice('{"seconds": 2, "reason": ""}').seconds, 10);
  assert.throws(() => parseLengthAdvice("About seven minutes, I think."), /did not give a length/);
  assert.throws(() => parseLengthAdvice('{"seconds": "soon"}'), /did not give a length/);

  assert.equal(tidyLength(93), 95);
  assert.equal(tidyLength(428), 435);
  assert.equal(tidyLength(1290), 1320);
});

test("a length said in the description is found", () => {
  assert.equal(statedLength("A 7 minute video on black holes"), 420);
  assert.equal(statedLength("Explain tides in 90 seconds"), 90);
  assert.equal(statedLength("a 2.5-minute explainer"), 150);
  assert.equal(statedLength("How the moon moves the sea"), undefined);
});

test("with the stand-in runner a length is recommended without calling Claude, over the API too", async () => {
  const studio = await tempStudio();
  assert.equal(studio.config.runner, "mock");
  assert.deepEqual(await recommendLength(studio, "A 7 minute video on black holes for teenagers"), { seconds: 420, reason: "Your description asks for this length." });
  assert.equal(sampleLengthAdvice("Why the sky is blue, as one quick fact.").seconds, 60);
  await assert.rejects(recommendLength(studio, "Tides"), /at least a sentence/);

  const server = await startServer(studio, { port: 0, orchestrator: new NoRenderOrchestrator(studio) });
  try {
    const ask = (description: unknown) =>
      fetch(server.url + "/api/recommend-length", { method: "POST", headers: { "x-studio": "1", "content-type": "application/json" }, body: JSON.stringify({ description }) });
    const answer = await ask("Explain how GPS works in 90 seconds");
    assert.equal(answer.status, 200);
    assert.equal(((await answer.json()) as { seconds: number }).seconds, 90);
    const refused = await ask("GPS");
    assert.equal(refused.status, 400);
    // Asking creates nothing: the person decides what to do with the answer.
    assert.equal(studio.db.all("SELECT id FROM projects").length, 0);
  } finally {
    await server.close();
    studio.close();
  }
});
