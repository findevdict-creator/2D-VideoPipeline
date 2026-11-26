import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assemble, listRenders } from "../packages/core/src/studio/assemble.js";
import { FileServer } from "../packages/core/src/studio/media/fileServer.js";
import { probe } from "../packages/core/src/studio/media/ffmpeg.js";
import { layVoiceTrack, readWav, resample, writeWav } from "../packages/core/src/studio/media/wav.js";
import { fitFootage } from "../packages/core/src/studio/renderers/sceneData.js";
import { availableSceneTypes } from "../packages/core/src/studio/renderers/registry.js";
import { checkScene, clipCacheKey, qualitySettings, renderSceneClip, renderSceneStills, sceneContext } from "../packages/core/src/studio/scenes/render.js";
import { addChapter } from "../packages/core/src/studio/store/chapters.js";
import { createProject, projectPaths } from "../packages/core/src/studio/store/projects.js";
import { addScene, approveScene, currentVersion, findScene, getScene, reviseScene, saveSpec, versionPaths } from "../packages/core/src/studio/store/scenes.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { BROWSER, needsBrowser, SAMPLE_SPEC, sceneCode, tempStudio } from "./helpers/studio.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "studio-media-"));

/** A project with `count` short code scenes, each with its spec saved and its code written. */
function codeProject(studio: Studio, count: number) {
  const project = createProject(studio, { description: "How GPS finds you", targetDurationSec: 60 });
  const chapter = addChapter(studio, project.id, { title: "Only chapter" });
  const scenes = Array.from({ length: count }, (_, i) => {
    const scene = addScene(studio, chapter.id, { title: `Scene ${i + 1}`, type: "remotion-2d", narration: SAMPLE_SPEC.narration });
    const saved = saveSpec(studio, scene.id, { ...SAMPLE_SPEC, title: `Scene ${i + 1}` }, "test");
    assert.ok(saved.ok);
    fs.writeFileSync(versionPaths(studio, project, saved.version).source!, sceneCode(`Scene ${i + 1}`));
    return getScene(studio, scene.id);
  });
  return { project, chapter, scenes };
}

test("WAV files are read back as written, at any sample rate", () => {
  const dir = tmp();
  const samples = Int16Array.from({ length: 2400 }, (_, i) => Math.round(Math.sin(i / 10) * 12000));
  writeWav(path.join(dir, "a.wav"), { sampleRate: 24000, samples });
  const back = readWav(path.join(dir, "a.wav"));
  assert.equal(back.sampleRate, 24000);
  assert.deepEqual([...back.samples.slice(0, 50)], [...samples.slice(0, 50)]);
  assert.equal(resample(back, 48000).samples.length, 4800);
});

test("narration is laid on the frame grid, so scenes rounded to frames never drift", () => {
  const dir = tmp();
  // Three clips of 1.01s at 30 fps: each scene is 30 frames, each clip 10ms longer than its scene.
  const clip = { sampleRate: 24000, samples: new Int16Array(24240).fill(1000) };
  const items = [0, 1, 2].map((i) => {
    const file = path.join(dir, `${i}.wav`);
    writeWav(file, clip);
    return { file, startFrame: i * 30, frames: 30 };
  });
  const out = layVoiceTrack(items, 30, path.join(dir, "out.wav"));
  assert.equal(out.samples.length, 72000, "exactly 3 seconds");
  assert.equal(readWav(path.join(dir, "out.wav")).samples.length, 72000);
  // A short clip leaves silence before the next scene starts.
  writeWav(items[0]!.file, { sampleRate: 24000, samples: new Int16Array(12000).fill(1000) });
  const padded = layVoiceTrack(items, 30, path.join(dir, "out2.wav"));
  assert.equal(padded.samples[11999], 1000);
  assert.equal(padded.samples[12000], 0);
  assert.equal(padded.samples[24000], 1000, "scene 2 starts on its frame");
});

