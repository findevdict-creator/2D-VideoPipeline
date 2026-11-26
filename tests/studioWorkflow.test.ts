import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { probe } from "../packages/core/src/studio/media/ffmpeg.js";
import { Lanes } from "../packages/core/src/studio/runs/lanes.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import { mcpConfig } from "../packages/core/src/studio/runs/runner.js";
import { sharedImports } from "../packages/core/src/studio/renderers/remotion.js";
import { importAsset } from "../packages/core/src/studio/store/assets.js";
import { addChapter, listChapters } from "../packages/core/src/studio/store/chapters.js";
import { latestDocument, readDocument } from "../packages/core/src/studio/store/documents.js";
import { createProject, getProject, projectPaths } from "../packages/core/src/studio/store/projects.js";
import { createRun, listRuns, readRunLog } from "../packages/core/src/studio/store/runs.js";
import { currentVersion, getScene, listScenes, listVersions, versionPaths } from "../packages/core/src/studio/store/scenes.js";
import { findShared, listShared, listSharedRequests, readShared, saveShared, sharedVersions } from "../packages/core/src/studio/store/shared.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { callTool, TOOLS } from "../packages/core/src/studio/tools/index.js";
import { Orchestrator } from "../packages/core/src/studio/workflow.js";
import { writeTestCard } from "./helpers/media.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { BROWSER, needsBrowser, SAMPLE_SPEC, tempStudio } from "./helpers/studio.js";

const newProject = (studio: Studio, seconds = 120) => createProject(studio, { description: "How noise-cancelling headphones erase sound with more sound.", targetDurationSec: seconds });

/** Take a project through planning to the point where scenes are being built. */
async function planned(studio: Studio, o: Orchestrator, seconds = 120) {
  const project = newProject(studio, seconds);
  o.startStage(project.id);
  await o.idle();
  for (const stage of ["bible", "foundation", "chapters"]) {
    assert.equal(o.approveStage(project.id).stage, stage);
    await o.idle();
  }
  return project;
}

test("lanes run a fixed number of jobs at once and keep the rest waiting in order", async () => {
  const lanes = new Lanes({ a: 2, b: 1 });
  const order: number[] = [];
  let running = 0;
  let most = 0;
  const job = (n: number) => lanes.run("a", async () => {
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, 15));
    order.push(n);
    running--;
  });
  const all = [1, 2, 3, 4, 5].map(job);
  assert.equal(lanes.busy, true);
  await lanes.idle();
  await Promise.all(all);
  assert.equal(most, 2);
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
  assert.equal(lanes.peak.get("a"), 2);
  // A failing job frees its slot.
  await assert.rejects(lanes.run("b", async () => Promise.reject(new Error("boom"))));
  assert.equal(await lanes.run("b", async () => "next"), "next");
});

