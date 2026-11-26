import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inspectModel } from "../packages/core/src/studio/assets/gltf.js";
import { assetPreview } from "../packages/core/src/studio/assets/preview.js";
import { ffmpeg } from "../packages/core/src/studio/media/ffmpeg.js";
import { LIB_EXAMPLE_3D } from "../packages/core/src/paths.js";
import { availableSceneTypes } from "../packages/core/src/studio/renderers/registry.js";
import { checkThreeSource, DREI_ALLOWED, importedNames } from "../packages/core/src/studio/renderers/threeCheck.js";
import { checkScene, clipCacheKey, qualitySettings, renderSceneClip, renderSceneStills, sceneContext } from "../packages/core/src/studio/scenes/render.js";
import { importAsset } from "../packages/core/src/studio/store/assets.js";
import { addChapter } from "../packages/core/src/studio/store/chapters.js";
import { createProject, projectPaths } from "../packages/core/src/studio/store/projects.js";
import { createRun } from "../packages/core/src/studio/store/runs.js";
import { addScene, saveSpec, versionPaths } from "../packages/core/src/studio/store/scenes.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { callTool } from "../packages/core/src/studio/tools/index.js";
import { CAMERA_PARTS, writeCameraGlb, writeGlb } from "./helpers/glb.js";
import { shareOfPixels } from "./helpers/media.js";
import { BROWSER, needsBrowser, SAMPLE_SPEC, tempStudio } from "./helpers/studio.js";

const EXAMPLE_3D = fs.readFileSync(LIB_EXAMPLE_3D, "utf8");

/** A project with one 3D scene whose code is `code`. */
function scene3d(studio: Studio, code: string, assets: string[] = []) {
  const project = createProject(studio, { description: "How a camera catches light", targetDurationSec: 60 });
  const chapter = addChapter(studio, project.id, { title: "Only chapter" });
  const scene = addScene(studio, chapter.id, { title: "In three dimensions", type: "r3f", narration: SAMPLE_SPEC.narration });
  const saved = saveSpec(studio, scene.id, { ...SAMPLE_SPEC, type: "r3f", title: "In three dimensions", assets }, "test");
  assert.ok(saved.ok, saved.ok ? "" : saved.problems.join("; "));
  const file = versionPaths(studio, project, saved.version).source!;
  fs.writeFileSync(file, code);
  return { project, chapter, scene, file };
}

/** The camera model, opened up: the back comes off on the first cue, the shutter's animation plays from the second. */
const cameraScene = (assetId: string) => `import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { useCueAppear, useCueFrame } from "@pipeline/lib";
import { Ground, Model, Scene3D, orbit } from "@pipeline/lib/three";

export default function Scene() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const open = useCueAppear("sat", { durationSec: 0.5 });
  const shutterSec = Math.max(0, (frame - useCueFrame("phone")) / fps);
  return (
    <Scene3D camera={{ position: orbit(205, 11, 3.2), lookAt: [0, 0, 0], fov: 30 }}>
      <Model asset="${assetId}" fit={4} parts={{ Back: { offset: [0, 0, -1.6 * open], visible: open < 0.99 } }} animations={{ ShutterOpen: shutterSec }} />
      <Ground y={-1.5} />
    </Scene3D>
  );
}
`;

test("3D scenes are a scene type, checked like any other code scene", async () => {
  assert.ok(availableSceneTypes().includes("r3f"));
  const studio = await tempStudio();
  const { scene, file } = scene3d(studio, EXAMPLE_3D);
  assert.deepEqual(await checkScene(studio, scene.id), [], "the library's own example passes, types included");

  // A type error is reported with its line, as in 2D scenes.
  fs.writeFileSync(file, EXAMPLE_3D.replace("fov: 32", 'fov: "wide"'));
  const typeProblems = await checkScene(studio, scene.id);
  assert.ok(typeProblems.some((p) => /scene\.tsx\(\d+,\d+\): error TS\d+/.test(p)), typeProblems.join("\n"));
  studio.close();
});

