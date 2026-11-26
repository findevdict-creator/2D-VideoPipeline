import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { CaptionPage } from "../packages/lib/src/types.js";
import { startServer } from "../packages/server/src/server.js";
import { assemble } from "../packages/core/src/studio/assemble.js";
import { EXPORT_FORMATS, exportFormat, exportSize, exportVideo, listExports, reframeLayout, refitPages, timestamp } from "../packages/core/src/studio/export.js";
import { ffmpeg, probe } from "../packages/core/src/studio/media/ffmpeg.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import { captionPages } from "../packages/core/src/studio/renderers/sceneData.js";
import { compareVersions, diffLines, diffWords } from "../packages/core/src/studio/scenes/compare.js";
import { listChapters } from "../packages/core/src/studio/store/chapters.js";
import { getClip } from "../packages/core/src/studio/store/clips.js";
import { createProject, projectPaths } from "../packages/core/src/studio/store/projects.js";
import { currentVersion, getScene, listScenes, listVersions, rollbackScene, saveSpec, setSceneStatus, versionPaths } from "../packages/core/src/studio/store/scenes.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { getVoiceTrack } from "../packages/core/src/studio/voice.js";
import { Orchestrator } from "../packages/core/src/studio/workflow.js";
import { rawPixels } from "./helpers/media.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { BROWSER, needsBrowser, tempStudio } from "./helpers/studio.js";

const DESCRIPTION = "How noise-cancelling headphones erase sound with more sound.";

/** Plan a video and build its scenes with the stand-in runner. */
async function built(studio: Studio, o: Orchestrator, seconds: number) {
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: seconds });
  o.startStage(project.id);
  await o.idle();
  for (const stage of ["bible", "foundation", "chapters", "scenes"]) {
    assert.equal(o.approveStage(project.id).stage, stage);
    await o.idle();
  }
  return project;
}

test("differences are found word by word and line by line", () => {
  const words = diffWords("Each satellite carries a clock.", "Each satellite carries an atomic clock.");
  assert.deepEqual(words[0], { op: "same", text: "Each satellite carries " });
  assert.deepEqual(words.filter((p) => p.op === "removed").map((p) => p.text), ["a"]);
  assert.deepEqual(words.filter((p) => p.op === "added").map((p) => p.text.trim()), ["an", "atomic"]);
  assert.deepEqual(words.at(-1), { op: "same", text: "clock." });
  assert.equal(words.filter((p) => p.op !== "added").map((p) => p.text).join(""), "Each satellite carries a clock.", "what stayed and what went give the old text back");
  assert.equal(words.filter((p) => p.op !== "removed").map((p) => p.text).join(""), "Each satellite carries an atomic clock.", "what stayed and what came give the new text back");
  assert.deepEqual(diffWords("Same words.", "Same words."), [{ op: "same", text: "Same words." }]);
  assert.deepEqual(diffWords("", "New."), [{ op: "added", text: "New." }]);

  const lines = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
  assert.deepEqual(lines, [
    { op: "same", text: "a" },
    { op: "removed", text: "b" },
    { op: "added", text: "B" },
    { op: "same", text: "c\nd" },
    { op: "added", text: "e" },
  ]);
});

