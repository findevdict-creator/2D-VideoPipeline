import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assetPreview } from "../packages/core/src/studio/assets/preview.js";
import { assemble } from "../packages/core/src/studio/assemble.js";
import { ffmpeg, probe } from "../packages/core/src/studio/media/ffmpeg.js";
import { imageSize } from "../packages/core/src/studio/media/imageSize.js";
import { renderSceneClip, sceneContext } from "../packages/core/src/studio/scenes/render.js";
import { checkSpecAssets } from "../packages/core/src/studio/scenes/validate.js";
import { assetUsage, deleteAsset, importAsset, listAssets, listProjectReferences, setProjectReference } from "../packages/core/src/studio/store/assets.js";
import { addChapter } from "../packages/core/src/studio/store/chapters.js";
import { createProject, projectPaths, updateProject } from "../packages/core/src/studio/store/projects.js";
import { addScene, saveSpec, versionPaths } from "../packages/core/src/studio/store/scenes.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { COUNTER_SCENE, pixelAt, quarterOf, writeTestCard } from "./helpers/media.js";
import { BROWSER, needsBrowser, tempStudio } from "./helpers/studio.js";

// 18 words: about 7.6 seconds with the mock voice.
const NARRATION = "Light enters the lens and bends toward the sensor where millions of tiny wells count the arriving photons.";
const BASE = {
  title: "Light meets the sensor",
  narration: NARRATION,
  visual: { description: "A lens and a sensor, seen from the side" },
  cues: [{ id: "bend", phrase: "bends toward the sensor", action: "the camera moves to the sensor" }],
};

function emptyProject(studio: Studio) {
  const project = createProject(studio, { description: "How light travels through a camera", targetDurationSec: 60 });
  const chapter = addChapter(studio, project.id, { title: "Only chapter" });
  return { project, chapter, p: projectPaths(studio, project) };
}

function testCard(name = "card.png") {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "studio-asset-")), name);
  writeTestCard(file);
  return file;
}

test("a file is stored once, measured, and can be marked as a reference for the whole video", async () => {
  const studio = await tempStudio();
  const { project, p } = emptyProject(studio);
  const card = testCard();
  const asset = await importAsset(studio, project.id, card, { label: "Lens diagram" });
  assert.equal(asset.kind, "image");
  assert.equal(asset.width, 1600);
  assert.equal(asset.height, 1000);
  assert.ok(fs.existsSync(p.abs(asset.path)));
  assert.equal((await importAsset(studio, project.id, card)).id, asset.id, "the same file again is the same asset");
  assert.equal(listAssets(studio, project.id).length, 1);

  setProjectReference(studio, project.id, { assetId: asset.id, role: "style", note: "flat colours, thick outlines" });
  assert.deepEqual(listProjectReferences(studio, project.id), [{ assetId: asset.id, role: "style", note: "flat colours, thick outlines" }]);
  setProjectReference(studio, project.id, { assetId: asset.id, role: null });
  assert.deepEqual(listProjectReferences(studio, project.id), []);

  // An image small enough to look at is shown as it is.
  assert.deepEqual(await assetPreview(studio, asset.id, { maxSide: 2000 }), [{ file: p.abs(asset.path) }]);
  const small = await assetPreview(studio, asset.id, { maxSide: 400 });
  assert.equal((await probe(small[0]!.file)).width, 400);
  studio.close();
});

test("WebP and SVG images are measured without ffprobe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-size-"));
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0);
  webp.write("WEBPVP8X", 8);
  webp.writeUIntLE(1279, 24, 3);
  webp.writeUIntLE(719, 27, 3);
  fs.writeFileSync(path.join(dir, "a.webp"), webp);
  assert.deepEqual(imageSize(path.join(dir, "a.webp")), { width: 1280, height: 720 });
  fs.writeFileSync(path.join(dir, "a.svg"), `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect/></svg>`);
  assert.deepEqual(imageSize(path.join(dir, "a.svg")), { width: 800, height: 450 });
  fs.writeFileSync(path.join(dir, "b.svg"), `<svg width="64px" height="32" viewBox="0 0 8 4"></svg>`);
  assert.deepEqual(imageSize(path.join(dir, "b.svg")), { width: 64, height: 32 });
  fs.writeFileSync(path.join(dir, "c.txt"), "not an image");
  assert.equal(imageSize(path.join(dir, "c.txt")), undefined);
});

