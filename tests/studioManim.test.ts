import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../packages/core/src/config.js";
import { MANIM_EXAMPLE } from "../packages/core/src/paths.js";
import { assemble } from "../packages/core/src/studio/assemble.js";
import { ffmpeg, probe } from "../packages/core/src/studio/media/ffmpeg.js";
import { manimSceneData, manimStatus } from "../packages/core/src/studio/renderers/manim.js";
import { availableSceneTypes } from "../packages/core/src/studio/renderers/registry.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import { checkScene, renderSceneClip, renderSceneStills, sceneContext } from "../packages/core/src/studio/scenes/render.js";
import { addChapter } from "../packages/core/src/studio/store/chapters.js";
import { createProject, projectPaths, type Project } from "../packages/core/src/studio/store/projects.js";
import { addScene, approveScene, currentVersion, getScene, saveSpec, versionPaths } from "../packages/core/src/studio/store/scenes.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { LIB_EXAMPLE_3D } from "../packages/core/src/paths.js";
import { rawPixels, shareOfPixels } from "./helpers/media.js";
import { BROWSER, REPO, SAMPLE_SPEC, sceneCode, tempStudio } from "./helpers/studio.js";

// Manim tests run where Manim is installed: after `npm run setup:manim`, or with MANIM_PYTHON set.
const MANIM = manimStatus(loadConfig({ rootDir: REPO, runner: "mock" }));
const needsManim = { skip: !MANIM.available && "run npm run setup:manim, or set MANIM_PYTHON, to run", timeout: 600_000 } as const;
const needsManimAndBrowser = { skip: (!MANIM.available && "needs Manim") || (!BROWSER && "set REMOTION_BROWSER_EXECUTABLE to run"), timeout: 900_000 } as const;

const NO_PYTHON = { manim: { python: path.join(os.tmpdir(), "no-such-python"), timeoutSec: 600, latex: "auto" as const } };

/** A project with one Manim scene whose code is `code`, with the sample narration and its cues "sat" and "phone". */
function manimScene(studio: Studio, code: string, project?: Project) {
  project ??= createProject(studio, { description: "Why the squares on a right triangle add up", targetDurationSec: 60 });
  const chapter = addChapter(studio, project.id, { title: "Only chapter" });
  const scene = addScene(studio, chapter.id, { title: "In symbols", type: "manim", narration: SAMPLE_SPEC.narration });
  const saved = saveSpec(studio, scene.id, { ...SAMPLE_SPEC, type: "manim", title: "In symbols" }, "test");
  assert.ok(saved.ok, saved.ok ? "" : saved.problems.join("; "));
  const file = versionPaths(studio, project, saved.version).source!;
  fs.writeFileSync(file, code);
  return { project, chapter, scene, file };
}

const body = (lines: string) => `from manim import *
from pipeline_manim import StudioScene, safe, theme


class Main(StudioScene):
    def build(self):
${lines
  .trim()
  .split("\n")
  .map((l) => `        ${l}`)
  .join("\n")}
`;

/** A red square appears the moment "sat" is spoken, a green one the moment "phone" is. Nothing fades: the frame it happens in can be found. */
const ON_CUE = body(`
red = Square(3, color="#FF0000", fill_opacity=1).move_to(LEFT * 3)
green = Square(3, color="#00FF00", fill_opacity=1).move_to(RIGHT * 3)
self.wait_until("sat")
self.add(red)
self.wait_until("phone")
self.add(green)
`);

const red = (r: number, g: number, b: number) => r > 180 && g < 80 && b < 80;
const green = (r: number, g: number, b: number) => g > 180 && r < 80 && b < 80;

test("without Manim installed, a Manim scene says what to run, and the type is not offered", async () => {
  const studio = await tempStudio({ render: NO_PYTHON });
  assert.ok(!availableSceneTypes(studio).includes("manim"));
  const { scene } = manimScene(studio, ON_CUE);
  const problems = await checkScene(studio, scene.id);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /npm run setup:manim/);
  await assert.rejects(renderSceneClip(studio, scene.id, "preview"), /npm run setup:manim/);
  studio.close();
});

