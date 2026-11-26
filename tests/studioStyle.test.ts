import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer } from "../packages/server/src/server.js";
import { pickShots, referenceKeyframes } from "../packages/core/src/studio/assets/keyframes.js";
import { ffmpeg } from "../packages/core/src/studio/media/ffmpeg.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import { clipCacheKey, qualitySettings, renderSceneStills, sceneContext } from "../packages/core/src/studio/scenes/render.js";
import { importAsset, listSceneReferences, setSceneReference } from "../packages/core/src/studio/store/assets.js";
import { addChapter } from "../packages/core/src/studio/store/chapters.js";
import { createProject, getProject, projectPaths } from "../packages/core/src/studio/store/projects.js";
import { createRun, updateRun } from "../packages/core/src/studio/store/runs.js";
import { addScene, currentVersion, getScene, listScenes, saveSpec, setTheme, versionPaths } from "../packages/core/src/studio/store/scenes.js";
import { characterInfo, listShared, planShared, readShared } from "../packages/core/src/studio/store/shared.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { callTool } from "../packages/core/src/studio/tools/index.js";
import { Orchestrator } from "../packages/core/src/studio/workflow.js";
import { pngSize, rawPixels, writeShotsVideo, writeTestCard } from "./helpers/media.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { BROWSER, needsBrowser, SAMPLE_SPEC, tempStudio } from "./helpers/studio.js";

const RED: [number, number, number] = [200, 40, 40];
const GREEN: [number, number, number] = [40, 180, 60];
const BLUE: [number, number, number] = [40, 60, 200];

/** Take a project through planning to the point where its scene lists are written and nothing is built. */
async function scripted(studio: Studio, o: Orchestrator, description: string, seconds = 60) {
  const project = createProject(studio, { description, targetDurationSec: seconds });
  o.startStage(project.id);
  await o.idle();
  for (const stage of ["bible", "foundation", "chapters"]) {
    assert.equal(o.approveStage(project.id).stage, stage);
    await o.idle();
  }
  return project;
}

// ---------- Reference videos ----------

test("frames are grouped into shots at cuts and at slow changes, and each shot gives its calmest late frame", () => {
  // Frames of four values each; a "picture" is one grey level.
  const frames = (levels: number[]) => Buffer.from(levels.flatMap((v) => [v, v, v, v]));
  // Two shots with a hard cut, and one transition frame caught halfway between them.
  const cut = pickShots(frames([10, 10, 11, 10, 120, 240, 240, 241, 240]), 4, 8);
  assert.deepEqual(cut.map((s) => [s.start, s.end]), [[0, 3], [5, 8]], "the single frame between the cuts is a transition, not a shot");
  assert.deepEqual(cut.map((s) => s.pick), [3, 8], "the latest still frame of each");
  // A slow fade never jumps, but ends far from where it began.
  const fade = pickShots(frames([0, 12, 24, 36, 48, 60, 72, 84, 96, 96, 96]), 4, 8);
  assert.ok(fade.length >= 2, "a picture that has drifted far is a new shot");
  assert.equal(fade.at(-1)!.pick, 10);
  // More shots than asked for: the most alike neighbours are merged.
  // A small step is not a cut: 100 and 110 are one shot.
  const many = pickShots(frames([0, 0, 0, 100, 100, 100, 110, 110, 110, 110, 250, 250, 250]), 4, 8);
  assert.deepEqual(many.map((s) => [s.start, s.end]), [[0, 2], [3, 9], [10, 12]]);
  const merged = pickShots(frames([0, 0, 0, 100, 100, 100, 250, 250, 250, 250, 30, 30]), 4, 2);
  assert.equal(merged.length, 2);
  assert.deepEqual([merged[0]!.start, merged.at(-1)!.end], [0, 11], "merged shots still cover the whole video");
  assert.deepEqual(pickShots(Buffer.alloc(0), 4, 8), []);
});

