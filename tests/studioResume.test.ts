import { test } from "node:test";
import assert from "node:assert/strict";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import type { StudioRunRequest } from "../packages/core/src/studio/runs/runner.js";
import { createProject } from "../packages/core/src/studio/store/projects.js";
import { CLOSED_MID_RUN, createRun, getRun, listRuns, updateRun } from "../packages/core/src/studio/store/runs.js";
import { currentVersion, getScene, listScenes, reviseScene, setSceneStatus } from "../packages/core/src/studio/store/scenes.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { tempStudio } from "./helpers/studio.js";

const DESCRIPTION = "How noise-cancelling headphones erase sound with more sound.";

/** A runner whose runs can be held open until the studio stops them, like a long Claude run. */
function holdingRunner() {
  const runner = new MockStudioRunner();
  const requests: StudioRunRequest[] = [];
  const original = runner.run.bind(runner);
  let hold = true;
  runner.run = async (studio: Studio, req: StudioRunRequest) => {
    requests.push(req);
    if (!hold) return original(studio, req);
    req.onSession(req.resumeSessionId ?? `session-of-${req.run.id}`);
    await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("Cancelled");
  };
  return { runner, requests, release: () => (hold = false) };
}

const started = async (studio: Studio, projectId: string) => {
  while (!listRuns(studio, projectId).some((r) => r.status === "running")) await new Promise((r) => setTimeout(r, 5));
};

test("a run the studio's closing cuts short continues in the same session when it is started again; one you stop starts over", async () => {
  const studio = await tempStudio();
  const { runner, requests, release } = holdingRunner();
  const first = new NoRenderOrchestrator(studio, runner);
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 60 });
  first.startStage(project.id);
  await started(studio, project.id);
  first.stop();
  await first.idle();
  const cut = listRuns(studio, project.id)[0]!;
  assert.equal(cut.status, "failed");
  assert.equal(cut.error, CLOSED_MID_RUN);
  assert.equal(first.stageStatus(project.id).running, 0);

  // The studio is opened again, and the stage started again with nothing new to say.
  const second = new NoRenderOrchestrator(studio, runner);
  release();
  const [run] = second.startStage(project.id);
  await second.idle();
  assert.equal(run!.payload.continued, true);
  assert.equal(run!.payload.resumeFrom, cut.claudeSessionId);
  const req = requests.at(-1)!;
  assert.equal(req.resumeSessionId, cut.claudeSessionId, "the same Claude session is resumed");
  assert.match(req.prompt, /^You were stopped part-way through this task because the studio was closed/);
  assert.equal(getRun(studio, run!.id).status, "done");
  assert.deepEqual(second.stageStatus(project.id).waitingOn, []);

  // Stopped on purpose: the next start is a fresh one, and not told it was cut short.
  const other = await tempStudio();
  const held = holdingRunner();
  const o = new NoRenderOrchestrator(other, held.runner);
  const p2 = createProject(other, { description: DESCRIPTION, targetDurationSec: 60 });
  o.startStage(p2.id);
  await started(other, p2.id);
  o.cancel(listRuns(other, p2.id)[0]!.id);
  await o.idle();
  assert.equal(listRuns(other, p2.id)[0]!.status, "cancelled");
  held.release();
  const [fresh] = o.startStage(p2.id);
  await o.idle();
  assert.equal(fresh!.payload.continued, undefined);
  assert.equal(held.requests.at(-1)!.resumeSessionId, undefined);
  studio.close();
  other.close();
});

test("after the studio was killed part-way, renders are not left running and each scene says how to pick it up", async () => {
  const studio = await tempStudio();
  const runner = new MockStudioRunner();
  let o = new NoRenderOrchestrator(studio, runner);
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 60 });
  o.startStage(project.id);
  await o.idle();
  for (const stage of ["bible", "foundation", "chapters", "scenes"]) {
    assert.equal(o.approveStage(project.id).stage, stage);
    await o.idle();
  }
  const [rendering, building] = listScenes(studio, project.id);
  assert.ok(rendering && building);

  // What a studio closed by force leaves behind: a scene whose render was cut short after Claude handed it over,
  // a revision Claude was still working on, its run still marked as running, and a join still marked as running.
  setSceneStatus(studio, rendering.id, "in_production");
  reviseScene(studio, building.id, "Make the waves blue");
  setSceneStatus(studio, building.id, "in_production");
  const run = createRun(studio, { projectId: project.id, kind: "scene", targetId: building.id, agent: "scene-builder", task: "revise", notes: "Make the waves blue" });
  updateRun(studio, run.id, { status: "running", claudeSessionId: "session-mid-revision" });
  studio.db.run("INSERT INTO jobs (id, project_id, kind, target_id, status, queued_at) VALUES ('job_left', ?, 'assemble', NULL, 'running', '2026-01-01T00:00:00Z')", [project.id]);

  o = new NoRenderOrchestrator(studio, runner);
  const job = studio.db.get<{ status: string; error: string }>("SELECT status, error FROM jobs WHERE id = 'job_left'")!;
  assert.equal(job.status, "failed", "the Video tab is not left waiting on a join that will never finish");
  assert.match(job.error, /studio was closed/);
  assert.equal(getScene(studio, rendering.id).status, "stale");
  assert.match(getScene(studio, rendering.id).staleReason!, /being rendered\. Render it again/);
  assert.equal(getScene(studio, building.id).status, "failed");
  assert.match(getScene(studio, building.id).staleReason!, /Continue building/);
  assert.equal(getRun(studio, run.id).error, CLOSED_MID_RUN);

  // Rendering it again needs no Claude run.
  const runsBefore = listRuns(studio, project.id).length;
  o.rebuildStale(project.id);
  await o.idle();
  assert.equal(getScene(studio, rendering.id).status, "needs_review");
  assert.equal(listRuns(studio, project.id).length, runsBefore);

  // Building it again continues the revision, with its notes, in the session that was making it.
  const version = currentVersion(studio, getScene(studio, building.id))!.version;
  const next = o.buildScene(building.id);
  await o.idle();
  assert.equal(next.task, "revise");
  assert.deepEqual(next.payload, { notes: "Make the waves blue", resumeFrom: "session-mid-revision", continued: true });
  assert.equal(currentVersion(studio, getScene(studio, building.id))!.version, version, "it carries on with the version it had started, not a new one");
  assert.equal(getScene(studio, building.id).status, "needs_review");
  studio.close();
});