test("a Manim scene gets its look, length and cue times from the studio", async () => {
  const studio = await tempStudio({ render: NO_PYTHON });
  const { scene } = manimScene(studio, ON_CUE);
  const ctx = await sceneContext(studio, scene.id);
  const data = manimSceneData(ctx.data);
  assert.equal(data.style.palette.background, ctx.project.settings.theme.palette.background);
  assert.equal(data.style.fontFamily, ctx.project.settings.theme.fontFamily);
  assert.equal(Math.round(data.durationSec * data.fps), ctx.data.scenes[0]!.durationInFrames);
  assert.deepEqual(data.cues.map((c) => c.id), ["sat", "phone"]);
  assert.ok(data.cues[1]!.startSec > data.cues[0]!.startSec);
  assert.ok(data.captionSafeArea > 0, "captions are on, so the scene is told to keep their strip free");
  studio.close();
});

test("the Manim check: allowed imports only, no files, the right class, real cues, and errors with their line", needsManim, async () => {
  const studio = await tempStudio();
  assert.ok(availableSceneTypes(studio).includes("manim"));
  const { scene, file } = manimScene(studio, ON_CUE);
  assert.deepEqual(await checkScene(studio, scene.id), []);
  const check = async (code: string) => {
    fs.writeFileSync(file, code);
    return (await checkScene(studio, scene.id)).join("\n");
  };

  assert.match(await check(`import os\n${ON_CUE}`), /line 1: "import os" is not allowed\. Scenes may import only: manim, numpy, math, pipeline_manim/);
  assert.match(await check(`from urllib.request import urlopen\n${ON_CUE}`), /"from urllib\.request import \.\.\." is not allowed/);
  assert.match(await check(`import subprocess\n${ON_CUE}`), /"import subprocess" is not allowed/);
  assert.match(await check(body(`data = open("/etc/passwd").read()`)), /open\(\): Scenes may not read or write files/);
  assert.match(await check(body(`points = np.load("points.npy")`)), /\.load: numpy\.load reads a file/);
  assert.match(await check(body(`exec("import os")`)), /exec\(\): Scenes may not run code from text/);
  assert.match(await check(body(`cls = self.__class__.__mro__`)), /may not reach into Python's internals/);
  assert.match(await check(body(`picture = ImageMobject("photo.png")`)), /ImageMobject: Manim scenes cannot load image files yet/);
  assert.match(await check(body(`config.frame_rate = 12`)), /config: The studio sets the frame size/);
  assert.match(await check(ON_CUE.replace("class Main(StudioScene)", "class Main(Scene)")), /Main must extend StudioScene/);
  assert.match(await check(ON_CUE.replace("def build(self)", "def construct(self)")), /Main needs a build\(self\) method[\s\S]*Write build\(self\), not construct\(self\)/);
  assert.match(await check(ON_CUE.replace("class Main", "class Other")), /must define the scene as: class Main\(StudioScene\)/);
  assert.match(await check(ON_CUE.replace('"phone"', '"telephone"')), /wait_until\("telephone"\): there is no cue with that id in the scene's spec\. Cues: phone, sat/);
  assert.match(await check(body(`self.play(Create(Circle()))\n    pass`)), /syntax error|IndentationError|unexpected indent/);

  // Mistakes only running the scene finds, reported with the line they are on.
  assert.match(await check(body(`self.wait_until("sat")\nself.play(Create(Circl()))`)), /line 8: NameError: name 'Circl' is not defined/);

  // Animations that run past their cue, or past the end of the narration, are problems: the picture would be late or cut off.
  assert.match(await check(body(`self.play(Create(Circle()), run_time=4)\nself.wait_until("sat")`)), /The cue "sat" is spoken at [\d.]+s, but the animations before it run until 4\.00s/);
  assert.match(await check(body(`self.wait_until("phone")\nself.play(Create(Circle()), run_time=30)`)), /the narration is [\d.]+s long, so the last [\d.]+s are cut off/);

  // The example in the guide passes with cues of its own.
  const example = fs.readFileSync(MANIM_EXAMPLE, "utf8").replace('wait_until("triangle")', 'wait_until("sat")').replace('wait_until("squares")', 'wait_until("phone")').replace('self.wait_until("area", lead=0.3)', "self.wait(0.2)");
  assert.equal(await check(example.replace("run_time=1.6", "run_time=0.6").replace("run_time=1.2", "run_time=0.5").replace("run_time=0.8)\n", "run_time=0.3)\n")), "");
  studio.close();
});

test("a Manim scene's animations land on their cues, and its clip is as long as the narration", needsManimAndBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER } });
  const { project, scene } = manimScene(studio, ON_CUE);
  assert.deepEqual(await checkScene(studio, scene.id), []);
  const ctx = await sceneContext(studio, scene.id);
  const fps = project.fps;
  const cue = (id: string) => ctx.data.scenes[0]!.cues.find((c) => c.elementId === id)!.startFrame;
  const total = ctx.data.scenes[0]!.durationInFrames;

  // What Manim measured while running the scene: each wait ended within a frame of the cue.
  const measured = JSON.parse(fs.readFileSync(path.join(ctx.workDir, "manim", "check.json"), "utf8")).answer.cues as { id: string; reachedSec: number }[];
  for (const m of measured) assert.ok(Math.abs(m.reachedSec * fps - cue(m.id)) <= 1, `"${m.id}" was reached at frame ${m.reachedSec * fps}, its cue is at ${cue(m.id)}`);

  // And what is in the picture: two frames before a cue its square is not there, two frames after it is.
  const frames = [cue("sat") - 2, cue("sat") + 2, cue("phone") - 2, cue("phone") + 2, total - 1];
  const stills = await renderSceneStills(studio, scene.id, { frames });
  const p = projectPaths(studio, project);
  const share = (i: number, colour: typeof red) => shareOfPixels(ffmpeg, p.abs(stills[i]!.file), colour);
  assert.ok((await share(0, red)) < 0.001, "no red square before its cue");
  assert.ok((await share(1, red)) > 0.05, "the red square is there two frames after its cue");
  assert.ok((await share(2, green)) < 0.001, "no green square before its cue");
  assert.ok((await share(3, green)) > 0.05, "the green square is there two frames after its cue");
  assert.ok((await share(4, red)) > 0.05 && (await share(4, green)) > 0.05, "both are still there on the last frame");

  // The clip is exactly as long as the narration and the size of every other clip, so it joins without re-encoding.
  const { clip } = await renderSceneClip(studio, scene.id, "preview");
  assert.equal(clip.durationFrames, total);
  const info = await probe(p.abs(clip.path));
  assert.equal(info.width, project.width * studio.config.render.previewScale);
  assert.ok(Math.abs(info.durationSec! - total / fps) < 0.05);

  // Nothing changed, so asking again draws nothing. Changing the code draws it again.
  assert.equal((await renderSceneClip(studio, scene.id, "preview")).cached, true);
  fs.writeFileSync(versionPaths(studio, project, currentVersion(studio, getScene(studio, scene.id))!).source!, ON_CUE.replace("#FF0000", "#FF0001"));
  assert.equal((await renderSceneClip(studio, scene.id, "preview")).cached, false);
  studio.close();
});