test("a spec may only name assets that exist in the project and are the right kind of file", async () => {
  const studio = await tempStudio();
  const { project, chapter } = emptyProject(studio);
  const image = await importAsset(studio, project.id, testCard());
  const scene = addScene(studio, chapter.id, { title: "Lens", type: "illustration", narration: NARRATION });
  const check = (spec: object) => saveSpec(studio, scene.id, spec, "test", (s) => checkSpecAssets(studio, project.id, s));

  const missing = check({ type: "illustration", ...BASE, illustration: { shots: [{ assetId: "as_nope" }] } });
  assert.ok(!missing.ok);
  assert.match(missing.problems.join("\n"), /illustration\.shots\.0: there is no asset with the id "as_nope"/);

  const wrongKind = check({ type: "footage", ...BASE, footage: { assetId: image.id } });
  assert.ok(!wrongKind.ok);
  assert.match(wrongKind.problems.join("\n"), /footage: asset ".*" is an image, but this needs a video/);

  const badCue = check({ type: "illustration", ...BASE, illustration: { shots: [{ assetId: image.id }, { assetId: image.id, at: { cue: "nowhere" } }] } });
  assert.ok(!badCue.ok);
  assert.match(badCue.problems.join("\n"), /illustration\.shots\.1: there is no cue with the id "nowhere"/);

  const good = check({
    type: "illustration",
    ...BASE,
    references: [{ assetId: image.id, role: "layout", note: "keep the lens on the left" }],
    illustration: { shots: [{ assetId: image.id }, { assetId: image.id, at: { cue: "bend" } }] },
  });
  assert.ok(good.ok);
  assert.deepEqual(assetUsage(studio, image.id), [scene.id]);
  assert.throws(() => deleteAsset(studio, image.id), /used by 1 scene/);

  // The second image takes over when its cue is spoken.
  const data = (await sceneContext(studio, scene.id)).data.scenes[0]!;
  const cue = data.cues.find((c) => c.elementId === "bend")!;
  assert.equal(data.kind, "illustration");
  assert.deepEqual(data.illustration!.shots.map((s) => [s.startFrame, s.endFrame]), [[0, cue.startFrame], [cue.startFrame, data.durationInFrames]]);
  studio.close();
});

