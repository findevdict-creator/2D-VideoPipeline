import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { importProduction } from "../packages/core/src/studio/importProduction.js";
import { newId } from "../packages/core/src/studio/ids.js";
import { parseSpec } from "../packages/core/src/studio/model/scene.js";
import { addChapter, listChapters, proposeChapters } from "../packages/core/src/studio/store/chapters.js";
import { saveClip } from "../packages/core/src/studio/store/clips.js";
import { approveDocument, latestDocument, readDocument, saveDocument } from "../packages/core/src/studio/store/documents.js";
import { createProject, getProject, projectPaths } from "../packages/core/src/studio/store/projects.js";
import {
  addScene,
  approveScene,
  getScene,
  listScenes,
  listVersions,
  proposeScenes,
  reviseScene,
  rollbackScene,
  saveSpec,
  sceneLabel,
} from "../packages/core/src/studio/store/scenes.js";
import { cueFrames, ensureVoice } from "../packages/core/src/studio/voice.js";
import { REPO, SAMPLE_SPEC, tempStudio } from "./helpers/studio.js";

const TABLES = [
  "projects", "documents", "chapters", "scenes", "scene_versions", "voice_tracks", "clips", "assets", "project_references",
  "shared_assets", "shared_asset_versions", "scene_dependencies", "shared_asset_requests", "reviews", "agent_runs", "jobs", "renders", "events",
];

test("a fresh workspace gets a database with every table", async () => {
  const studio = await tempStudio();
  assert.ok(fs.existsSync(path.join(studio.workspaceDir, "studio.db")));
  const names = studio.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  for (const table of TABLES) assert.ok(names.includes(table), `missing table ${table}`);
  studio.close();
});

test("ids sort by creation time", () => {
  const a = newId("sc", 1_000_000);
  const b = newId("sc", 2_000_000);
  assert.ok(a < b);
  assert.match(a, /^sc_[0-9a-z]{14}$/);
});

test("a project can be up to 60 minutes long, and no longer", async () => {
  const studio = await tempStudio();
  const p = createProject(studio, { description: "How light travels through a camera lens", targetDurationSec: 3600 });
  assert.equal(p.targetDurationSec, 3600);
  assert.equal(p.width, 1920);
  assert.equal(p.settings.theme.palette.background, "#0F172A");
  assert.throws(() => createProject(studio, { description: "A video that is far too long", targetDurationSec: 3601 }));
  const again = createProject(studio, { description: "How light travels through a camera lens" });
  assert.notEqual(again.slug, p.slug, "two projects never share a folder");
  studio.close();
});

test("the GPS example imports as a project with 7 scenes and their versions", async () => {
  const studio = await tempStudio();
  const result = await importProduction(studio, path.join(REPO, "examples", "how-gps-works"));
  assert.equal(result.scenes, 7);
  assert.equal(result.withCode, 7);
  const scenes = listScenes(studio, result.project.id);
  assert.equal(scenes.length, 7);
  assert.deepEqual(scenes.map((s) => sceneLabel(studio, s)), ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7"]);
  const paths = projectPaths(studio, result.project);
  for (const scene of scenes) {
    assert.equal(scene.status, "spec_ready");
    const versions = listVersions(studio, scene.id);
    assert.equal(versions.length, 1);
    assert.ok(fs.existsSync(paths.abs(versions[0]!.sourcePath!)), "scene code was copied");
    assert.ok(versions[0]!.sourceHash);
  }
  assert.equal(result.project.settings.theme.fontFamily.length > 0, true);
  studio.close();
});

test("two processes can write to the database at the same time", async () => {
  const studio = await tempStudio();
  const script = `
    import { Db } from ${JSON.stringify(path.join(REPO, "packages/core/src/studio/db/connection.ts"))};
    const db = new Db(process.argv[2]);
    for (let i = 0; i < 200; i++) {
      db.tx(() => db.run("INSERT INTO events (kind, data_json, created_at) VALUES (?, '{}', ?)", [process.argv[3], new Date().toISOString()]));
    }
    db.close();
  `;
  const file = path.join(studio.workspaceDir, "writer.mts");
  fs.writeFileSync(file, script);
  const tsx = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const runWriter = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [tsx, file, studio.db.file, name], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
  await Promise.all([runWriter("a"), runWriter("b"), runWriter("c")]);
  const count = studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")!.n;
  assert.equal(count, 600);
  studio.close();
});

test("a spec is refused when a cue is not in the narration, or an id repeats", () => {
  const ok = parseSpec(SAMPLE_SPEC);
  assert.ok(ok.ok);
  const bad = parseSpec({ ...SAMPLE_SPEC, cues: [{ id: "sat", phrase: "a phrase nobody says" }, { id: "sat", phrase: "Each satellite" }] });
  assert.ok(!bad.ok);
  assert.equal(bad.problems.length, 2);
  const footage = parseSpec({ ...SAMPLE_SPEC, type: "footage" });
  assert.ok(!footage.ok, "a footage scene needs its footage section");
  const overlay = parseSpec({ ...SAMPLE_SPEC, overlays: [{ kind: "label", text: "Clock", x: 0.5, y: 0.2, at: { cue: "nope" } }] });
  assert.ok(!overlay.ok && /no cue/.test(overlay.problems[0]!));
});

test("scene versions: save, revise, approve only after a render, and roll back", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: "How GPS finds your phone" });
  const chapter = addChapter(studio, project.id, { title: "The idea" });
  const scene = addScene(studio, chapter.id, { title: "Satellites send time", type: "remotion-2d", narration: SAMPLE_SPEC.narration });
  assert.equal(scene.status, "planned");

  const refused = saveSpec(studio, scene.id, { ...SAMPLE_SPEC, cues: [{ id: "x", phrase: "not said" }] }, "test");
  assert.ok(!refused.ok);
  assert.equal(listVersions(studio, scene.id).length, 0, "a refused spec changes nothing");

  const v1 = saveSpec(studio, scene.id, SAMPLE_SPEC, "test");
  assert.ok(v1.ok);
  assert.equal(v1.version.version, 1);
  assert.equal(getScene(studio, scene.id).status, "spec_ready");
  const again = saveSpec(studio, scene.id, { ...SAMPLE_SPEC, purpose: "Edited" }, "test");
  assert.ok(again.ok && again.version.version === 1, "saving again edits the open version");

  assert.throws(() => approveScene(studio, scene.id), /Render the scene/);
  saveClip(studio, { sceneVersionId: v1.version.id, quality: "preview", cacheKey: "k", path: "scenes/x/clip.mp4", durationFrames: 90, width: 960, height: 540 });
  assert.equal(approveScene(studio, scene.id).status, "approved");

  const v2 = reviseScene(studio, scene.id, "Make the satellite bigger");
  assert.equal(v2.version, 2);
  assert.equal(v2.spec.purpose, "Edited", "the spec is carried forward");
  assert.equal(getScene(studio, scene.id).status, "spec_ready");
  assert.equal(getScene(studio, scene.id).approvedVersionId, v1.version.id, "the approved version stays approved until the new one is");

  const back = rollbackScene(studio, scene.id, 1);
  assert.equal(back.status, "approved");
  assert.equal(back.currentVersionId, v1.version.id);

  const frozen = saveSpec(studio, scene.id, { ...SAMPLE_SPEC, purpose: "After approval" }, "test");
  assert.ok(frozen.ok && frozen.version.version === 3, "an approved version is frozen: saving starts a new one");
  studio.close();
});