test("a picture is placed in a taller, a square and a wider frame, and long captions are cut to fit", () => {
  const hd = { width: 1920, height: 1080 };
  assert.deepEqual(exportSize(hd, "shorts"), { width: 1080, height: 1920 });
  assert.deepEqual(exportSize(hd, "square"), { width: 1080, height: 1080 });
  assert.deepEqual(exportSize(hd, "landscape"), hd);
  assert.deepEqual(exportSize({ width: 640, height: 360 }, "shorts"), { width: 360, height: 640 });
  assert.equal(exportFormat("9:16"), "shorts");
  assert.equal(exportFormat("Vertical"), "shorts");
  assert.equal(exportFormat("square"), "square");
  assert.throws(() => exportFormat("cinema"), /not an export format.*landscape, shorts, square/);
  assert.equal(timestamp(0), "0:00");
  assert.equal(timestamp(75.9), "1:15");
  assert.equal(timestamp(3723), "1:02:03");

  // 9:16: the whole picture across the width, captions in a band under it, clear of the bottom fifth where a phone app draws its own buttons.
  const shorts = reframeLayout(hd, { width: 1080, height: 1920 }, { captions: true, fontSize: 54 });
  assert.deepEqual({ x: shorts.picture.x, width: shorts.picture.width, height: shorts.picture.height }, { x: 0, width: 1080, height: 608 });
  assert.equal(shorts.zoom, 1);
  const c = shorts.captions!;
  assert.ok(c.y >= shorts.picture.y + shorts.picture.height, "the captions are under the picture, not on it");
  assert.ok(c.y + c.height <= 1920 * 0.8, `the captions end at ${c.y + c.height}, above the bottom fifth`);
  assert.ok(shorts.picture.y >= 1920 * 0.08);
  assert.ok(c.fontSize > 54, "captions are larger on a phone held upright");
  assert.ok(c.x >= 0 && c.x + c.width <= 1080);

  // Zooming in crops the sides and never pushes the captions out of their band.
  const closer = reframeLayout(hd, { width: 1080, height: 1920 }, { zoom: 1.5, captions: true, fontSize: 54 });
  assert.equal(closer.picture.width, 1620);
  assert.equal(closer.picture.x, -270);
  assert.ok(closer.captions!.y + closer.captions!.height <= 1920 * 0.8);
  const tooClose = reframeLayout(hd, { width: 1080, height: 1920 }, { zoom: 2, captions: true, fontSize: 54 });
  assert.ok(tooClose.zoom < 2 && tooClose.zoom > 1.5, `a zoom that leaves no room for captions is held back, here to ${tooClose.zoom}`);
  assert.ok(tooClose.captions!.y + tooClose.captions!.height <= 1920 * 0.8 + 1);
  const noCaptions = reframeLayout(hd, { width: 1080, height: 1920 }, { zoom: 2, captions: false, fontSize: 54 });
  assert.equal(noCaptions.captions, null);
  assert.equal(noCaptions.zoom, 2, "without captions the picture may take their room");

  // Square: the same idea with less room.
  const square = reframeLayout(hd, { width: 1080, height: 1080 }, { captions: true, fontSize: 54 });
  assert.equal(square.picture.width, 1080);
  assert.ok(square.captions!.y >= square.picture.y + square.picture.height);
  assert.ok(square.captions!.y + square.captions!.height <= 1080);

  // A wider frame than the picture: full height, bars at the sides, captions across the bottom.
  const wide = reframeLayout({ width: 1080, height: 1920 }, hd, { zoom: 1.5, captions: true, fontSize: 54 });
  assert.deepEqual(wide.picture, { x: 656, y: 0, width: 608, height: 1080 });
  assert.equal(wide.zoom, 1);
  assert.ok(wide.captions!.y + wide.captions!.height <= 1080);

  // A caption page too long for two lines becomes two, split between words, each word keeping its time.
  const token = (text: string, startFrame: number) => ({ text, startFrame, endFrame: startFrame + 10 });
  const page: CaptionPage = { startFrame: 0, endFrame: 62, tokens: [token(" Every", 0), token(" satellite", 10), token(" carries", 20), token(" an", 30), token(" atomic", 40), token(" clock", 50)] };
  assert.deepEqual(refitPages([page], 100), [page], "a page that fits is left alone");
  const cut = refitPages([page], 24);
  assert.equal(cut.length, 2);
  assert.deepEqual(cut.map((p) => p.tokens.map((t) => t.text).join("")), [" Every satellite carries", " an atomic clock"]);
  assert.equal(cut.flatMap((p) => p.tokens).length, 6, "no word is lost");
  assert.deepEqual(cut.flatMap((p) => p.tokens), page.tokens, "and none is moved in time");
  assert.equal(cut[0]!.startFrame, 0);
  assert.equal(cut[0]!.endFrame, cut[1]!.startFrame, "the second part takes over when its first word is spoken");
  assert.equal(cut[1]!.endFrame, 62);
  for (const part of cut) assert.ok(part.tokens.reduce((n, t) => n + t.text.length, 0) <= 24, `"${part.tokens.map((t) => t.text).join("")}" fits`);
  assert.equal(refitPages([{ startFrame: 0, endFrame: 9, tokens: [token(" Supercalifragilistic", 0)] }], 5).length, 1, "a single long word stays whole");
});