test("a reference video gives one keyframe for each shot and a contact sheet, through the tool an agent calls", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: "How a reference video guides the look of a scene.", targetDurationSec: 60 });
  const file = path.join(studio.workspaceDir, "reference.mp4");
  await writeShotsVideo(ffmpeg, file, [{ colour: RED, sec: 2 }, { colour: GREEN, sec: 3 }, { colour: BLUE, sec: 1.5 }]);
  const video = await importAsset(studio, project.id, file, { label: "Competitor explainer" });
  assert.equal(video.kind, "video");

  const found = await referenceKeyframes(studio, video.id);
  assert.equal(found.keyframes.length, 3, "one for each shot");
  const [a, b, c] = found.keyframes;
  assert.ok(a!.atSec > 0.8 && a!.atSec < 2, `the first keyframe is from the first shot's later half: ${a!.atSec}`);
  assert.ok(b!.atSec > 3.3 && b!.atSec < 5, `the second from the second: ${b!.atSec}`);
  assert.ok(c!.atSec > 5.6 && c!.atSec <= 6.5, `the third from the third: ${c!.atSec}`);
  assert.ok(Math.abs(b!.shotStartSec - 2) < 0.3 && Math.abs(b!.shotEndSec - 5) < 0.3, "each keyframe knows the stretch it stands for");
  // The pictures are what they should be: the middle of each is the shot's colour.
  for (const [key, colour] of [[a, RED], [b, GREEN], [c, BLUE]] as const) {
    const raw = await rawPixels(ffmpeg, key!.file);
    const top = [raw[30]!, raw[31]!, raw[32]!];
    assert.ok(top.every((v, i) => Math.abs(v - colour[i]!) < 30), `keyframe ${key!.index} is ${top}, expected about ${colour}`);
  }
  // The sheet: three cells side by side, each 440 wide with a strip for its number and time underneath.
  const sheet = pngSize(found.sheet!);
  assert.equal(sheet.width, 3 * 440 + 4 * 12);
  assert.equal(sheet.height, Math.round(440 / (320 / 180)) + 34 + 2 * 12);
  // Asking again reuses the files.
  const again = await referenceKeyframes(studio, video.id);
  assert.deepEqual(again.keyframes.map((k) => k.file), found.keyframes.map((k) => k.file));
  assert.equal(fs.statSync(again.sheet!).mtimeMs, fs.statSync(found.sheet!).mtimeMs);
  // Fewer frames than shots: neighbours are merged. A moment asked for by hand is always among them.
  assert.equal((await referenceKeyframes(studio, video.id, { max: 2 })).keyframes.length, 2);
  const picked = await referenceKeyframes(studio, video.id, { include: [0.4] });
  assert.deepEqual(picked.keyframes.map((k) => Boolean(k.asked)), [true, false, false, false]);
  assert.equal(picked.keyframes[0]!.atSec, 0.4);

  // The tool: the sheet first, then each frame, with what an agent needs to refer to them.
  const ctx = { studio, projectId: project.id, log: () => {} };
  const viewed = await callTool(ctx, "reference_keyframes", { assetId: video.id });
  assert.equal(viewed.ok, true, JSON.stringify(viewed.output));
  assert.deepEqual((viewed.output.keyframes as { number: number }[]).map((k) => k.number), [1, 2, 3]);
  assert.match((viewed.output.keyframes as { shot: string }[])[1]!.shot, /^0:0[12]\.\d to 0:0[45]\.\d$/);
  assert.equal(viewed.images.length, 4);
  assert.equal(viewed.images[0]!.file, found.sheet);
  assert.equal((await callTool(ctx, "reference_keyframes", { assetId: video.id, frames: "sheet" })).images.length, 1);
  assert.match(String((await callTool(ctx, "asset_view", { assetId: video.id })).output.note), /reference_keyframes/);
  // An image is its own keyframe; a sound has none.
  const card = path.join(studio.workspaceDir, "card.png");
  writeTestCard(card, 400, 250);
  const image = await importAsset(studio, project.id, card);
  const still = await callTool(ctx, "reference_keyframes", { assetId: image.id });
  assert.equal(still.images.length, 1);
  assert.equal(still.output.contactSheet, null);
  studio.close();
});