test("planning runs stage by stage, each waiting for approval, with shared components built before any scene", async () => {
  const studio = await tempStudio();
  const runner = new MockStudioRunner();
  const o = new NoRenderOrchestrator(studio, runner);
  const project = newProject(studio);

  assert.throws(() => o.approveStage(project.id), /not ready to approve[\s\S]*outline has not been written/);
  o.startStage(project.id);
  assert.throws(() => o.startStage(project.id), /already being worked on/);
  await o.idle();
  assert.equal(getProject(studio, project.id).stage, "outline", "nothing advances without approval");
  const outline = latestDocument(studio, project.id, "outline")!;
  assert.equal(outline.status, "needs_review");
  assert.equal(listChapters(studio, project.id).length, 2);

  // Asking for changes writes a new version of the outline in the same Claude session.
  const [revision] = o.startStage(project.id, "Open with the airplane example");
  await o.idle();
  assert.equal(revision!.task, "revise");
  assert.match(readDocument(studio, latestDocument(studio, project.id, "outline")!), /Open with the airplane example/);
  const outlineRuns = listRuns(studio, project.id).filter((r) => r.targetKind === "outline");
  assert.equal(outlineRuns.length, 2);
  assert.equal(outlineRuns[0]!.payload.resumeFrom, outlineRuns[1]!.claudeSessionId);

  assert.equal(o.approveStage(project.id).stage, "bible");
  await o.idle();
  assert.equal(latestDocument(studio, project.id, "outline", { approvedOnly: true })!.version, 2);
  assert.equal(getProject(studio, project.id).settings.theme.palette.background, "#0B1D33");
  assert.deepEqual(listShared(studio, project.id).map((s) => [s.name, s.status]), [["TopicBadge", "planned"]]);

  assert.equal(o.approveStage(project.id).stage, "foundation");
  assert.equal(o.stageStatus(project.id).running, 1);
  assert.throws(() => o.approveStage(project.id), /still working/);
  await o.idle();
  assert.equal(findShared(studio, project.id, "TopicBadge")!.currentVersion, 1);
  assert.match(readShared(studio, project.id, "TopicBadge")!, /export const TopicBadge/);

  assert.equal(o.approveStage(project.id).stage, "chapters");
  assert.equal(findShared(studio, project.id, "TopicBadge")!.status, "approved");
  await o.idle();
  const scenes = listScenes(studio, project.id);
  assert.equal(scenes.length, 4, "two scenes for each of two chapters");
  assert.ok(scenes.every((s) => s.status === "planned"));
  assert.equal(listRuns(studio, project.id).filter((r) => r.targetKind === "scene").length, 0, "no scene is built before the scene list is approved");

  assert.equal(o.approveStage(project.id).stage, "scenes");
  await o.idle();
  for (const scene of listScenes(studio, project.id)) {
    assert.equal(scene.status, "needs_review", scene.staleReason ?? "");
    const version = currentVersion(studio, scene)!;
    assert.deepEqual(version.spec.uses, [{ name: "TopicBadge", version: 1 }]);
    assert.match(fs.readFileSync(versionPaths(studio, project, version).source!, "utf8"), /@shared\/TopicBadge/);
    assert.ok(version.voiceTrackId, "narration was recorded");
    assert.deepEqual(version.checkProblems, []);
  }
  assert.throws(() => o.approveStage(project.id), /4 of 4 scenes are not approved/);
  for (const scene of listScenes(studio, project.id)) o.approveScene(scene.id);
  assert.equal(o.approveStage(project.id).stage, "assembly");

  // Every run left a log a person can read.
  const run = listRuns(studio, project.id).find((r) => r.targetKind === "scene")!;
  const log = readRunLog(studio, run.id);
  assert.ok(log.lines.some((l) => l.kind === "tool" && l.text === "scene_submit"));
  assert.equal(readRunLog(studio, run.id, log.next).lines.length, 0);
  studio.close();
});

test("scenes are built three at a time, each by its own run, without stepping on each other", async () => {
  const studio = await tempStudio();
  const runner = new MockStudioRunner();
  runner.delayMs = 40;
  const o = new NoRenderOrchestrator(studio, runner);
  // Long enough that renders overlap however busy the machine is.
  o.renderMs = 200;
  // Six chapters make twelve scenes.
  const project = createProject(studio, { description: "How noise-cancelling headphones erase sound with more sound.", targetDurationSec: 120 });
  for (let i = 1; i <= 6; i++) addChapter(studio, project.id, { title: `Part ${i}`, targetDurationSec: 20 });
  const { updateProject } = await import("../packages/core/src/studio/store/projects.js");
  updateProject(studio, project.id, { stage: "chapters" });
  o.startStage(project.id);
  await o.idle();
  assert.equal(o.lanes.peak.get("agents"), 3, "chapter runs also share the lane");
  o.approveStage(project.id);
  await o.idle();

  const scenes = listScenes(studio, project.id);
  assert.equal(scenes.length, 12);
  assert.ok(scenes.every((s) => s.status === "needs_review"));
  assert.equal(o.lanes.peak.get("agents"), 3);
  assert.equal(o.lanes.peak.get("renders"), 2);
  const runs = listRuns(studio, project.id).filter((r) => r.targetKind === "scene");
  assert.equal(runs.length, 12);
  assert.ok(runs.every((r) => r.status === "done"));
  assert.equal(new Set(runs.map((r) => r.targetId)).size, 12, "one run per scene");
  // Runs overlapped in time.
  const overlapped = runs.some((a) => runs.some((b) => a.id !== b.id && a.startedAt! < b.finishedAt! && b.startedAt! < a.finishedAt!));
  assert.ok(overlapped);
  studio.close();
});