test("the 3D check refuses anything that moves by itself, is random, or loads from outside", () => {
  assert.deepEqual(checkThreeSource(EXAMPLE_3D), []);
  assert.deepEqual(importedNames('import React, { useMemo as memo, type FC } from "react";', "react"), ["useMemo", "FC", "*"]);

  const scene = (imports: string, body: string) => `${imports}\nimport { Scene3D } from "@pipeline/lib/three";\nexport default function Scene() { ${body} return <Scene3D camera={{ position: [0, 0, 5] }} />; }`;
  const refused: [string, string, RegExp][] = [
    ["useFrame", scene('import { useFrame } from "@react-three/fiber";', "useFrame(() => {});"), /useFrame runs on a clock/],
    ["its own canvas", scene('import { Canvas } from "@react-three/fiber";', ""), /instead of <Canvas>/],
    ["a helper that moves by itself", scene('import { Float, RoundedBox } from "@react-three/drei";', ""), /Float from "@react-three\/drei" is not available here/],
    ["mouse controls", scene('import { OrbitControls as Controls } from "@react-three/drei";', ""), /OrbitControls from/],
    ["text fetched from the internet", scene('import { Text } from "@react-three/drei";', ""), /Text from/],
    ["all of drei at once", scene('import * as drei from "@react-three/drei";', ""), /by name/],
    ["a clock", scene('import * as THREE from "three";', "const clock = new THREE.Clock();"), /clocks make every render different/],
    ["three's random numbers", scene('import { MathUtils } from "three";', "const x = MathUtils.randFloat(0, 1);"), /random helpers/],
    ["its own loader", scene('import { TextureLoader } from "three";', ""), /loaded through the library/],
    ["no 3D picture at all", 'export default function Scene() { return null; }', /no <Scene3D>/],
  ];
  for (const [what, code, expected] of refused) {
    const problems = checkThreeSource(code);
    assert.ok(problems.some((p) => expected.test(p)), `${what}: ${problems.join(" | ") || "no problems reported"}`);
  }
  assert.ok(DREI_ALLOWED.includes("RoundedBox") && !DREI_ALLOWED.includes("Float"));
});

test("the checks every code scene gets apply to 3D scenes too", async () => {
  const studio = await tempStudio();
  const { scene, file } = scene3d(studio, EXAMPLE_3D);
  const withLine = (line: string) => fs.writeFileSync(file, EXAMPLE_3D.replace("export default function Scene() {", `${line}\nexport default function Scene() {`));

  withLine("const jitter = Math.random();");
  assert.match((await checkScene(studio, scene.id)).join("\n"), /Math\.random\(\) makes every render different/);
  withLine("const started = Date.now();");
  assert.match((await checkScene(studio, scene.id)).join("\n"), /clock makes every render different/);
  withLine('import { EffectComposer } from "@react-three/postprocessing";');
  assert.match((await checkScene(studio, scene.id)).join("\n"), /Import from "@react-three\/postprocessing" is not allowed/);
  studio.close();
});