test("a reference attached to one scene reaches the run that builds it, with the moment the person picked", async () => {
  const studio = await tempStudio();
  const runner = new MockStudioRunner();
  const o = new NoRenderOrchestrator(studio, runner);
  const server = await startServer(studio, { port: 0, orchestrator: o });
  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(server.url + url, { method, headers: { "x-studio": "1", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: (await res.json()) as any };
  };
  try {
    const project = await scripted(studio, o, "How noise-cancelling headphones erase sound with more sound.");
    const file = path.join(studio.workspaceDir, "reference.mp4");
    await writeShotsVideo(ffmpeg, file, [{ colour: RED, sec: 2 }, { colour: GREEN, sec: 2 }]);
    const video = await importAsset(studio, project.id, file, { label: "Layout to follow" });
    const [first, second] = listScenes(studio, project.id);

    // The GUI's path: see the shots, pick one, attach it to a scene.
    const frames = await api("GET", `/api/assets/${video.id}/keyframes`);
    assert.equal(frames.status, 200, JSON.stringify(frames.data));
    assert.equal(frames.data.keyframes.length, 2);
    assert.match(frames.data.sheetUrl, /^\/files\/.+sheet.+\.png/);
    assert.equal((await fetch(server.url + frames.data.keyframes[1].url)).headers.get("content-type"), "image/jpeg");
    const atSec = frames.data.keyframes[1].atSec;
    assert.equal((await api("PUT", `/api/scenes/${first!.id}/references`, { assetId: video.id, role: "layout", note: "Same arrangement, our content", atSec })).status, 200);
    assert.equal((await api("PUT", `/api/scenes/${first!.id}/references`, { assetId: video.id, role: "trace-it" })).status, 400);
    assert.deepEqual(listSceneReferences(studio, first!.id), [{ assetId: video.id, role: "layout", note: "Same arrangement, our content", atSec }]);
    assert.deepEqual(listSceneReferences(studio, second!.id), [], "a scene's reference is its own");
    const detail = (await api("GET", `/api/scenes/${first!.id}`)).data;
    assert.equal(detail.references.length, 1);
    assert.equal(detail.references[0].label, "Layout to follow");
    assert.match(detail.references[0].pictureUrl, /\.jpg/, "the page shows the frame that was picked");

    // What the scene's builder is told.
    const run = createRun(studio, { projectId: project.id, kind: "scene", targetId: first!.id, agent: "scene-builder" });
    const ctx = { studio, projectId: project.id, run, log: () => {} };
    const told = (await callTool(ctx, "scene_get", {})).output.references as { assetId: string; role: string; atSec: number; howToUse: string }[];
    assert.equal(told.length, 1);
    assert.equal(told[0]!.atSec, atSec);
    assert.match(told[0]!.howToUse, /attached this to your scene.*reference_keyframes.*composition.*not a picture to copy/s);
    const seen = await callTool(ctx, "reference_keyframes", { assetId: video.id });
    assert.deepEqual((seen.output.keyframes as { pickedByThePerson?: boolean }[]).map((k) => Boolean(k.pickedByThePerson)), [false, true]);
    assert.match(seen.images[2]!.caption, /picked by the person/);
    const otherRun = createRun(studio, { projectId: project.id, kind: "scene", targetId: second!.id, agent: "scene-builder" });
    assert.deepEqual((await callTool({ ...ctx, run: otherRun }, "scene_get", {})).output.references, []);
    for (const r of [run, otherRun]) updateRun(studio, r.id, { status: "done" });

    // Building the scenes: the run that owns the scene looks at the reference and records that it followed it.
    assert.equal(o.approveStage(project.id).stage, "scenes");
    await o.idle();
    const looked = runner.calls.filter((c) => c.tool === "reference_keyframes");
    assert.equal(looked.length, 1, "only the scene it is attached to");
    assert.deepEqual(currentVersion(studio, getScene(studio, first!.id))!.spec.references, [{ assetId: video.id, role: "layout", note: "Same arrangement, our content" }]);
    assert.deepEqual(currentVersion(studio, getScene(studio, second!.id))!.spec.references, []);

    // Only pictures and clips can be references, and taking one away is one call.
    const beep = path.join(studio.workspaceDir, "beep.wav");
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", beep]);
    const sound = await importAsset(studio, project.id, beep);
    assert.throws(() => setSceneReference(studio, first!.id, { assetId: sound.id, role: "style" }), /not an image or a video/);
    assert.equal((await api("PUT", `/api/scenes/${first!.id}/references`, { assetId: video.id, role: null })).status, 200);
    assert.deepEqual(listSceneReferences(studio, first!.id), []);
  } finally {
    await server.close();
    o.stop();
    studio.close();
  }
});

// ---------- Characters ----------

/** A character in plain colours that are easy to find in a picture. */
const FIGURE = `import React from "react";
import { defineCharacter } from "@pipeline/lib";

export const Robo = defineCharacter({
  width: 200,
  height: 400,
  poses: ["stand", "reach"],
  expressions: ["calm", "alarmed"],
  colors: { head: "#FF00AA", body: "accent" },
  draw: ({ pose, expression, colors }) => (
    <>
      <rect x={60} y={120} width={80} height={280} fill={colors.body} />
      {pose === "reach" ? <rect x={140} y={140} width={60} height={20} fill={colors.body} /> : null}
      <rect x={40} y={0} width={120} height={120} fill={colors.head} />
      <rect x={80} y={expression === "alarmed" ? 70 : 84} width={40} height={expression === "alarmed" ? 30 : 8} fill="#000000" />
    </>
  ),
});
`;

test("a character is planned as one, must be made with the library, and a scene cannot pose it in ways it does not have", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: "A robot explains how batteries store energy.", targetDurationSec: 60 });
  planShared(studio, project.id, [{ name: "Robo", kind: "character", brief: "A boxy robot with a pink head. Poses: stand, reach. Expressions: calm, alarmed." }]);
  assert.equal(listShared(studio, project.id)[0]!.kind, "character");
  const run = createRun(studio, { projectId: project.id, kind: "foundation", agent: "foundation-builder" });
  const ctx = { studio, projectId: project.id, run, log: () => {} };

  // Drawn as an ordinary component, it could be drawn differently in every scene. Refused.
  const loose = await callTool(ctx, "shared_save", { name: "Robo", code: `import React from "react";\nexport const Robo = () => <div />;\nexport const Demo = () => <Robo />;\n` });
  assert.equal(loose.output.saved, false);
  assert.match(JSON.stringify(loose.output.problems), /defineCharacter/);
  const nameless = await callTool(ctx, "shared_save", { name: "Robo", code: FIGURE.replace('poses: ["stand", "reach"]', "poses: POSES").replace("export const Robo", 'const POSES = ["stand", "reach"] as const;\nexport const Robo') });
  assert.match(JSON.stringify(nameless.output.problems), /poses as a list of names written out/);

  const saved = await callTool(ctx, "shared_save", { name: "Robo", code: FIGURE });
  assert.equal(saved.output.saved, true, JSON.stringify(saved.output));
  assert.equal(saved.output.kind, "character");
  assert.deepEqual(saved.output.poses, ["stand", "reach"]);
  assert.deepEqual(characterInfo(readShared(studio, project.id, "Robo")), { poses: ["stand", "reach"], expressions: ["calm", "alarmed"] });

  // A scene builder is told what the character can do and how to place it.
  const chapter = addChapter(studio, project.id, { title: "Only chapter" });
  const scene = addScene(studio, chapter.id, { title: "Robo says hello", type: "remotion-2d", narration: SAMPLE_SPEC.narration });
  const sceneRun = createRun(studio, { projectId: project.id, kind: "scene", targetId: scene.id, agent: "scene-builder" });
  const mine = { studio, projectId: project.id, run: sceneRun, log: () => {} };
  const listed = ((await callTool(mine, "scene_get", {})).output.sharedAssets as { name: string; kind: string; poses: string[]; howToUse: string }[])[0]!;
  assert.equal(listed.kind, "character");
  assert.deepEqual(listed.poses, ["stand", "reach"]);
  assert.match(listed.howToUse, /never redraw it, recolour it or stretch it/);

  const spec = await callTool(mine, "scene_save_spec", { spec: { ...SAMPLE_SPEC, title: "Robo says hello", uses: [{ name: "Robo", version: 1 }] } });
  assert.equal(spec.output.saved, true, JSON.stringify(spec.output));
  const code = (props: string) => `import React from "react";
import { Background } from "@pipeline/lib";
import { Robo } from "@shared/Robo";

export default function Scene() {
  return (
    <>
      <Background />
      <Robo x={400} y={900} ${props} />
    </>
  );
}
`;
  const check = async (props: string) => {
    fs.writeFileSync(spec.output.codeFile as string, code(props));
    return (await callTool(mine, "scene_check", {})).output;
  };
  assert.equal((await check('height={500} pose="reach" expression="alarmed" facing="left" talking')).ok, true);
  // A pose the character does not have, and a width that would stretch it: both stop at the check.
  const dance = await check('height={500} pose="dance"');
  assert.equal(dance.ok, false);
  assert.match(JSON.stringify(dance.problems), /dance.*not assignable/);
  const stretched = await check("height={500} width={900}");
  assert.equal(stretched.ok, false);
  assert.match(JSON.stringify(stretched.problems), /width/);
  studio.close();
});