test("image and footage scenes render to clips: the camera moves, labels appear, and a short clip fills its scene", needsBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER } });
  const { project, chapter, p } = emptyProject(studio);
  updateProject(studio, project.id, { settings: { ...project.settings, captions: false } });
  const size = { width: Math.round(project.width * studio.config.render.previewScale), height: Math.round(project.height * studio.config.render.previewScale) };

  // An illustration: zoomed in on the top-left quarter, moving to the bottom-right one, then the whole image.
  const image = await importAsset(studio, project.id, testCard());
  const ill = addScene(studio, chapter.id, { title: "Lens", type: "illustration", narration: NARRATION });
  const illSpec = saveSpec(studio, ill.id, {
    type: "illustration",
    ...BASE,
    visual: { ...BASE.visual, transitionIn: "cut" },
    overlays: [{ kind: "label", text: "Sensor", x: 0.5, y: 0.5, at: { cue: "bend" } }],
    illustration: {
      shots: [
        { assetId: image.id, from: { x: 0.25, y: 0.25, zoom: 2 }, to: { x: 0.75, y: 0.75, zoom: 2 } },
        { assetId: image.id, at: { cue: "bend" }, fit: "contain" },
      ],
    },
  }, "test");
  assert.ok(illSpec.ok);
  const illData = (await sceneContext(studio, ill.id)).data.scenes[0]!;
  const cueSec = illData.cues[0]!.startFrame / project.fps;
  const illClip = p.abs((await renderSceneClip(studio, ill.id)).clip.path);
  assert.equal((await probe(illClip)).frames, illData.durationInFrames);
  const corner = { x: 0.1, y: 0.1 };
  assert.equal(quarterOf(await pixelAt(ffmpeg, illClip, size, { ...corner, sec: 0 })), "red", "starts on the top-left quarter");
  assert.equal(quarterOf(await pixelAt(ffmpeg, illClip, size, { ...corner, sec: cueSec - 0.1 })), "yellow", "has moved to the bottom-right quarter by the cue");
  const end = (illData.durationInFrames - 2) / project.fps;
  assert.equal(quarterOf(await pixelAt(ffmpeg, illClip, size, { x: 0.25, y: 0.15, sec: end })), "red", "ends on the whole image");
  assert.equal(quarterOf(await pixelAt(ffmpeg, illClip, size, { x: 0.75, y: 0.85, sec: end })), "yellow");
  // The label covers the centre once its cue has been spoken, and not before.
  const centreBefore = await pixelAt(ffmpeg, illClip, size, { x: 0.47, y: 0.45, sec: cueSec - 0.1 });
  const centreAfter = await pixelAt(ffmpeg, illClip, size, { x: 0.47, y: 0.5, sec: end });
  assert.notEqual(quarterOf(centreBefore), "other");
  assert.equal(quarterOf(centreAfter), "other", "the label is on screen");

  // Footage: four seconds of a frame counter, used in a scene of about seven seconds.
  const counter = addScene(studio, chapter.id, { title: "Counter", type: "remotion-2d", narration: NARRATION });
  const counterSpec = saveSpec(studio, counter.id, { type: "remotion-2d", ...BASE, visual: { ...BASE.visual, transitionIn: "cut" } }, "test");
  assert.ok(counterSpec.ok);
  fs.writeFileSync(versionPaths(studio, project, counterSpec.version).source!, COUNTER_SCENE);
  const four = path.join(studio.workspaceDir, "four.mp4");
  await ffmpeg(["-y", "-i", p.abs((await renderSceneClip(studio, counter.id)).clip.path), "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", four]);
  const clip = await importAsset(studio, project.id, four, { label: "Counter" });
  assert.equal(clip.kind, "video");
  assert.equal(clip.durationSec, 4);
  const frames = await assetPreview(studio, clip.id, { frames: 3 });
  assert.deepEqual(frames.map((f) => f.atSec), [0.67, 2, 3.33]);
  for (const f of frames) assert.ok(fs.statSync(f.file).size > 500);

  const footage: string[] = [];
  for (const fit of ["slow", "hold", "loop"] as const) {
    const scene = addScene(studio, chapter.id, { title: `Clip, ${fit}`, type: "footage", narration: NARRATION });
    const saved = saveSpec(studio, scene.id, { type: "footage", ...BASE, footage: { assetId: clip.id, fit } }, "test", (s) => checkSpecAssets(studio, project.id, s));
    assert.ok(saved.ok);
    const data = (await sceneContext(studio, scene.id)).data.scenes[0]!;
    assert.ok(data.durationInFrames > 200, "the scene is longer than the clip");
    const out = p.abs((await renderSceneClip(studio, scene.id)).clip.path);
    assert.equal((await probe(out)).frames, data.durationInFrames, `${fit}: the clip fills the whole scene`);
    footage.push(out);
  }
  // Held and looped clips are the same picture until the source runs out, and differ after.
  const digit = { x: 0.5, y: 0.5 };
  const sample = async (file: string, sec: number) => {
    let lit = 0;
    for (const x of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) if ((await pixelAt(ffmpeg, file, size, { ...digit, x, sec }))[0] > 128) lit++;
    return lit;
  };
  assert.equal(await sample(footage[1]!, 1), await sample(footage[2]!, 1));
  // At 4.2 s the held clip shows "118" and the looped one is back at a single digit.
  assert.ok((await sample(footage[1]!, 4.2)) > (await sample(footage[2]!, 4.2)), "the loop has started again");

  // Everything joins into one video, whatever made each clip.
  const result = await assemble(studio, project.id);
  assert.deepEqual(result.skipped, []);
  assert.equal((await probe(result.file)).frames, result.render.sceneVersions.reduce((n, s) => n + s.frames, 0));
  studio.close();
});