test("a run may only change what it owns, and no tool can approve anything", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const project = await planned(studio, o);
  const [mine, other] = listScenes(studio, project.id);
  const run = createRun(studio, { projectId: project.id, kind: "scene", targetId: mine!.id, agent: "scene-builder" });
  const ctx = { studio, projectId: project.id, run, log: () => {} };
  const spec = { ...SAMPLE_SPEC, title: mine!.title, narration: mine!.plan.narration, cues: [] };

  // Its own scene: fine.
  const own = await callTool(ctx, "scene_save_spec", { spec });
  assert.equal(own.output.saved, true, JSON.stringify(own.output));

  // Another scene: reading is allowed, but a write always lands on the run's own scene, whatever the call names.
  assert.equal((await callTool(ctx, "scene_get", { sceneId: other!.id })).ok, true);
  const sneaky = await callTool(ctx, "scene_save_spec", { sceneId: other!.id, spec: { ...spec, title: other!.title, narration: other!.plan.narration } });
  assert.equal(sneaky.output.saved, false, "the other scene's narration is not this scene's");
  assert.equal(getScene(studio, other!.id).currentVersionId, null, "the other scene is untouched");
  assert.equal(getScene(studio, other!.id).status, "planned");

  // The narration the person approved cannot be rewritten, and neither can the scene's type.
  const reworded = await callTool(ctx, "scene_save_spec", { spec: { ...spec, narration: "Something else entirely, said differently." } });
  assert.match(JSON.stringify(reworded.output), /approved this scene's narration/);
  const retyped = await callTool(ctx, "scene_save_spec", { spec: { ...spec, type: "footage", footage: { assetId: "as_x" } } });
  assert.match(JSON.stringify(retyped.output), /may not change its type/);

  // Planning tools belong to planning runs.
  for (const [tool, input] of [
    ["chapters_propose", { chapters: [{ title: "Mine now", goal: "g", targetDurationSec: 120 }] }],
    ["document_save", { kind: "outline", markdown: "A new outline that replaces the approved one entirely." }],
    ["shared_save", { name: "TopicBadge", code: "export const TopicBadge = () => null; // replaced" }],
    ["theme_set", { theme: {} }],
    ["scenes_propose", { scenes: [{ title: "x", type: "remotion-2d", narration: "Some narration here." }] }],
  ] as const) {
    const result = await callTool(ctx, tool, input);
    assert.equal(result.ok, false, tool);
    assert.match(String(result.output.refused), /not yours to call/);
  }
  assert.equal(listChapters(studio, project.id).length, 2);

  // A chapter run owns one chapter's scene list, and nothing of any scene.
  const chapterRun = createRun(studio, { projectId: project.id, kind: "chapter", targetId: listChapters(studio, project.id)[0]!.id, agent: "scriptwriter" });
  assert.match(String((await callTool({ ...ctx, run: chapterRun }, "scene_save_spec", { spec })).output.refused), /not yours to call/);

  // Without a run, a session can read and nothing else.
  const reader = { studio, projectId: project.id, log: () => {} };
  assert.equal((await callTool(reader, "project_get", {})).ok, true);
  assert.match(String((await callTool(reader, "scene_submit", { summary: "no run, no hand-over" })).output.refused), /Only reading is allowed/);

  // A scene can ask for a shared component, which a person then decides on.
  assert.equal((await callTool(ctx, "shared_request", { name: "EarCup", why: "Three scenes show the headphone's ear cup in cross-section." })).ok, true);
  assert.deepEqual(listSharedRequests(studio, project.id, "open").map((r) => [r.name, r.sceneId]), [["EarCup", mine!.id]]);

  // Nothing approves, deletes, or runs commands.
  for (const tool of TOOLS) assert.doesNotMatch(tool.name, /approve|delete|remove|shell|bash|exec|run_/);
  assert.equal(TOOLS.length, 19);
  studio.close();
});