/**
 * The box around a solid patch of colour: the rows and columns of a region in which at
 * least `min` pixels pass the test. Specks of the same colour elsewhere do not count.
 */
function boxOf(raw: Buffer, size: { width: number; height: number }, test: (r: number, g: number, b: number) => boolean, min: number, region = { x0: 0, x1: size.width, y0: 0, y1: size.height }) {
  const rows = new Map<number, number>();
  const columns = new Map<number, number>();
  for (let y = Math.max(0, Math.round(region.y0)); y < Math.min(size.height, region.y1); y++) {
    for (let x = Math.max(0, Math.round(region.x0)); x < Math.min(size.width, region.x1); x++) {
      const o = (y * size.width + x) * 3;
      if (!test(raw[o]!, raw[o + 1]!, raw[o + 2]!)) continue;
      rows.set(y, (rows.get(y) ?? 0) + 1);
      columns.set(x, (columns.get(x) ?? 0) + 1);
    }
  }
  const solid = (counts: Map<number, number>) => [...counts].filter(([, n]) => n >= min).map(([at]) => at);
  const ys = solid(rows);
  const xs = solid(columns);
  const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  return { ...box, width: box.x1 - box.x0 + 1, height: box.y1 - box.y0 + 1, found: xs.length > 0 && ys.length > 0 };
}
const near = (colour: [number, number, number], by = 10) => (r: number, g: number, b: number) => Math.abs(r - colour[0]) <= by && Math.abs(g - colour[1]) <= by && Math.abs(b - colour[2]) <= by;