test("two versions of a scene are compared: what was asked, and what changed in the plan, the narration and the code", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const server = await startServer(studio, { port: 0, orchestrator: o });
  const get = async (url: string) => {
    const res = await fetch(`${server.url}${url}`, { headers: { "x-studio": "1" } });
    return { status: res.status, data: (await res.json()) as any };
  };
  try {
    const project = await built(studio, o, 60);
    const scene = listScenes(studio, project.id)[0]!;
    o.approveScene(scene.id);
    o.reviseScene(scene.id, "Make the label larger");
    await o.idle();
    assert.equal(listVersions(studio, scene.id).length, 2);

    // The stand-in runner rewrote the scene file and left the plan alone.
    const code = compareVersions(studio, scene.id, 1, 2);
    assert.deepEqual([code.before, code.after], [1, 2]);
    assert.deepEqual(code.asked.map((a) => [a.version, a.notes]), [[1, "Make the label larger"]]);
    assert.deepEqual(code.changes.map((c) => c.what), ["Scene file"]);
    assert.ok(code.code && code.code.added > 0 && code.code.removed > 0);
    assert.ok(code.code!.parts.some((p) => p.op === "added" && /Make the label larger/.test(p.text)), "the new lines are there to read");
    assert.deepEqual(code.narration.map((p) => p.op), ["same"]);
    assert.deepEqual(compareVersions(studio, scene.id, 2, 1).changes, code.changes, "the order the versions are named in does not matter");
    assert.deepEqual(compareVersions(studio, scene.id, 2, 2).changes, [], "a version is the same as itself");
    assert.throws(() => compareVersions(studio, scene.id, 1, 5), /no version 5/);

    // A change to the words and the plan shows up as such.
    const v2 = currentVersion(studio, getScene(studio, scene.id))!;
    const saved = saveSpec(studio, scene.id, { ...v2.spec, title: "A new title", narration: `${v2.spec.narration} And that is the whole trick.`, sfx: [] }, "test");
    assert.ok(saved.ok && saved.version.version === 2);
    const plan = compareVersions(studio, scene.id, 1, 2);
    const changed = Object.fromEntries(plan.changes.map((c) => [c.what, c]));
    assert.deepEqual(Object.keys(changed).sort(), ["Narration", "Scene file", "Sound effects", "Title"]);
    assert.equal(changed.Title!.after, "A new title");
    assert.match(changed["Sound effects"]!.before, /pop on "first"/);
    assert.equal(changed["Sound effects"]!.after, "none");
    assert.deepEqual(plan.narration.at(-1), { op: "added", text: " And that is the whole trick." });

    // The page gets both versions with what each looks like.
    const page = await get(`/api/scenes/${scene.id}/compare?a=2&b=1`);
    assert.equal(page.status, 200);
    assert.deepEqual(page.data.versions.map((v: any) => v.version), [1, 2]);
    assert.equal(page.data.asked[0].notes, "Make the label larger");
    assert.equal((await get(`/api/scenes/${scene.id}/compare?a=1`)).status, 400);

    // Going back is refused while a run is at work on the scene, and allowed otherwise.
    const status = getScene(studio, scene.id).status;
    setSceneStatus(studio, scene.id, "in_production");
    assert.throws(() => rollbackScene(studio, scene.id, 1), /working on this scene/);
    setSceneStatus(studio, scene.id, status);
    const back = rollbackScene(studio, scene.id, 1);
    assert.equal(back.status, "approved");
    assert.equal(currentVersion(studio, back)!.version, 1);
  } finally {
    await server.close();
    o.stop();
    studio.close();
  }
});