test("the MCP server gives a run its own tools over stdio and applies the same rules", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const project = await planned(studio, o);
  const [mine] = listScenes(studio, project.id);
  const run = createRun(studio, { projectId: project.id, kind: "scene", targetId: mine!.id, agent: "scene-builder" });
  const config = mcpConfig(studio, run).mcpServers.studio;
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...(process.env as Record<string, string>), ...config.env } }));
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ["project_get", "scene_get", "scene_save_spec", "scene_check", "scene_stills", "scene_submit", "asset_view", "shared_get", "shared_request"]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
    for (const name of ["chapters_propose", "document_save", "shared_save", "theme_set", "scenes_propose"]) assert.ok(!names.includes(name), `${name} is not a scene run's tool`);
    const specTool = tools.find((t) => t.name === "scene_save_spec")!;
    assert.match(JSON.stringify(specTool.inputSchema), /"narration"/, "the spec's shape is spelled out for the agent");

    const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
    const got = text(await client.callTool({ name: "scene_get", arguments: {} }));
    assert.equal(got.id, mine!.id);
    assert.ok(got.timing.words.length > 5);
    assert.ok(got.sharedAssets.some((s: { name: string }) => s.name === "TopicBadge"));

    const saved = text(await client.callTool({ name: "scene_save_spec", arguments: { spec: { ...SAMPLE_SPEC, title: mine!.title, narration: mine!.plan.narration, cues: [{ id: "first", phrase: mine!.plan.narration.split(" ").slice(0, 3).join(" ").replace(/[.,]/g, ""), action: "appears" }] } } }));
    assert.equal(saved.saved, true, JSON.stringify(saved));
    assert.equal(saved.cues[0].match, "exact");
    // The write is in the database this process reads.
    assert.equal(currentVersion(studio, getScene(studio, mine!.id))!.spec.cues[0]!.id, "first");

    const refused = await client.callTool({ name: "chapters_propose", arguments: { chapters: [{ title: "Mine", goal: "g", targetDurationSec: 120 }] } });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /not yours to call/);
  } finally {
    await client.close();
  }
  studio.close();
});

test("asking for changes starts a new version and continues the session that built the scene", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const project = await planned(studio, o);
  o.approveStage(project.id);
  await o.idle();
  const [scene, untouched] = listScenes(studio, project.id);
  const first = listRuns(studio, project.id, { targetId: scene!.id })[0]!;
  const v1 = currentVersion(studio, scene!)!;
  const v1File = versionPaths(studio, project, v1).source!;
  const v1Code = fs.readFileSync(v1File, "utf8");
  o.approveScene(scene!.id);
  assert.equal(fs.statSync(v1File).mode & 0o222, 0, "an approved version's code is read-only");

  assert.throws(() => o.reviseScene(scene!.id, "  "), /Say what should change/);
  const run = o.reviseScene(scene!.id, "Make the badge say Anti-noise");
  assert.equal(run.task, "revise");
  assert.equal(run.payload.resumeFrom, first.claudeSessionId);
  assert.equal(getScene(studio, scene!.id).status, "in_production");
  await o.idle();

  const after = getScene(studio, scene!.id);
  assert.equal(after.status, "needs_review");
  assert.equal(after.approvedVersionId, v1.id, "the approved version stays until you approve the new one");
  const versions = listVersions(studio, scene!.id);
  assert.equal(versions.length, 2);
  assert.match(fs.readFileSync(versionPaths(studio, project, versions[1]!).source!, "utf8"), /Anti-noise/);
  assert.equal(fs.readFileSync(v1File, "utf8"), v1Code);
  assert.match(versions[1]!.summary!, /Changed as asked/);
  assert.equal(listRuns(studio, project.id, { targetId: scene!.id })[0]!.claudeSessionId, first.claudeSessionId);
  assert.equal(listVersions(studio, untouched!.id).length, 1, "other scenes are left alone");
  assert.deepEqual((o as NoRenderOrchestrator).rendered.filter((id) => id === untouched!.id).length, 1);
  studio.close();
});

test("changing a shared component marks the scenes built on it stale, and only those", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const project = await planned(studio, o);
  o.approveStage(project.id);
  await o.idle();
  const p = projectPaths(studio, project);
  const scenes = listScenes(studio, project.id);
  const code = fs.readFileSync(versionPaths(studio, project, currentVersion(studio, scenes[0]!)!).source!, "utf8");
  assert.deepEqual(sharedImports(code, p.sharedComponents), [path.join(p.sharedComponents, "TopicBadge.tsx")]);

  // A second component nobody uses yet.
  saveShared(studio, project.id, { name: "EarCup", code: "export const EarCup = () => null;\n", createdBy: "test" });
  assert.ok(listScenes(studio, project.id).every((s) => s.status === "needs_review"));
  const result = saveShared(studio, project.id, { name: "TopicBadge", code: readShared(studio, project.id, "TopicBadge")! + "\n// thicker border\n", createdBy: "test" });
  assert.equal(result.version.version, 2);
  assert.equal(result.staleScenes.length, scenes.length);
  const stale = getScene(studio, scenes[0]!.id);
  assert.equal(stale.status, "stale");
  assert.equal(stale.staleReason, "TopicBadge changed to version 2");
  assert.ok(fs.existsSync(p.abs("shared/versions/TopicBadge/v1.tsx")), "the old version is kept");
  // Rendering again brings a stale scene back up for review.
  await o.renderScene(scenes[0]!.id);
  assert.equal(getScene(studio, scenes[0]!.id).status, "needs_review");
  studio.close();
});