test("one character appears in five scenes with the same proportions and colours, wherever it stands and however large", needsBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER } } as never);
  const runner = new MockStudioRunner();
  runner.character = true;
  runner.scenesPerChapter = 5;
  runner.stills = false;
  const o = new NoRenderOrchestrator(studio, runner);
  const project = await scripted(studio, o, "How noise-cancelling headphones erase sound with more sound.");
  const guide = listShared(studio, project.id).find((s) => s.kind === "character")!;
  assert.equal(guide.name, "Guide");
  assert.ok(fs.existsSync(projectPaths(studio, project).at("shared", "previews", "Guide-v1.png")), "the character's sheet was drawn for approval");
  assert.equal(o.approveStage(project.id).stage, "scenes");
  await o.idle();
  const scenes = listScenes(studio, project.id);
  assert.equal(scenes.length, 5);
  assert.deepEqual(scenes.map((s) => s.status), Array(5).fill("needs_review"));

  // The guide's own colours, from its definition and the theme: skin, and a jacket in the primary colour.
  const SKIN: [number, number, number] = [0xf2, 0xc6, 0xa0];
  const TROUSERS: [number, number, number] = [0x22, 0x31, 0x4d];
  const JACKET: [number, number, number] = [0x4f, 0xc3, 0xf7];
  const seen: { head: number; legs: number; legWidth: number; cx: number; tall: number; skin: number[]; jacket: number[]; pose: string }[] = [];
  for (const scene of scenes) {
    const version = currentVersion(studio, scene)!;
    const source = fs.readFileSync(versionPaths(studio, project, version).source!, "utf8");
    const placed = /<Guide x=\{t\.width \* ([\d.]+)\} y=\{t\.safe\.bottom\} height=\{t\.height \* ([\d.]+)\} pose="(\w+)" expression="(\w+)" facing="(\w+)"/.exec(source);
    assert.ok(placed, `scene ${scene.title} places the guide`);
    assert.ok(version.spec.uses.some((u) => u.name === "Guide"));
    const [still] = await renderSceneStills(studio, scene.id, { frames: [version.durationFrames! - 1] });
    const file = projectPaths(studio, project).abs(still!.file);
    const size = pngSize(file);
    const raw = await rawPixels(ffmpeg, file);
    const head = boxOf(raw, size, near(SKIN), 6);
    assert.ok(head.found && head.height > 30, `the guide's head is in the picture of ${scene.title}`);
    const legs = boxOf(raw, size, near(TROUSERS, 6), 6, { x0: head.x0, x1: head.x1 + 1, y0: head.y1, y1: size.height });
    assert.ok(legs.found, `the guide's legs are in the picture of ${scene.title}`);
    const pixel = (x: number, y: number) => [...raw.subarray((Math.round(y) * size.width + Math.round(x)) * 3, (Math.round(y) * size.width + Math.round(x)) * 3 + 3)];
    const unit = head.height / 116; // The head is 116 of the character's 420 units tall.
    const cx = (head.x0 + head.x1) / 2;
    seen.push({
      head: head.height,
      legs: legs.height,
      legWidth: legs.width,
      cx: cx / size.width,
      tall: Number(placed[2]) * size.height,
      skin: pixel(cx, head.y0 + 58 * unit - 20 * unit),
      jacket: pixel(cx, head.y0 + (235 - 38) * unit),
      pose: `${placed[3]} ${placed[4]} ${placed[5]}`,
    });
    // It stands where the scene put it.
    assert.ok(Math.abs(cx / size.width - Number(placed[1])) < 0.02, `${scene.title}: stands at ${cx / size.width}, placed at ${placed[1]}`);
  }
  // Placed differently in each scene: both sides, three sizes, several poses.
  assert.ok(new Set(seen.map((s) => Math.round(s.tall))).size >= 3, "different sizes");
  assert.ok(seen.some((s) => s.cx < 0.5) && seen.some((s) => s.cx > 0.5), "both sides of the frame");
  assert.ok(new Set(seen.map((s) => s.pose)).size >= 3, "different poses and expressions");
  for (const s of seen) {
    // Same proportions: head to legs, head to whole figure, and how wide the legs stand.
    // (In the guide's own units the head is 116 tall and 110 of its legs show below the jacket.)
    assert.ok(Math.abs(s.head / s.legs - 116 / 110) < 0.04, `head to legs is ${(s.head / s.legs).toFixed(3)} at height ${s.tall}`);
    assert.ok(Math.abs(s.head / s.tall - 116 / 420) < 0.012, `head to figure is ${(s.head / s.tall).toFixed(3)}`);
    assert.ok(Math.abs(s.legWidth / s.head - 56 / 116) < 0.04, `leg stance is ${(s.legWidth / s.head).toFixed(3)}`);
    // Same colours, to the value.
    assert.ok(near(SKIN, 2)(s.skin[0]!, s.skin[1]!, s.skin[2]!), `skin is ${s.skin}`);
    assert.ok(near(JACKET, 2)(s.jacket[0]!, s.jacket[1]!, s.jacket[2]!), `jacket is ${s.jacket}`);
  }
  o.stop();
  studio.close();
});

