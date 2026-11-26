import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startServer } from "../packages/server/src/server.js";
import { assemble, scenesChangedSince, type Render } from "../packages/core/src/studio/assemble.js";
import { newId, nowIso } from "../packages/core/src/studio/ids.js";
import { addChapter, getChapter, updateChapter } from "../packages/core/src/studio/store/chapters.js";
import { createProject, projectPaths } from "../packages/core/src/studio/store/projects.js";
import { createRun } from "../packages/core/src/studio/store/runs.js";
import { addScene, deleteScene, getScene, listScenes, moveScene, narrationOverlap, proposeScenes, saveSpec, sayTheSame, sceneLabel, setSceneStatus } from "../packages/core/src/studio/store/scenes.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { callTool } from "../packages/core/src/studio/tools/index.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { SAMPLE_SPEC, tempStudio } from "./helpers/studio.js";

const LINES = {
  hum: "On a plane the engines hum at one steady low note for hours on end.",
  wave: "Sound is a wave of pressure, pushing the air and then pulling it back.",
  mirror: "Play the same wave upside down and every push meets a pull, so they cancel.",
  mics: "Tiny microphones on the ear cup listen to the noise outside before it reaches you.",
  limits: "Sudden sounds like a slammed door change too fast for the headphones to follow.",
};
const plan = (title: string, narration: string) => ({ title, type: "remotion-2d" as const, narration });

function twoChapters(studio: Studio) {
  const project = createProject(studio, { description: "How noise-cancelling headphones erase sound with more sound.", targetDurationSec: 120 });
  const one = addChapter(studio, project.id, { title: "The problem" });
  const two = addChapter(studio, project.id, { title: "The trick" });
  return { project, one, two };
}

const build = (studio: Studio, sceneId: string) => {
  const scene = getScene(studio, sceneId);
  const saved = saveSpec(studio, sceneId, { ...SAMPLE_SPEC, title: scene.title, narration: scene.plan.narration, cues: [] }, "test");
  assert.ok(saved.ok, JSON.stringify(saved));
  return getScene(studio, sceneId);
};

const labels = (studio: Studio, projectId: string) => listScenes(studio, projectId).map((s) => `${sceneLabel(studio, s)} ${s.title}`);

test("two narrations that say the same thing are told apart from two that share a few words", () => {
  assert.ok(sayTheSame(LINES.mirror, "Play the same wave upside-down, and every push meets a pull so they cancel."));
  assert.ok(!sayTheSame(LINES.mirror, LINES.wave));
  assert.ok(!sayTheSame("So what now?", "So, what now?"), "short lines are never called duplicates");
  assert.equal(narrationOverlap(LINES.hum, LINES.hum), 1);
  assert.equal(narrationOverlap(LINES.hum, ""), 0);
});

test("a new scene list replaces the old one: a reworded title keeps its built scene, and a dropped scene does not linger", async () => {
  const studio = await tempStudio();
  const { project, one } = twoChapters(studio);
  const first = proposeScenes(studio, one.id, [plan("The hum", LINES.hum), plan("A wave", LINES.wave), plan("The mirror", LINES.mirror)]);
  for (const s of first) build(studio, s.id);
  const folder = projectPaths(studio, project).sceneDir(first[1]!.id);
  assert.ok(fs.existsSync(folder));

  // The scriptwriter rewrites the list: retitles the first scene, drops "A wave", and adds one.
  const second = proposeScenes(studio, one.id, [plan("That engine drone", LINES.hum), plan("The mirror", LINES.mirror), plan("Listening first", LINES.mics)]);
  assert.deepEqual(second.map((s) => s.title), ["The hum", "The mirror", "Listening first"], "a built scene keeps the title it was built under");
  assert.equal(second[0]!.id, first[0]!.id, "the retitled scene is the same scene, not a second copy");
  assert.equal(second[1]!.id, first[2]!.id);
  assert.deepEqual(second.removed, [{ id: first[1]!.id, title: "A wave" }]);
  assert.equal(listScenes(studio, project.id).length, 3, "nothing from the old list is left playing after the new one");
  assert.ok(!fs.existsSync(folder), "what was built for the dropped scene is deleted with it");
  studio.close();
});

test("the scene list tool refuses a scene that repeats another, in the same chapter or in another one", async () => {
  const studio = await tempStudio();
  const { project, one, two } = twoChapters(studio);
  proposeScenes(studio, one.id, [plan("The hum", LINES.hum), plan("A wave", LINES.wave)]);
  const run = createRun(studio, { projectId: project.id, kind: "chapter", targetId: two.id, agent: "scriptwriter" });
  const ctx = { studio, projectId: project.id, run, log: () => {} };
  const propose = (scenes: ReturnType<typeof plan>[]) => callTool(ctx, "scenes_propose", { scenes });

  const twice = (await propose([plan("The mirror", LINES.mirror), plan("Upside down", "Play the same wave upside down, and every push meets a pull, so they cancel!")])).output as { saved: boolean; problems: string[] };
  assert.equal(twice.saved, false);
  assert.match(twice.problems[0]!, /"Upside down" says the same as scenes\.0, "The mirror"/);

  const again = (await propose([plan("The mirror", LINES.mirror), plan("Sound is a wave", "Sound is a wave of pressure: pushing the air, and then pulling it back.")])).output as { saved: boolean; problems: string[] };
  assert.equal(again.saved, false);
  assert.match(again.problems[0]!, /says the same as scene 1\.2, "A wave", in another chapter/);
  assert.equal(listScenes(studio, project.id, two.id).length, 0, "a refused list saves nothing");

  const fine = (await propose([plan("The mirror", LINES.mirror), plan("Listening first", LINES.mics)])).output as { saved: boolean };
  assert.equal(fine.saved, true);
  studio.close();
});