test("a model is read when it is added: parts, animations and size, with warnings for what Blender left unfinished", async () => {
  const studio = await tempStudio({ studio: { modelTriangleBudget: 5000 } });
  const project = createProject(studio, { description: "How a camera catches light", targetDurationSec: 60 });
  const dir = studio.workspaceDir;

  const camera = await importAsset(studio, project.id, writeCameraGlb(path.join(dir, "camera.glb")));
  assert.equal(camera.kind, "model");
  const model = camera.meta.model as ReturnType<typeof inspectModel>;
  assert.deepEqual(model.parts.map((p) => p.name), ["Body", "Lens", "Back", "Shutter", "Button"]);
  assert.equal(model.parts.find((p) => p.name === "Lens")!.parent, "Body");
  assert.deepEqual(model.parts.find((p) => p.name === "Lens")!.position, [0, 0, 0.9]);
  assert.equal(model.triangles, 60);
  assert.deepEqual(model.animations, [{ name: "ShutterOpen", durationSec: 1, parts: ["Shutter"] }]);
  assert.deepEqual(model.size, [2.4, 1.64, 1.92], "the box around every part, the lens sticking out in front");
  assert.deepEqual(model.warnings, []);

  // Over the triangle budget, and parts nobody named.
  const heavy = writeGlb(path.join(dir, "heavy.glb"), [{ ...CAMERA_PARTS[0]!, name: "Cube.001", subdivide: 30 }, { ...CAMERA_PARTS[1]!, name: "", parent: undefined }]);
  const warned = (await importAsset(studio, project.id, heavy)).meta.model as ReturnType<typeof inspectModel>;
  assert.equal(warned.triangles, 10812);
  assert.ok(warned.warnings.some((w) => /10,812 triangles, over the 5,000/.test(w) && /Decimate/.test(w)), warned.warnings.join("\n"));
  assert.ok(warned.warnings.some((w) => /2 parts have no name of their own/.test(w)), warned.warnings.join("\n"));

  // A file that would not load is refused when it is added, with what to do about it.
  const draco = writeGlb(path.join(dir, "draco.glb"), CAMERA_PARTS, [], { extensionsUsed: ["KHR_draco_mesh_compression"] });
  await assert.rejects(importAsset(studio, project.id, draco), /compressed \(Draco or Meshopt\)[\s\S]*turn off Compression/);
  fs.writeFileSync(path.join(dir, "notes.glb"), "not a model");
  await assert.rejects(importAsset(studio, project.id, path.join(dir, "notes.glb")), /not a glTF model/);
  assert.equal(fs.readdirSync(projectPaths(studio, project).assets).length, 2, "refused files are not kept");

  // Claude sees the same facts through its tools.
  const chapter = addChapter(studio, project.id, { title: "Only chapter" });
  const flat = addScene(studio, chapter.id, { title: "Flat", type: "remotion-2d", narration: SAMPLE_SPEC.narration });
  const run = createRun(studio, { projectId: project.id, kind: "scene", targetId: flat.id, agent: "scene-builder" });
  const ctx = { studio, projectId: project.id, run, log: () => {} };
  const listed = (await callTool(ctx, "asset_list", { kind: "model" })).output as any;
  const seen = listed.assets.find((a: any) => a.id === camera.id).model;
  assert.deepEqual(seen.parts.map((p: any) => p.name), ["Body", "Lens", "Back", "Shutter", "Button"]);
  assert.equal(seen.animations[0].name, "ShutterOpen");
  assert.match(seen.howToUse, /<Model asset=/);

  // A model belongs in a 3D scene, and a scene must list what it loads.
  const refused = await callTool(ctx, "scene_save_spec", { spec: { ...SAMPLE_SPEC, title: "Flat", assets: [camera.id, "as_missing"] } });
  assert.equal((refused.output as any).saved, false);
  assert.match(JSON.stringify(refused.output), /3D model, which only a scene of type r3f can show/);
  assert.match(JSON.stringify(refused.output), /no asset with the id \\"as_missing\\"/);
  studio.close();
});

test("the same 3D scene rendered twice gives the same frames, whatever order they are drawn in", needsBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER } });
  const { project, scene } = scene3d(studio, EXAMPLE_3D);
  const p = projectPaths(studio, project);
  const read = (stills: { file: string }[]) => stills.map((s) => fs.readFileSync(p.abs(s.file)));

  const first = read(await renderSceneStills(studio, scene.id, { frames: [20, 100, 170] }));
  // Again from nothing: a fresh bundle, and the frames asked for in another order.
  fs.rmSync(path.join(p.work, scene.id), { recursive: true, force: true });
  const second = read(await renderSceneStills(studio, scene.id, { frames: [170, 20, 100] }));
  for (const i of [0, 1, 2]) assert.ok(first[i]!.equals(second[i]!), `frame ${[20, 100, 170][i]} differs between two renders`);
  assert.ok(!first[0]!.equals(first[2]!), "and the picture does change through the scene");

  // The clip is as long as the narration, like every other scene type's.
  const { clip } = await renderSceneClip(studio, scene.id, "preview");
  const ctx = await sceneContext(studio, scene.id);
  assert.equal(clip.durationFrames, ctx.data.scenes[0]!.durationInFrames);
  studio.close();
});