// ---------- The hand-drawn look ----------

test("changing the look marks the scenes already drawn out of date, changes their clips, and one action redraws them", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const server = await startServer(studio, { port: 0, orchestrator: o });
  const patch = async (slug: string, settings: unknown) => {
    const res = await fetch(`${server.url}/api/projects/${slug}`, { method: "PATCH", headers: { "x-studio": "1", "content-type": "application/json" }, body: JSON.stringify({ settings }) });
    return { status: res.status, data: (await res.json()) as any };
  };
  try {
    const project = await scripted(studio, o, "How noise-cancelling headphones erase sound with more sound.");
    assert.equal(o.approveStage(project.id).stage, "scenes");
    await o.idle();
    const [first, second] = listScenes(studio, project.id);
    o.approveScene(first!.id);
    const theme = getProject(studio, project.id).settings.theme;
    assert.equal(theme.look, "clean");
    const keyOf = async (id: string) => clipCacheKey(await sceneContext(studio, id), qualitySettings(studio, "preview"));
    const before = await keyOf(first!.id);

    // Another setting changes nothing about the look. (It once put the whole theme back to its defaults.)
    assert.equal((await patch(project.slug, { sceneTypes: ["remotion-2d"] })).data.scenesNowStale, 0);
    assert.deepEqual(getProject(studio, project.id).settings.theme, theme);
    assert.deepEqual(getProject(studio, project.id).settings.sceneTypes, ["remotion-2d"]);
    assert.equal(getScene(studio, first!.id).status, "approved");

    // The look alone: everything else about the theme stays.
    assert.equal((await patch(project.slug, { theme: { look: "sketchy" } })).status, 400);
    const changed = await patch(project.slug, { theme: { look: "hand-drawn" } });
    assert.equal(changed.data.scenesNowStale, 2, JSON.stringify(changed.data));
    assert.deepEqual(getProject(studio, project.id).settings.theme, { ...theme, look: "hand-drawn" });
    for (const id of [first!.id, second!.id]) {
      assert.equal(getScene(studio, id).status, "stale");
      assert.match(getScene(studio, id).staleReason!, /look changed to hand-drawn/);
    }
    assert.notEqual(await keyOf(first!.id), before, "the old clip is not the picture any more");
    assert.equal((await sceneContext(studio, first!.id)).data.style.look, "hand-drawn");

    // One action redraws them, without a Claude run. Setting the same look again changes nothing.
    const runs = o.rendered.length;
    assert.equal(o.rebuildStale(project.id).length, 2);
    await o.idle();
    assert.equal(o.rendered.length, runs + 2);
    assert.deepEqual(listScenes(studio, project.id).map((s) => s.status), ["needs_review", "needs_review"]);
    assert.deepEqual(setTheme(studio, project.id, getProject(studio, project.id).settings.theme), []);
  } finally {
    await server.close();
    o.stop();
    studio.close();
  }
});

