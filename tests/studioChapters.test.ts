import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../packages/server/src/server.js";
import { projectSnapshot } from "../packages/server/src/snapshot.js";
import { probe } from "../packages/core/src/studio/media/ffmpeg.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import type { StudioRunRequest } from "../packages/core/src/studio/runs/runner.js";
import { getChapter, listChapters } from "../packages/core/src/studio/store/chapters.js";
import { createProject, getProject } from "../packages/core/src/studio/store/projects.js";
import { listRuns } from "../packages/core/src/studio/store/runs.js";
import { currentVersion, listScenes } from "../packages/core/src/studio/store/scenes.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { Orchestrator } from "../packages/core/src/studio/workflow.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { BROWSER, needsBrowser, tempStudio } from "./helpers/studio.js";

const DESCRIPTION = "How noise-cancelling headphones erase sound with more sound.";

/** Wait for something that background work brings about. */
async function until(what: string, condition: () => boolean, timeoutMs = 20_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) assert.fail(`Timed out waiting until ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Plan a video up to the point where its scene lists start being written. */
async function upToSceneLists(studio: Studio, o: Orchestrator, seconds: number) {
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: seconds });
  o.startStage(project.id);
  await o.idle();
  assert.equal(o.approveStage(project.id).stage, "bible");
  await o.idle();
  assert.equal(o.approveStage(project.id).stage, "foundation");
  await o.idle();
  return project;
}

const statuses = (studio: Studio, projectId: string) => listChapters(studio, projectId).map((c) => c.status);

test("a 10-minute video is planned and built chapter by chapter", async () => {
  const studio = await tempStudio();
  const runner = new MockStudioRunner();
  runner.scenesPerChapter = 3;
  const o = new NoRenderOrchestrator(studio, runner);
  const project = await upToSceneLists(studio, o, 600);
  const chapters = listChapters(studio, project.id);
  assert.equal(chapters.length, 5, "about two minutes a chapter");
  assert.equal(chapters.reduce((n, c) => n + c.targetDurationSec, 0), 600);
  assert.deepEqual(statuses(studio, project.id), ["planned", "planned", "planned", "planned", "planned"]);

  assert.equal(o.approveStage(project.id).stage, "chapters");
  await o.idle();
  // Scene lists were written in order, one at a time, so each could read the ones before it.
  const written = listRuns(studio, project.id).filter((r) => r.targetKind === "chapter").reverse();
  assert.deepEqual(written.map((r) => r.targetId), chapters.map((c) => c.id));
  for (let i = 1; i < written.length; i++) assert.ok(written[i]!.startedAt! >= written[i - 1]!.finishedAt!, "one chapter at a time");
  assert.equal(o.lanes.peak.get("agents"), 1);
  assert.deepEqual(statuses(studio, project.id), Array(5).fill("script_review"));
  assert.equal(listScenes(studio, project.id).length, 15);

  // Approve and build one chapter after another.
  for (const [i, chapter] of chapters.entries()) {
    assert.equal(getProject(studio, project.id).stage, "chapters", "planning is not over until the last scene list is approved");
    assert.equal(o.approveChapter(chapter.id).status, "in_production");
    await o.idle();
    const scenes = listScenes(studio, project.id);
    for (const scene of scenes) {
      const built = listChapters(studio, project.id).findIndex((c) => c.id === scene.chapterId) <= i;
      assert.equal(scene.status === "planned", !built, `${scene.title} is ${scene.status}`);
      assert.equal(Boolean(currentVersion(studio, scene)?.voiceTrackId), built, "narration is recorded for approved chapters only");
    }
    assert.throws(() => o.approveChapter(chapter.id), /already approved/);
    // Review this chapter's scenes: with the last one approved, the chapter is done.
    const mine = scenes.filter((s) => s.chapterId === chapter.id);
    assert.ok(mine.every((s) => s.status === "needs_review"));
    for (const scene of mine.slice(0, -1)) o.approveScene(scene.id);
    assert.equal(getChapter(studio, chapter.id).status, "in_production");
    o.approveScene(mine.at(-1)!.id);
    assert.equal(getChapter(studio, chapter.id).status, "done");
  }
  assert.equal(getProject(studio, project.id).stage, "scenes", "approving the last scene list ends planning");
  assert.deepEqual(o.stageStatus(project.id).waitingOn, []);

  // Asking for a change to a scene reopens its chapter until the scene is approved again.
  const first = listScenes(studio, project.id)[0]!;
  o.reviseScene(first.id, "Make the badge larger");
  assert.equal(getChapter(studio, first.chapterId).status, "in_production");
  await o.idle();
  o.approveScene(first.id);
  assert.equal(getChapter(studio, first.chapterId).status, "done");
  assert.equal(o.approveStage(project.id).stage, "assembly");
  assert.equal(listRuns(studio, project.id).filter((r) => r.targetKind === "scene" && r.task === "build").length, 15, "every scene was built once");
  studio.close();
});

/** A runner whose chapter runs can be held back, to stand in for a chapter that takes a long time to write. */
class GatedRunner extends MockStudioRunner {
  private readonly gates = new Map<number, { open: () => void; wait: Promise<void> }>();
  hold(position: number) {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => (open = resolve));
    this.gates.set(position, { open, wait });
  }
  release(position: number) {
    this.gates.get(position)?.open();
    this.gates.delete(position);
  }
  override async run(studio: Studio, req: StudioRunRequest) {
    if (req.run.targetKind === "chapter") await this.gates.get(getChapter(studio, req.run.targetId!).position)?.wait;
    return super.run(studio, req);
  }
}

test("you can approve chapter 1's scenes while chapter 3 is still being written", async () => {
  const studio = await tempStudio();
  const runner = new GatedRunner();
  const o = new NoRenderOrchestrator(studio, runner);
  const project = await upToSceneLists(studio, o, 600);
  const [one, two, three] = listChapters(studio, project.id);
  runner.hold(3);
  assert.equal(o.approveStage(project.id).stage, "chapters");
  await until("chapter 3 is being written", () => listRuns(studio, project.id, { active: true }).some((r) => r.targetId === three!.id && r.status === "running"));
  assert.deepEqual(statuses(studio, project.id), ["script_review", "script_review", "scripting", "planned", "planned"]);
  assert.throws(() => o.approveChapter(three!.id), /still being written/);

  // Chapter 1: approve the list, let its scenes build, review them.
  o.approveChapter(one!.id);
  await until("chapter 1's scenes are built", () => listScenes(studio, project.id, one!.id).every((s) => s.status === "needs_review"));
  assert.equal(o.stageStatus(project.id).running, 1, "only the scene list still being written counts against this stage");
  for (const scene of listScenes(studio, project.id, one!.id)) o.approveScene(scene.id);
  assert.deepEqual(statuses(studio, project.id), ["done", "script_review", "scripting", "planned", "planned"]);
  assert.equal(getProject(studio, project.id).stage, "chapters");
  assert.throws(() => o.approveStage(project.id), /Chapter 3[\s\S]*has no scenes yet/);

  // Chapter 2: ask for changes to its list. That does not start chapter 4 early.
  o.reviseChapter(two!.id, "Open with the airplane hum");
  assert.equal(getChapter(studio, two!.id).status, "scripting");
  await until("chapter 2 is rewritten", () => getChapter(studio, two!.id).status === "script_review");
  assert.deepEqual(statuses(studio, project.id), ["done", "script_review", "scripting", "planned", "planned"]);
  assert.ok(listScenes(studio, project.id, two!.id).every((s) => s.status === "planned"), "nothing of chapter 2 is built before its list is approved");

  // The rest is written once chapter 3 gets through, and everything left is approved in one go.
  runner.release(3);
  await o.idle();
  assert.deepEqual(statuses(studio, project.id), ["done", "script_review", "script_review", "script_review", "script_review"]);
  assert.equal(o.approveStage(project.id).stage, "scenes");
  await o.idle();
  assert.deepEqual(statuses(studio, project.id), ["done", "in_production", "in_production", "in_production", "in_production"]);
  const scenes = listScenes(studio, project.id);
  assert.equal(scenes.length, 10);
  assert.deepEqual(scenes.map((s) => s.status), [...Array(2).fill("approved"), ...Array(8).fill("needs_review")]);
  assert.ok(scenes.slice(0, 2).every((s) => currentVersion(studio, s)!.version === 1), "the finished chapter was left alone");

  // An approved list that is changed goes back up for approval, and holds the scenes stage until it is.
  o.reviseChapter(two!.id, "Add nothing, just tighten the wording");
  await o.idle();
  assert.equal(getChapter(studio, two!.id).status, "script_review");
  assert.match(o.stageStatus(project.id).waitingOn.join("\n"), /scene list of chapter 2.*waiting for your approval/);
  assert.equal(o.approveChapter(two!.id).status, "in_production");
  await o.idle();
  studio.close();
});

test("chapters are approved, built and reported over the API one at a time", async () => {
  const studio = await tempStudio();
  const runner = new MockStudioRunner();
  const o = new NoRenderOrchestrator(studio, runner);
  const server = await startServer(studio, { port: 0, orchestrator: o });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(server.url + url, { method, headers: { "x-studio": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as any };
  };
  try {
    const project = await upToSceneLists(studio, o, 120);
    o.approveStage(project.id);
    await o.idle();
    const at = `/api/projects/${project.slug}`;
    let snap = (await call("GET", at)).data;
    assert.deepEqual(snap.chapters.map((c: any) => [c.position, c.status, c.preview]), [[1, "script_review", null], [2, "script_review", null]]);
    const [one, two] = snap.chapters;

    assert.equal((await call("POST", `/api/chapters/${one.id}/build`, {})).status, 400, "not before the list is approved");
    const approved = await call("POST", `/api/chapters/${one.id}/approve`, {});
    assert.deepEqual(approved.data, { status: "in_production", stage: "chapters" });
    await o.idle();
    snap = (await call("GET", at)).data;
    assert.deepEqual(snap.scenes.map((s: any) => s.status), ["needs_review", "needs_review", "planned", "planned"]);
    assert.equal(snap.stage.stage, "chapters");
    assert.deepEqual(snap.stage.waitingOn, [], "the remaining list can be approved from the stage bar too");

    // A scene of the approved chapter fails; one request builds whatever is left of that chapter.
    const { setSceneStatus } = await import("../packages/core/src/studio/store/scenes.js");
    setSceneStatus(studio, snap.scenes[0].id, "failed", "Rendering failed");
    assert.equal((await call("POST", `/api/chapters/${one.id}/build`, {})).status, 200);
    await o.idle();
    assert.equal(listScenes(studio, project.id)[0]!.status, "needs_review");

    assert.deepEqual((await call("POST", `/api/chapters/${two.id}/approve`, {})).data, { status: "in_production", stage: "scenes" });
    await o.idle();
    assert.equal((await call("POST", `/api/chapters/${two.id}/approve`, {})).status, 400);
    assert.equal((await call("POST", "/api/chapters/no-such-chapter/approve", {})).status, 404);
  } finally {
    await server.close();
    studio.close();
  }
});

test("a chapter can be watched by itself while the next one is still waiting for approval", needsBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER } });
  const runner = new MockStudioRunner();
  runner.stills = false;
  const o = new Orchestrator(studio, runner);
  const project = await upToSceneLists(studio, o, 120);
  o.approveStage(project.id);
  await o.idle();
  const [one, two] = listChapters(studio, project.id);
  await assert.rejects(o.previewChapter(one!.id), /No scene could be included[\s\S]*not built yet/);

  o.approveChapter(one!.id);
  await o.idle();
  const mine = listScenes(studio, project.id, one!.id);
  assert.ok(mine.every((s) => s.status === "needs_review"), mine.map((s) => s.staleReason).join("; "));
  const preview = await o.previewChapter(one!.id);
  assert.equal(preview.rendered, 0, "the clips made for review are the ones joined");
  assert.equal(preview.render.scope, one!.id);
  assert.match(preview.file, /-chapter-1-preview-/);
  assert.deepEqual(preview.render.sceneVersions.map((v) => v.sceneId), mine.map((s) => s.id));
  const video = await probe(preview.file);
  assert.equal(video.frames, mine.reduce((n, s) => n + currentVersion(studio, s)!.durationFrames!, 0));
  assert.equal(video.hasAudio, true);

  let snap = projectSnapshot(studio, o, project.id);
  assert.equal(snap.chapters[0]!.preview!.current, true);
  assert.match(snap.chapters[0]!.preview!.url!, /chapter-1-preview/);
  assert.equal(snap.chapters[1]!.preview, null);
  assert.ok(listScenes(studio, project.id, two!.id).every((s) => s.status === "planned"));

  // While a scene is being rebuilt the preview is marked as behind, and a new one leaves the half-built scene out.
  o.reviseScene(mine[0]!.id, "Make the badge larger");
  snap = projectSnapshot(studio, o, project.id);
  assert.equal(snap.chapters[0]!.preview!.current, false);
  const during = await o.previewChapter(one!.id);
  assert.deepEqual(during.skipped.map((s) => [s.sceneId, s.reason]), [[mine[0]!.id, "still being built"]]);
  await o.idle();
  const after = await o.previewChapter(one!.id);
  assert.equal(after.render.sceneVersions[0]!.version, 2);
  studio.close();
});