test("a clip shorter than its scene is fitted by the rule the spec names", () => {
  const base = { inSec: 0, minSpeed: 0.7 };
  // 7 seconds of scene, 4 seconds of footage, 30 fps.
  const long = fitFootage({ ...base, fit: "trim" }, 20, 210, 30);
  assert.deepEqual(long, { trimBeforeFrames: 0, playbackRate: 1, coveredFrames: 210, after: "hold" });

  const hold = fitFootage({ ...base, fit: "hold" }, 4, 210, 30);
  assert.equal(hold.playbackRate, 1);
  assert.equal(hold.coveredFrames, 119);
  assert.equal(hold.after, "hold");

  const slow = fitFootage({ ...base, fit: "slow" }, 4, 210, 30);
  assert.equal(slow.playbackRate, 0.7, "never slower than minSpeed");
  assert.equal(slow.coveredFrames, 170);
  assert.equal(slow.after, "hold");

  const slight = fitFootage({ ...base, fit: "slow" }, 6.5, 210, 30);
  assert.ok(slight.playbackRate > 0.9 && slight.playbackRate < 1);
  assert.ok(slight.coveredFrames >= 208);

  const loop = fitFootage({ ...base, fit: "loop" }, 4, 210, 30);
  assert.equal(loop.after, "loop");
  assert.equal(loop.coveredFrames, 119);

  const windowed = fitFootage({ inSec: 2, outSec: 5, minSpeed: 0.7, fit: "hold" }, 20, 210, 30);
  assert.equal(windowed.trimBeforeFrames, 60);
  assert.equal(windowed.coveredFrames, 89);
});

test("the file server serves project files with ranges and refuses paths outside its folder", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "p", "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "p", "assets", "a b.txt"), "0123456789");
  fs.writeFileSync(path.join(os.tmpdir(), "outside.txt"), "secret");
  const server = await FileServer.start(dir);
  try {
    const ok = await fetch(`${server.baseUrl}/p/assets/a%20b.txt`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "0123456789");
    const part = await fetch(`${server.baseUrl}/p/assets/a%20b.txt`, { headers: { range: "bytes=2-5" } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "2345");
    assert.equal((await fetch(`${server.baseUrl}/p/missing.txt`)).status, 404);
    const escape = await fetch(`${server.baseUrl}/..%2F..%2F${path.basename(os.tmpdir())}/outside.txt`);
    assert.notEqual(escape.status, 200);
  } finally {
    server.close();
  }
});

test("a clip's cache key changes with the scene's code or spec, and with nothing else", async () => {
  const studio = await tempStudio();
  const { project, scenes } = codeProject(studio, 2);
  const key = async (sceneId: string) => clipCacheKey(await sceneContext(studio, sceneId), qualitySettings(studio, "preview"));
  const [a1, b1] = [await key(scenes[0]!.id), await key(scenes[1]!.id)];
  assert.equal(await key(scenes[0]!.id), a1, "stable when nothing changes");
  assert.notEqual(a1, b1);

  const version = currentVersion(studio, getScene(studio, scenes[0]!.id))!;
  fs.writeFileSync(versionPaths(studio, project, version).source!, sceneCode("Changed"));
  assert.notEqual(await key(scenes[0]!.id), a1, "code changed");
  assert.equal(await key(scenes[1]!.id), b1, "the other scene is untouched");

  const final = clipCacheKey(await sceneContext(studio, scenes[1]!.id), qualitySettings(studio, "final"));
  assert.notEqual(await final, b1, "preview and final are different clips");
  studio.close();
});

test("checking a scene reports code problems before anything is rendered", async () => {
  const studio = await tempStudio();
  const { project, scenes } = codeProject(studio, 1);
  const scene = scenes[0]!;
  assert.deepEqual(await checkScene(studio, scene.id), []);

  const file = versionPaths(studio, project, currentVersion(studio, scene)!).source!;
  fs.writeFileSync(file, sceneCode("x") + `\nconst wrong: number = "text";\n`);
  const typeProblems = await checkScene(studio, scene.id);
  assert.equal(typeProblems.length, 1);
  assert.match(typeProblems[0]!, /^scene\.tsx\(\d+,\d+\): error TS2322/);
  assert.deepEqual(currentVersion(studio, getScene(studio, scene.id))!.checkProblems, typeProblems);

  fs.writeFileSync(file, `import fs from "node:fs";\n` + sceneCode("x"));
  assert.match((await checkScene(studio, scene.id)).join("\n"), /node:fs/);
  studio.close();
});