test("without LaTeX, equations are shown as plain text and the check says so", needsManimAndBrowser, async () => {
  // LaTeX switched off behaves as on a machine that does not have it.
  const studio = await tempStudio({ render: { browserExecutable: BROWSER, manim: { python: MANIM.python, timeoutSec: 600, latex: "off" } } });
  const code = body(`
equation = MathTex("a^2", "+", "b^2", "=", r"\\frac{c^4}{c^2}", font_size=96).move_to(safe.center)
equation[0].set_color("#FF0000")
axes = Axes(x_range=[0, 3, 1], y_range=[0, 2, 1], x_length=4, y_length=2).add_coordinates().to_corner(UL)
self.add(equation, axes, DecimalNumber(3.14).to_corner(UR))
self.wait_until("sat")
`);
  const { project, scene } = manimScene(studio, code);
  assert.deepEqual(await checkScene(studio, scene.id), [], "plain-text equations do not stop the scene");
  const notes = currentVersion(studio, getScene(studio, scene.id))!.checkNotes.join("\n");
  // "Switched off" where LaTeX is installed, "not installed" where it is not: the picture is the same.
  assert.match(notes, /LaTeX is (switched off|not installed)[\s\S]*shown as plain text in the video's font, for example "a\^2 \+ b\^2 = \\frac\{c\^4\}\{c\^2\}"/);

  const [still] = await renderSceneStills(studio, scene.id, { frames: [30] });
  const file = projectPaths(studio, project).abs(still!.file);
  assert.ok((await shareOfPixels(ffmpeg, file, red)) > 0.0005, "the first part of the equation is drawn, in the colour it was given");
  studio.close();
});

test("a video of 2D, 3D and Manim scenes assembles, with one palette and one font", needsManimAndBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER } });
  const project = createProject(studio, { description: "Three ways to draw one idea", targetDurationSec: 60 });
  const chapter = addChapter(studio, project.id, { title: "Only chapter" });
  const add = (type: "remotion-2d" | "r3f" | "manim", title: string, code: string) => {
    const scene = addScene(studio, chapter.id, { title, type, narration: SAMPLE_SPEC.narration });
    const saved = saveSpec(studio, scene.id, { ...SAMPLE_SPEC, type, title }, "test");
    assert.ok(saved.ok);
    fs.writeFileSync(versionPaths(studio, project, saved.version).source!, code);
    return scene;
  };
  const scenes = [
    add("remotion-2d", "Flat", sceneCode("Flat").replace("<Background stars />", "<Background />")),
    add("r3f", "Deep", fs.readFileSync(LIB_EXAMPLE_3D, "utf8")),
    add("manim", "Exact", body(`label = Text("Exact", font_size=72).move_to(safe.center)\nself.wait_until("sat")\nself.play(Write(label), run_time=0.6)`)),
  ];
  const p = projectPaths(studio, project);
  const background = project.settings.theme.palette.background;
  const want = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16));
  for (const scene of scenes) {
    assert.deepEqual(await checkScene(studio, scene.id), [], `${scene.title} passes its check`);
    const { clip } = await renderSceneClip(studio, scene.id, "final");
    approveScene(studio, scene.id);
    // The top left corner is plain background in all three: the same colour, whichever tool drew it.
    const raw = await rawPixels(ffmpeg, p.abs(clip.path), 1.5);
    for (const c of [0, 1, 2]) assert.ok(Math.abs(raw[3 * 10 + c]! - want[c]!) <= 6, `${scene.title}: background is ${[raw[30], raw[31], raw[32]]}, the palette's is ${want}`);
  }
  // Manim wrote its text in the video's font, as the other scenes do.
  const manimDir = path.join(p.work, scenes[2]!.id, "manim");
  const answer = JSON.parse(fs.readFileSync(path.join(manimDir, "check.json"), "utf8")).answer;
  assert.ok([project.settings.theme.fontFamily, "Inter"].includes(answer.font), `Manim used "${answer.font}"`);

  const result = await assemble(studio, project.id, { quality: "final" });
  const info = await probe(result.file);
  const frames = (await Promise.all(scenes.map((s) => sceneContext(studio, s.id)))).reduce((n, c) => n + c.data.scenes[0]!.durationInFrames, 0);
  assert.ok(Math.abs(info.durationSec! - frames / project.fps) < 0.1, `the video is ${info.durationSec}s, its three scenes add up to ${frames / project.fps}s`);
  studio.close();
});

test("the stand-in for Claude builds a Manim scene through the same tools", needsManim, async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: "Why the squares on a right triangle add up", targetDurationSec: 60 });
  const chapter = addChapter(studio, project.id, { title: "Only chapter" });
  const scene = addScene(studio, chapter.id, { title: "A curve", type: "manim", narration: SAMPLE_SPEC.narration });
  const runner = new MockStudioRunner();
  const o = new NoRenderOrchestrator(studio, runner);
  const run = o.buildScene(scene.id);
  await o.idle();
  assert.deepEqual(runner.calls.filter((c) => c.runId === run.id && !c.ok), []);
  const version = currentVersion(studio, getScene(studio, scene.id))!;
  assert.equal(path.basename(version.sourcePath!), "scene.py");
  assert.deepEqual(version.checkProblems, []);
  assert.match(fs.readFileSync(projectPaths(studio, project).abs(version.sourcePath!), "utf8"), /class Main\(StudioScene\)/);
  studio.close();
});