test("a scene whose run fails or never hands over is marked failed with the reason, and can be built again", async () => {
  const studio = await tempStudio();
  const runner = new MockStudioRunner();
  const o = new NoRenderOrchestrator(studio, runner);
  const project = await planned(studio, o);
  const original = runner.run.bind(runner);
  let fail = true;
  runner.run = async (s, req) => {
    if (req.run.targetKind === "scene" && fail) throw new Error("Claude stopped with an error: usage limit reached");
    return original(s, req);
  };
  o.approveStage(project.id);
  await o.idle();
  const scenes = listScenes(studio, project.id);
  assert.ok(scenes.every((s) => s.status === "failed"));
  assert.match(scenes[0]!.staleReason!, /usage limit reached/);
  assert.equal(listRuns(studio, project.id, { targetId: scenes[0]!.id })[0]!.status, "failed");

  fail = false;
  o.startStage(project.id);
  await o.idle();
  assert.ok(listScenes(studio, project.id).every((s) => s.status === "needs_review"));
  studio.close();
});

test("from a description to a finished video: plan, build, review, revise one scene, assemble", needsBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER } });
  const runner = new MockStudioRunner();
  runner.stills = true;
  const o = new Orchestrator(studio, runner);
  const project = createProject(studio, { description: "How noise-cancelling headphones erase sound with more sound.", targetDurationSec: 30 });
  const card = path.join(studio.workspaceDir, "card.png");
  writeTestCard(card);
  await importAsset(studio, project.id, card, { label: "Headphone cutaway" });

  o.startStage(project.id);
  await o.idle();
  for (const stage of ["bible", "foundation", "chapters", "scenes"]) {
    assert.equal(o.approveStage(project.id).stage, stage);
    await o.idle();
  }
  const p = projectPaths(studio, project);
  const badge = sharedVersions(studio, findShared(studio, project.id, "TopicBadge")!.id)[0]!;
  assert.ok(fs.statSync(p.abs(badge.previewPath!)).size > 1000, "the shared component has a picture to approve it by");
  const scenes = listScenes(studio, project.id);
  assert.deepEqual(scenes.map((s) => s.type), ["remotion-2d", "remotion-2d", "illustration"]);
  for (const scene of scenes) {
    assert.equal(scene.status, "needs_review", scene.staleReason ?? "");
    const version = currentVersion(studio, scene)!;
    assert.ok(version.stills.length > 0, "the agent looked at stills");
    const review = await probe(versionPaths(studio, project, version).review("preview"));
    assert.equal(review.frames, version.durationFrames);
    assert.equal(review.hasAudio, true, "the review copy has the narration");
    o.approveScene(scene.id);
  }

  // Revise one scene: only that scene is built and rendered again.
  o.reviseScene(scenes[1]!.id, "Say Anti-noise on the badge");
  await o.idle();
  assert.equal(getScene(studio, scenes[1]!.id).status, "needs_review");
  const jobs = studio.db.all<{ kind: string; target_id: string; status: string }>("SELECT kind, target_id, status FROM jobs WHERE project_id = ? ORDER BY queued_at, id", [project.id]);
  assert.deepEqual(jobs.map((j) => j.status), ["done", "done", "done", "done"]);
  assert.equal(jobs.filter((j) => j.target_id === scenes[1]!.id).length, 2);
  o.approveScene(scenes[1]!.id);

  assert.equal(o.approveStage(project.id).stage, "assembly");
  const started = Date.now();
  const preview = await o.assemble(project.id);
  assert.ok(Date.now() - started < 60_000, "joining finished clips takes seconds");
  assert.equal(preview.rendered, 0);
  assert.equal(preview.render.sceneVersions[1]!.version, 2);
  const video = await probe(preview.file);
  assert.equal(video.frames, preview.render.sceneVersions.reduce((n, s) => n + s.frames, 0));
  assert.ok(fs.existsSync(p.abs(preview.render.srtPath!)));

  const final = await o.assemble(project.id, { quality: "final" });
  assert.equal((await probe(final.file)).width, project.width);
  assert.equal(o.approveStage(project.id).stage, "done");
  studio.close();
});