/** A white panel with straight edges on a plain background: any wobble shows on its sides. */
const PANEL = `import React from "react";
import { AbsoluteFill } from "remotion";

export default function Scene() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#101010" }}>
      <div style={{ position: "absolute", left: 500, top: 200, width: 900, height: 500, background: "#FFFFFF" }} />
    </AbsoluteFill>
  );
}
`;

test("the hand-drawn look makes straight edges waver, differently from one redraw to the next", needsBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER, stillScale: 1 } } as never);
  const project = createProject(studio, { description: "How a sketch differs from a clean drawing.", targetDurationSec: 60, settings: { captions: false } });
  const chapter = addChapter(studio, project.id, { title: "Only chapter" });
  const scene = addScene(studio, chapter.id, { title: "Panel", type: "remotion-2d", narration: SAMPLE_SPEC.narration });
  const saved = saveSpec(studio, scene.id, { ...SAMPLE_SPEC, title: "Panel", visual: { ...SAMPLE_SPEC.visual, transitionIn: "cut" } }, "test");
  assert.ok(saved.ok);
  fs.writeFileSync(versionPaths(studio, project, saved.version).source!, PANEL);
  const p = projectPaths(studio, project);

  /** Where the panel's left edge is on each row of its middle part, for two frames a second apart. */
  const edges = async () => {
    const out: number[][] = [];
    for (const still of await renderSceneStills(studio, scene.id, { frames: [2, 32] })) {
      const file = p.abs(still.file);
      const size = pngSize(file);
      assert.equal(size.width, 1920);
      const raw = await rawPixels(ffmpeg, file);
      const row: number[] = [];
      for (let y = 260; y < 640; y += 4) {
        let x = 400;
        while (x < 700 && raw[(y * size.width + x) * 3]! < 128) x++;
        row.push(x);
      }
      out.push(row);
    }
    return out;
  };
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

  const clean = await edges();
  assert.equal(spread(clean[0]!), 0, "a clean edge is straight");
  assert.equal(clean[0]![0], 500);
  assert.deepEqual(clean[0], clean[1], "and stays where it is");

  setTheme(studio, project.id, { ...getProject(studio, project.id).settings.theme, look: "hand-drawn" });
  const sketched = await edges();
  for (const edge of sketched) {
    assert.ok(spread(edge) >= 2, `a sketched edge wavers: it moves by ${spread(edge)} pixels along its length`);
    assert.ok(edge.every((x) => Math.abs(x - 500) <= 8), "but only by a few pixels");
  }
  assert.notDeepEqual(sketched[0], sketched[1], "each redraw wavers differently");
  studio.close();
});