test("re-planning keeps scenes and chapters that have work in them", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: "How GPS finds your phone" });
  proposeChapters(studio, project.id, [{ title: "Intro" }, { title: "Clocks" }, { title: "Recap" }]);
  const [intro] = listChapters(studio, project.id);
  const plan = (title: string) => ({ title, type: "remotion-2d" as const, narration: "Some words to say here." });
  const first = proposeScenes(studio, intro!.id, [plan("Hook"), plan("Question")]);
  saveSpec(studio, first[1]!.id, { ...SAMPLE_SPEC, title: "Question" }, "test");
  const second = proposeScenes(studio, intro!.id, [plan("New opener"), plan("Hook")]);
  assert.deepEqual(second.map((s) => s.title), ["New opener", "Hook", "Question"], "the worked-on scene moves to the end instead of vanishing");
  const chapters = proposeChapters(studio, project.id, [{ title: "Clocks" }, { title: "Recap" }]);
  assert.deepEqual(chapters.map((c) => c.title), ["Clocks", "Recap", "Intro"]);
  studio.close();
});

test("documents are versioned and wait for approval", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: "How GPS finds your phone" });
  const d1 = saveDocument(studio, project.id, "outline", "# Outline v1", { createdBy: "run_1" });
  assert.equal(d1.status, "needs_review");
  assert.equal(latestDocument(studio, project.id, "outline", { approvedOnly: true }), undefined);
  approveDocument(studio, d1.id);
  const d2 = saveDocument(studio, project.id, "outline", "# Outline v2", { createdBy: "run_2" });
  assert.equal(d2.version, 2);
  const approved = latestDocument(studio, project.id, "outline", { approvedOnly: true })!;
  assert.equal(readDocument(studio, approved).trim(), "# Outline v1", "the approved version stays until the new one is approved");
  studio.close();
});

test("narration is recorded once and reused, and cues are timed in frames", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: "How GPS finds your phone" });
  const chapter = addChapter(studio, project.id, { title: "The idea" });
  const scene = addScene(studio, chapter.id, { title: "Satellites", type: "remotion-2d", narration: SAMPLE_SPEC.narration });
  const saved = saveSpec(studio, scene.id, SAMPLE_SPEC, "test");
  assert.ok(saved.ok);
  const logs: string[] = [];
  const first = (await ensureVoice(studio, [scene.id], (m) => logs.push(m))).get(scene.id)!;
  assert.ok(fs.existsSync(projectPaths(studio, getProject(studio, project.id)).abs(first.audioPath)));
  assert.equal(logs.length, 1);
  const second = (await ensureVoice(studio, [scene.id], (m) => logs.push(m))).get(scene.id)!;
  assert.equal(second.id, first.id);
  assert.equal(logs.length, 1, "nothing is recorded the second time");
  const version = listVersions(studio, scene.id)[0]!;
  assert.equal(version.voiceTrackId, first.id);
  assert.equal(version.durationFrames, Math.round(first.durationSec * project.fps));
  const cues = cueFrames(saved.version.spec.cues, first, project.fps, {});
  assert.equal(cues[0]!.match, "exact");
  assert.ok(cues[1]!.startFrame > cues[0]!.startFrame);
  studio.close();
});