test("a model from Blender: pictures from four sides, parts moved on a cue, and its animation played on a cue", needsBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER } });
  const { project, scene } = scene3d(studio, "");
  const asset = await importAsset(studio, project.id, writeCameraGlb(path.join(studio.workspaceDir, "camera.glb")));
  const saved = saveSpec(studio, scene.id, { ...SAMPLE_SPEC, type: "r3f", title: "In three dimensions", assets: [asset.id] }, "test");
  assert.ok(saved.ok);
  fs.writeFileSync(versionPaths(studio, project, saved.version).source!, cameraScene(asset.id));
  assert.deepEqual(await checkScene(studio, scene.id), []);

  // Pictures for whoever needs to know what the model is: four sides, then each animation at its end.
  const pictures = await assetPreview(studio, asset.id);
  assert.deepEqual(pictures.map((x) => x.caption!.replace("camera, ", "")), ["from the front right", "from the back left", "from the front", "from the top", 'at the end of its animation "ShutterOpen" (1s)']);
  // The shutter's yellow, lit: red and green alike. (The caption's highlighted word is a more orange yellow.)
  const yellow = (r: number, g: number, b: number) => r > 150 && g > 150 && b < 140 && r - b > 60 && Math.abs(r - g) < 25;
  const red = (r: number, g: number, b: number) => r > 150 && g < 120 && b < 120;
  assert.ok((await shareOfPixels(ffmpeg, pictures[0]!.file, yellow)) < 0.001, "at rest the shutter is inside the body");
  assert.ok((await shareOfPixels(ffmpeg, pictures[4]!.file, yellow)) > 0.01, "at the end of its animation it has slid up into view");
  assert.ok((await shareOfPixels(ffmpeg, pictures[1]!.file, red)) > 0.05, "the back is what you see from behind");

  // In the scene: before the first cue the back is on; after it, the back is off; after the second, the shutter is up.
  const ctx = await sceneContext(studio, scene.id);
  const cue = (id: string) => ctx.data.scenes[0]!.cues.find((c) => c.elementId === id)!.startFrame;
  const fps = project.fps;
  const frames = [Math.max(0, cue("sat") - 2), cue("sat") + fps, cue("phone") + fps];
  assert.ok(frames[1]! < cue("phone"), "the test's cues are far enough apart");
  const stills = await renderSceneStills(studio, scene.id, { frames });
  const p = projectPaths(studio, project);
  const share = (i: number, colour: typeof red) => shareOfPixels(ffmpeg, p.abs(stills[i]!.file), colour);
  assert.ok((await share(0, red)) > 0.05, "the back is on");
  assert.ok((await share(1, red)) < 0.005, "the back has come off");
  assert.ok((await share(1, yellow)) < 0.001, "and the shutter is still down inside the body");
  assert.ok((await share(2, yellow)) > 0.005, "the shutter has slid up out of the body");

  // Replacing the model's file would change the clip; the cache key knows, because the file is named by its content.
  const key = await clipCacheKey(ctx, qualitySettings(studio, "preview"));
  assert.match(JSON.stringify(ctx.data.scenes[0]!.assets), new RegExp(asset.sha256.slice(0, 24)));
  assert.equal(await clipCacheKey(await sceneContext(studio, scene.id), qualitySettings(studio, "preview")), key);
  studio.close();
});