test("scene types without a renderer yet are not offered", () => {
  const types = availableSceneTypes();
  assert.deepEqual(types.sort(), ["footage", "illustration", "r3f", "remotion-2d"]);
});

test("final assembly refuses scenes you have not approved", async () => {
  const studio = await tempStudio();
  const { project } = codeProject(studio, 2);
  await assert.rejects(assemble(studio, project.id, { quality: "final" }), /needs every scene approved[\s\S]*1\.1 Scene 1: not approved yet/);
  studio.close();
});

test("each scene renders to its own clip, one change re-renders one clip, and the video is the clips joined", needsBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER } });
  const { project, scenes } = codeProject(studio, 3);
  const p = projectPaths(studio, project);
  const fps = project.fps;

  // Stills first: the quick look an agent takes before a full render.
  const stills = await renderSceneStills(studio, scenes[0]!.id, { cues: ["sat"] });
  assert.equal(stills.length, 1);
  assert.ok(fs.statSync(p.abs(stills[0]!.file)).size > 1000);

  const first = await assemble(studio, project.id);
  assert.equal(first.rendered, 3);
  assert.equal(first.reused, 0);
  assert.deepEqual(first.skipped, []);
  let total = 0;
  for (const scene of scenes) {
    const ctx = await sceneContext(studio, scene.id);
    const expected = ctx.data.scenes[0]!.durationInFrames;
    const clip = (await renderSceneClip(studio, scene.id)).clip;
    const info = await probe(p.abs(clip.path));
    assert.equal(info.frames, expected, "the clip is exactly as long as its narration");
    assert.equal(info.hasAudio, false);
    assert.equal(getScene(studio, scene.id).status, "rendered");
    total += expected;
  }
  const video = await probe(first.file);
  assert.equal(video.frames, total);
  assert.ok(Math.abs(video.durationSec! - total / fps) < 0.05);
  assert.equal(video.hasAudio, true);
  assert.deepEqual(first.render.sceneVersions.map((s) => s.startFrame), [0, first.render.sceneVersions[0]!.frames, first.render.sceneVersions[0]!.frames + first.render.sceneVersions[1]!.frames]);
  assert.match(fs.readFileSync(p.abs(first.render.srtPath!), "utf8"), /^1\n00:00:0\d,\d{3} --> /);

  // Nothing changed: nothing is rendered.
  const again = await assemble(studio, project.id);
  assert.equal(again.rendered, 0);
  assert.equal(again.reused, 3);

  // Change one scene through a revision: only its clip is rendered.
  const before = scenes.map((s) => fs.statSync(versionPaths(studio, project, currentVersion(studio, s)!).clip("preview")).mtimeMs);
  approveScene(studio, scenes[1]!.id);
  const v2 = reviseScene(studio, scenes[1]!.id, "make the title say something else");
  fs.writeFileSync(versionPaths(studio, project, v2).source!, sceneCode("A different title"));
  const third = await assemble(studio, project.id);
  assert.equal(third.rendered, 1);
  assert.equal(third.reused, 2);
  assert.equal(third.render.sceneVersions[1]!.version, 2);
  for (const i of [0, 2]) {
    const file = versionPaths(studio, project, currentVersion(studio, scenes[i]!)!).clip("preview");
    assert.equal(fs.statSync(file).mtimeMs, before[i], "untouched clips are not rewritten");
  }
  assert.equal((await probe(third.file)).frames, total);

  // With approved versions only, scene 2 goes back to version 1 and the others are left out.
  const approved = await assemble(studio, project.id, { approvedOnly: true });
  assert.equal(approved.rendered, 0);
  assert.deepEqual(approved.render.sceneVersions.map((s) => s.version), [1]);
  assert.equal(approved.skipped.length, 2);
  assert.equal(listRenders(studio, project.id).length, 4);
  assert.equal(findScene(studio, project.id, "2").id, scenes[1]!.id);
  studio.close();
});