test("with real rendering: going back to a version reuses its clip, and the same project exports as 16:9, 9:16 and square", needsBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER, resolution: 360 } } as never);
  const runner = new MockStudioRunner();
  runner.stills = false;
  const o = new Orchestrator(studio, runner);
  const project = await built(studio, o, 100);
  const p = projectPaths(studio, project);
  assert.deepEqual([project.width, project.height], [640, 360]);
  const scenes = listScenes(studio, project.id);
  assert.equal(scenes.length, 4);
  await assert.rejects(exportVideo(studio, project.id, { format: "shorts" }), /needs every scene approved/, "only an approved video is exported");
  for (const scene of scenes) o.approveScene(scene.id);

  // --- Going back to an earlier version ---
  const first = scenes[0]!;
  const made = await assemble(studio, project.id, { quality: "final", concurrency: 2 });
  assert.equal(made.rendered, 4);
  const v1 = currentVersion(studio, getScene(studio, first.id))!;
  const v1Clip = p.abs(getClip(studio, v1.id, "final")!.path);
  const v1Written = fs.statSync(v1Clip).mtimeMs;
  const v1Review = versionPaths(studio, project, v1).review("preview");
  assert.ok(fs.existsSync(v1Review));

  o.reviseScene(first.id, "Make the label larger");
  await o.idle();
  o.approveScene(first.id);
  const changed = await assemble(studio, project.id, { quality: "final", concurrency: 2 });
  assert.deepEqual([changed.rendered, changed.reused], [1, 3], "only the changed scene is rendered for the new video");
  assert.equal(changed.render.sceneVersions[0]!.version, 2);

  const back = rollbackScene(studio, first.id, 1);
  assert.equal(back.status, "approved", "version 1 was approved, so it is again");
  assert.equal(back.approvedVersionId, v1.id);
  const restored = await assemble(studio, project.id, { quality: "final", concurrency: 2 });
  assert.deepEqual([restored.rendered, restored.reused], [0, 4], "going back renders nothing");
  assert.equal(restored.render.sceneVersions[0]!.version, 1);
  assert.equal(fs.statSync(v1Clip).mtimeMs, v1Written, "the clip of version 1 is the file that was made the first time");
  assert.ok(fs.existsSync(v1Review), "and its review copy is still there to watch");
  assert.equal(listVersions(studio, first.id).length, 2, "version 2 is kept, and can be gone back to as well");

  // --- The same video in three shapes ---
  const background = hex(project.settings.theme.palette.background);
  const text = hex(project.settings.theme.palette.text);
  const near = (a: number[], b: number[], within: number) => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!) <= within;
  /** The share of a box's pixels that pass a test, in one frame of a video. */
  const share = async (file: string, size: { width: number; height: number }, sec: number, box: { x: number; y: number; width: number; height: number }, test: (rgb: number[]) => boolean) => {
    const raw = await rawPixels(ffmpeg, file, sec);
    assert.equal(raw.length, size.width * size.height * 3);
    let hits = 0;
    let all = 0;
    for (let y = Math.max(0, box.y); y < Math.min(size.height, box.y + box.height); y++) {
      for (let x = Math.max(0, box.x); x < Math.min(size.width, box.x + box.width); x++) {
        const o = (y * size.width + x) * 3;
        all++;
        if (test([raw[o]!, raw[o + 1]!, raw[o + 2]!])) hits++;
      }
    }
    return hits / Math.max(1, all);
  };
  // A moment in the first scene when a caption is on screen.
  const track = getVoiceTrack(studio, v1.voiceTrackId!)!;
  const pages = captionPages(studio, track, project.fps, {});
  const spoken = pages[Math.min(1, pages.length - 1)]!;
  const sec = (spoken.startFrame + spoken.endFrame) / 2 / project.fps;

  const wide = await exportVideo(studio, project.id, { concurrency: 2 });
  assert.equal(wide.export.format, "landscape", "without a format, the shape the video was built in");
  assert.deepEqual([wide.rendered, wide.reused], [0, 4], "the shape it was built in needs no rendering");
  const wideInfo = await probe(wide.file);
  assert.deepEqual([wideInfo.width, wideInfo.height], [640, 360]);

  const tall = await exportVideo(studio, project.id, { format: "shorts", concurrency: 2 });
  assert.deepEqual([tall.rendered, tall.reused], [4, 0]);
  const tallInfo = await probe(tall.file);
  assert.deepEqual([tallInfo.width, tallInfo.height], [360, 640], "9:16 from the same project");
  assert.ok(tallInfo.hasAudio);
  assert.ok(Math.abs(tallInfo.durationSec! - wideInfo.durationSec!) < 0.05, "the same length as the 16:9 video");
  assert.equal(tallInfo.frames, wideInfo.frames);
  assert.deepEqual(tall.export.sceneVersions.map((v) => [v.version, v.startFrame, v.frames]), wide.export.sceneVersions.map((v) => [v.version, v.startFrame, v.frames]));
  assert.equal(listVersions(studio, first.id).length, 2, "no scene was built again for it");

  const size = { width: 360, height: 640 };
  const layout = reframeLayout(project, size, { captions: true, fontSize: studio.config.render.captions.fontSize });
  const isText = (rgb: number[]) => near(rgb, text, 60);
  const isBackground = (rgb: number[]) => near(rgb, background, 30);
  const above = await share(tall.file, size, sec, { x: 0, y: 0, width: 360, height: layout.picture.y - 2 }, isBackground);
  assert.ok(above > 0.999, `above the picture there is only the background (${above.toFixed(4)})`);
  const drawn = await share(tall.file, size, sec, layout.picture, (rgb) => !isBackground(rgb));
  assert.ok(drawn > 0.003, `the scene is drawn in the picture's place (${drawn.toFixed(4)})`);
  const captioned = await share(tall.file, size, sec, layout.captions!, isText);
  assert.ok(captioned > 0.02, `the captions are in their band under the picture (${captioned.toFixed(4)})`);
  // In 16:9 the captions sit on the bottom of the picture. In 9:16 that part of the picture is free of them.
  const strip = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x, y: Math.round(box.y + box.height * 0.76), width: box.width, height: Math.round(box.height * 0.22) });
  const burned = await share(wide.file, { width: 640, height: 360 }, sec, strip({ x: 0, y: 0, width: 640, height: 360 }), isText);
  const clean = await share(tall.file, size, sec, strip(layout.picture), isText);
  assert.ok(burned > 0.01, `the 16:9 video has its captions on the picture (${burned.toFixed(4)})`);
  assert.ok(clean < burned / 5, `the 9:16 picture has none on it (${clean.toFixed(4)} against ${burned.toFixed(4)})`);

  // The package: everything an upload needs, in one folder.
  const e = tall.export;
  assert.equal(e.folder, `exports/${path.basename(tall.folder)}`);
  for (const file of [e.files.video, e.files.subtitles, e.files.thumbnail!, e.files.description, e.files.manifest]) assert.ok(fs.statSync(p.abs(file)).size > 0, file);
  assert.equal(path.dirname(p.abs(e.files.subtitles)), tall.folder);
  assert.match(fs.readFileSync(p.abs(e.files.subtitles), "utf8"), /^1\n00:00:0\d,\d+ --> /);
  const chapters = listChapters(studio, project.id);
  assert.equal(chapters.length, 2);
  const secondStarts = wide.export.sceneVersions[2]!.startFrame / project.fps;
  const description = fs.readFileSync(p.abs(e.files.description), "utf8");
  assert.ok(description.startsWith(`${project.title}\n\n${DESCRIPTION}\n`));
  assert.ok(description.includes(`Chapters\n0:00 ${chapters[0]!.title}\n${timestamp(secondStarts)} ${chapters[1]!.title}\n`), description);
  const manifest = JSON.parse(fs.readFileSync(p.abs(e.files.manifest), "utf8"));
  assert.deepEqual([manifest.format, manifest.shape, manifest.width, manifest.height, manifest.zoom], ["shorts", "9:16", 360, 640, 1]);
  assert.equal(manifest.scenes.length, 4);
  assert.equal(manifest.files.video, path.basename(tall.file));
  const thumb = await probe(p.abs(e.files.thumbnail!));
  assert.deepEqual([thumb.width, thumb.height], [360, 640]);

  // A second export of the same shape renders nothing; another framing renders only the placing, not the scenes.
  const again = await exportVideo(studio, project.id, { format: "shorts", concurrency: 2 });
  assert.deepEqual([again.rendered, again.reused], [0, 4]);
  assert.notEqual(again.folder, tall.folder, "each export has a folder of its own");

  // One chapter, as a square, a little closer.
  const part = await exportVideo(studio, project.id, { format: "square", chapterId: chapters[1]!.id, zoom: 1.1, concurrency: 2 });
  const partInfo = await probe(part.file);
  assert.deepEqual([partInfo.width, partInfo.height], [360, 360]);
  assert.equal(part.export.sceneVersions.length, 2);
  assert.equal(part.export.scope, chapters[1]!.id);
  const partDescription = fs.readFileSync(p.abs(part.export.files.description), "utf8");
  assert.ok(partDescription.startsWith(`${project.title}: ${chapters[1]!.title}\n`));
  assert.ok(!partDescription.includes("Chapters"), "one chapter has no chapter list");
  await assert.rejects(exportVideo(studio, project.id, { format: "shorts", zoom: 5 }), /zoom is a number from 1/);
  const held = await exportVideo(studio, project.id, { format: "square", chapterId: chapters[1]!.id, zoom: 2, concurrency: 2 });
  assert.match(held.export.notes.join(" "), /no room for captions/);

  assert.deepEqual(listExports(studio, project.id).map((x) => x.format), ["square", "square", "shorts", "shorts", "landscape"]);
  assert.ok(EXPORT_FORMATS.shorts.about.length > 0);
  o.stop();
  studio.close();
});

function hex(colour: string): number[] {
  const n = parseInt(colour.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