test("a scene moves earlier and later, across chapters too, and can be deleted; nothing is built again", async () => {
  const studio = await tempStudio();
  const { project, one, two } = twoChapters(studio);
  const a = proposeScenes(studio, one.id, [plan("The hum", LINES.hum), plan("A wave", LINES.wave)]);
  const b = proposeScenes(studio, two.id, [plan("The mirror", LINES.mirror), plan("Listening first", LINES.mics), plan("Its limits", LINES.limits)]);
  for (const s of [...a, ...b]) build(studio, s.id);
  const versions = () => listScenes(studio, project.id).map((s) => s.currentVersionId).sort();
  const before = versions();
  assert.deepEqual(labels(studio, project.id), ["1.1 The hum", "1.2 A wave", "2.1 The mirror", "2.2 Listening first", "2.3 Its limits"]);

  moveScene(studio, b[2]!.id, "earlier");
  assert.deepEqual(labels(studio, project.id), ["1.1 The hum", "1.2 A wave", "2.1 The mirror", "2.2 Its limits", "2.3 Listening first"]);
  // From the top of chapter 2 into the end of chapter 1, and back.
  moveScene(studio, b[0]!.id, "earlier");
  assert.deepEqual(labels(studio, project.id), ["1.1 The hum", "1.2 A wave", "1.3 The mirror", "2.1 Its limits", "2.2 Listening first"]);
  moveScene(studio, b[0]!.id, "later");
  assert.deepEqual(labels(studio, project.id), ["1.1 The hum", "1.2 A wave", "2.1 The mirror", "2.2 Its limits", "2.3 Listening first"]);
  assert.throws(() => moveScene(studio, a[0]!.id, "earlier"), /already the first scene/);
  assert.throws(() => moveScene(studio, b[1]!.id, "later"), /already the last scene/);
  assert.deepEqual(versions(), before, "moving changes no version");

  // A video joined before the move no longer matches, though every scene in it is unchanged.
  const joined = (order: string[]): Render => ({
    id: newId("rnd"), projectId: project.id, kind: "final", scope: "project", path: "x.mp4", srtPath: null, durationSec: 1, createdAt: nowIso(),
    sceneVersions: order.map((id) => ({ sceneId: id, versionId: getScene(studio, id).currentVersionId!, version: 1, startFrame: 0, frames: 1 })),
  });
  const now = listScenes(studio, project.id).map((s) => s.id);
  assert.equal(scenesChangedSince(studio, joined(now)), 0);
  assert.equal(scenesChangedSince(studio, joined([now[1]!, now[0]!, ...now.slice(2)])), 2, "two scenes are not where the video has them");

  // Deleting: the rest close up, the video made before is out of date, and a scene Claude is working on is left alone.
  const video = joined(now);
  const folder = projectPaths(studio, project).sceneDir(a[1]!.id);
  setSceneStatus(studio, a[1]!.id, "in_production");
  assert.throws(() => deleteScene(studio, a[1]!.id), /Claude is working on this scene/);
  assert.throws(() => moveScene(studio, a[1]!.id, "earlier"), /Claude is working on this scene/);
  setSceneStatus(studio, a[1]!.id, "rendered");
  deleteScene(studio, a[1]!.id);
  assert.deepEqual(labels(studio, project.id), ["1.1 The hum", "2.1 The mirror", "2.2 Its limits", "2.3 Listening first"]);
  assert.ok(!fs.existsSync(folder));
  assert.equal(studio.db.all("SELECT id FROM scene_versions WHERE scene_id = ?", [a[1]!.id]).length, 0);
  assert.equal(scenesChangedSince(studio, video), 1);
  await assert.rejects(assemble(studio, project.id, { quality: "final" }), /needs every scene approved/, "the final video is still held to the scenes that remain");

  // A chapter whose last unapproved scene is deleted is done.
  updateChapter(studio, one.id, { status: "in_production" });
  const extra = addScene(studio, one.id, plan("An extra", LINES.limits));
  studio.db.run("UPDATE scenes SET status = 'approved' WHERE id = ?", [a[0]!.id]);
  deleteScene(studio, extra.id);
  assert.equal(getChapter(studio, one.id).status, "done");
  studio.close();
});

test("the page's requests move and delete a scene, and refuse what cannot be done", async () => {
  const studio = await tempStudio();
  const { project, one } = twoChapters(studio);
  const [hum, wave] = proposeScenes(studio, one.id, [plan("The hum", LINES.hum), plan("A wave", LINES.wave)]);
  const server = await startServer(studio, { port: 0, orchestrator: new NoRenderOrchestrator(studio) });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(server.url + url, { method, headers: { "x-studio": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: (await res.json()) as any };
  };
  try {
    assert.equal((await call("POST", `/api/scenes/${wave!.id}/move`, { direction: "earlier" })).status, 200);
    assert.deepEqual(labels(studio, project.id), ["1.1 A wave", "1.2 The hum"]);
    assert.equal((await call("POST", `/api/scenes/${wave!.id}/move`, { direction: "sideways" })).status, 400);
    const edge = await call("POST", `/api/scenes/${wave!.id}/move`, { direction: "earlier" });
    assert.equal(edge.status, 400);
    assert.match(edge.data.error, /already the first scene/);
    assert.equal((await call("DELETE", `/api/scenes/${hum!.id}`)).status, 200);
    const only = await call("DELETE", `/api/scenes/${wave!.id}`);
    assert.equal(only.status, 400);
    assert.match(only.data.error, /only scene of the video/);
    assert.equal((await call("DELETE", "/api/scenes/sc_nothing")).status, 404);
  } finally {
    await server.close();
    studio.close();
  }
});
