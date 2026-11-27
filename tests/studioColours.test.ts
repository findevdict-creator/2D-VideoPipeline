import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../packages/server/src/server.js";
import { contrast, paletteWarnings, PALETTES, ThemeSchema } from "../packages/core/src/studio/model/project.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import { clipCacheKey, qualitySettings, sceneContext } from "../packages/core/src/studio/scenes/render.js";
import { createProject, getProject } from "../packages/core/src/studio/store/projects.js";
import { chooseColours, getScene, listScenes } from "../packages/core/src/studio/store/scenes.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { tempStudio } from "./helpers/studio.js";

const themeOf = (studio: Parameters<typeof getProject>[0], id: string) => getProject(studio, id).settings.theme;

test("every ready-made colour scheme is valid and easy to read", () => {
  assert.ok(PALETTES.length >= 6);
  assert.equal(new Set(PALETTES.map((p) => p.id)).size, PALETTES.length);
  for (const scheme of PALETTES) {
    assert.ok(ThemeSchema.safeParse({ palette: scheme.palette }).success, scheme.id);
    assert.deepEqual(paletteWarnings(scheme.palette), [], scheme.id);
  }
  assert.equal(Math.round(contrast("#000000", "#FFFFFF")), 21);
  assert.equal(contrast("#123456", "#123456"), 1);
  assert.deepEqual(paletteWarnings({ ...PALETTES[0]!.palette, text: "#1E293B", accent: "#101A2E" }), [
    "The text colour is hard to read on the background.",
    "The text colour is hard to read on cards and panels.",
    "The accent colour barely stands out from the background.",
  ]);
});

test("a person picks a scheme, single colours or a font, and what they did not name stays", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: "How the tides follow the moon, for curious adults." });
  const before = themeOf(studio, project.id);
  assert.equal(before.locked, false);

  const paper = chooseColours(studio, project.id, { scheme: "Paper" });
  assert.deepEqual(paper.theme.palette, PALETTES.find((p) => p.id === "paper")!.palette);
  assert.equal(paper.theme.locked, true);
  assert.equal(paper.theme.fontFamily, before.fontFamily);
  assert.equal(paper.theme.visualStyle, before.visualStyle);

  // One colour and the font: the other five colours stay. Hex is stored in capitals.
  const own = chooseColours(studio, project.id, { palette: { primary: "#ff6b00" }, fontFamily: " Georgia " });
  assert.deepEqual(own.theme.palette, { ...paper.theme.palette, primary: "#FF6B00" });
  assert.equal(themeOf(studio, project.id).fontFamily, "Georgia");

  // A scheme with one colour laid over it.
  assert.equal(chooseColours(studio, project.id, { scheme: "forest", palette: { accent: "#FFFFFF" } }).theme.palette.accent, "#FFFFFF");

  // A choice that is hard to read is saved, with a warning: it is the person's call.
  assert.deepEqual(chooseColours(studio, project.id, { palette: { text: "#0E2A20" } }).warnings.slice(0, 1), ["The text colour is hard to read on the background."]);

  const saved = JSON.stringify(themeOf(studio, project.id));
  assert.throws(() => chooseColours(studio, project.id, { scheme: "neon" }), /no colour scheme called "neon"\. The schemes are: midnight, paper/);
  assert.throws(() => chooseColours(studio, project.id, { palette: { primary: "orange" } }), /primary: must be a hex colour like #1A2B3C/);
  assert.throws(() => chooseColours(studio, project.id, { palette: { border: "#FFFFFF" } as never }), /"border" is not one of the colours/);
  assert.equal(JSON.stringify(themeOf(studio, project.id)), saved, "a refused choice changes nothing");
  studio.close();
});

test("Claude keeps the colours and font the person chose, and takes them back when the person says so", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const project = createProject(studio, { description: "How noise-cancelling headphones erase sound with more sound.", targetDurationSec: 60 });
  // Chosen before Claude has written anything.
  chooseColours(studio, project.id, { scheme: "paper", fontFamily: "Georgia" });
  o.startStage(project.id);
  await o.idle();
  assert.equal(o.approveStage(project.id).stage, "bible");
  await o.idle();
  // The bible run set a theme of its own. The person's colours and font are still there; its style words were taken.
  let theme = themeOf(studio, project.id);
  assert.deepEqual(theme.palette, PALETTES.find((p) => p.id === "paper")!.palette);
  assert.equal(theme.fontFamily, "Georgia");
  assert.equal(theme.locked, true);
  assert.match(theme.visualStyle, /Flat vector shapes/);

  // Handing the choice back changes no picture by itself. The next bible run chooses.
  assert.deepEqual(chooseColours(studio, project.id, { locked: false }).stale, []);
  assert.deepEqual(themeOf(studio, project.id).palette, theme.palette);
  o.startStage(project.id, "Warmer.");
  await o.idle();
  theme = themeOf(studio, project.id);
  assert.equal(theme.palette.background, "#0B1D33");
  assert.equal(theme.locked, false);
  o.stop();
  studio.close();
});

test("new colours put drawn scenes out of date and change their clips; who chose them changes nothing", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const server = await startServer(studio, { port: 0, orchestrator: o });
  const post = async (slug: string, body: unknown) => {
    const res = await fetch(`${server.url}/api/projects/${slug}/colours`, { method: "POST", headers: { "x-studio": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as any };
  };
  try {
    const project = createProject(studio, { description: "How noise-cancelling headphones erase sound with more sound.", targetDurationSec: 60 });
    o.startStage(project.id);
    await o.idle();
    for (const stage of ["bible", "foundation", "chapters", "scenes"]) {
      assert.equal(o.approveStage(project.id).stage, stage);
      await o.idle();
    }
    const [first] = listScenes(studio, project.id);
    const keyOf = async () => clipCacheKey(await sceneContext(studio, first!.id), qualitySettings(studio, "preview"));
    const before = await keyOf();
    const snapshot = async () => (await (await fetch(`${server.url}/api/projects/${project.slug}`, { headers: { "x-studio": "1" } })).json()) as any;
    assert.deepEqual((await snapshot()).colours.schemes.map((s: any) => s.id), PALETTES.map((p) => p.id));

    // Locking the colours as they are: nothing is redrawn.
    const lock = await post(project.slug, { locked: true });
    assert.equal(lock.data.scenesNowStale, 0);
    assert.equal(await keyOf(), before);

    const changed = await post(project.slug, { scheme: "sunset", fontFamily: "Verdana" });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    assert.equal(changed.data.scenesNowStale, 2);
    assert.deepEqual(changed.data.warnings, []);
    assert.equal(getScene(studio, first!.id).status, "stale");
    assert.match(getScene(studio, first!.id).staleReason!, /colours or font changed/);
    assert.notEqual(await keyOf(), before);
    const style = (await sceneContext(studio, first!.id)).data.style as unknown as Record<string, unknown>;
    assert.equal((style.palette as any).background, "#2B1330");
    assert.equal(style.fontFamily, "Verdana");
    assert.equal("locked" in style, false);

    // One action redraws them without a Claude run.
    assert.equal(o.rebuildStale(project.id).length, 2);
    await o.idle();

    const bad = await post(project.slug, { palette: { text: "white" } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /text: must be a hex colour/);
  } finally {
    await server.close();
    o.stop();
    studio.close();
  }
});
