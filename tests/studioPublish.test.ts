import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startServer } from "../packages/server/src/server.js";
import { DESIGN_GUIDE, THUMBNAIL_GUIDE } from "../packages/core/src/paths.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import { systemPrompt } from "../packages/core/src/studio/runs/prompts.js";
import { createProject, getProject, projectPaths } from "../packages/core/src/studio/store/projects.js";
import { listRuns } from "../packages/core/src/studio/store/runs.js";
import { checkThumbnail, getThumbnail, THUMBNAIL_SIZE } from "../packages/core/src/studio/thumbnail.js";
import { callTool } from "../packages/core/src/studio/tools/index.js";
import { checkVoice, previewVoice, setVoice, VOICES } from "../packages/core/src/studio/voices.js";
import { voiceSettings } from "../packages/core/src/studio/voice.js";
import { fullDescription, getYouTubeDetails, parseDetails, TAGS_MAX, tidyDetails, uploadSheet, videoBrief, writeYouTubeDetails } from "../packages/core/src/studio/youtube.js";
import { pngSize } from "./helpers/media.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { BROWSER, needsBrowser, tempStudio } from "./helpers/studio.js";

const DESCRIPTION = "How noise-cancelling headphones erase sound with more sound.";

// ---------- Design guides ----------

test("the design guides exist and the runs that draw are told to read them", () => {
  const scene = fs.readFileSync(DESIGN_GUIDE, "utf8");
  for (const heading of ["## One idea, one focal point", "## Layout", "## Text", "## Colour", "## Motion", "## Before you hand the scene over"]) assert.ok(scene.includes(heading), heading);
  const thumbnail = fs.readFileSync(THUMBNAIL_GUIDE, "utf8");
  for (const heading of ["## The three-element rule", "## Curiosity", "## Text", "## Colour and contrast", "## The stamp test"]) assert.ok(thumbnail.includes(heading), heading);
  assert.ok(systemPrompt("scene").includes(DESIGN_GUIDE));
  assert.ok(systemPrompt("foundation").includes(DESIGN_GUIDE));
  assert.ok(systemPrompt("thumbnail").includes(THUMBNAIL_GUIDE));
  assert.ok(!systemPrompt("chapter").includes(DESIGN_GUIDE), "a run that only writes is not sent to the design guide");
});

// ---------- Voice ----------

test("a project's narrator and pace can be chosen, and a sample is recorded once per voice", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: DESCRIPTION });
  assert.equal(project.settings.voice.kokoroVoice, "af_heart");
  assert.ok(VOICES.length >= 20);
  assert.equal(new Set(VOICES.map((v) => v.id)).size, VOICES.length);
  assert.deepEqual(VOICES.find((v) => v.id === "bm_george"), { id: "bm_george", name: "George", accent: "British", gender: "male" });
  for (const v of VOICES) assert.equal(checkVoice(v.id), v.id);

  const changed = setVoice(studio, project.id, { voice: "BM_George", pace: "slow" });
  assert.deepEqual(changed.settings.voice, { kokoroVoice: "bm_george", pace: "slow" });
  const settings = voiceSettings(studio, changed);
  assert.equal(settings.voice, "bm_george");
  assert.equal(settings.language, "b", "a British voice is spoken as British English");
  // Only the pace: the voice stays.
  assert.deepEqual(setVoice(studio, project.id, { pace: "fast" }).settings.voice, { kokoroVoice: "bm_george", pace: "fast" });
  assert.throws(() => setVoice(studio, project.id, { voice: "George" }), /"George" is not a voice\. A voice is named like af_heart/);
  assert.throws(() => setVoice(studio, project.id, { pace: "brisk" }), /pace is one of: slow, normal, fast/);
  assert.equal(getProject(studio, project.id).settings.voice.kokoroVoice, "bm_george");

  const p = projectPaths(studio, project);
  const sample = await previewVoice(studio, project.id, { voice: "af_bella", pace: "normal" });
  assert.equal(sample.silent, true, "the stand-in voice is silent, and says so");
  assert.ok(fs.statSync(p.abs(sample.file)).size > 1000);
  const made = fs.statSync(p.abs(sample.file)).mtimeMs;
  assert.equal((await previewVoice(studio, project.id, { voice: "af_bella", pace: "normal" })).file, sample.file);
  assert.equal(fs.statSync(p.abs(sample.file)).mtimeMs, made, "the same sample is not recorded twice");
  assert.notEqual((await previewVoice(studio, project.id, { voice: "af_bella", pace: "slow" })).file, sample.file);
  // Listening to a voice does not choose it.
  assert.equal(getProject(studio, project.id).settings.voice.kokoroVoice, "bm_george");
  await assert.rejects(previewVoice(studio, project.id, { voice: "nobody" }), /is not a voice/);
  studio.close();
});

// ---------- Upload details ----------

test("upload details are brought inside what YouTube accepts", () => {
  const tidy = tidyDetails({
    title: `  How   <b>GPS</b> works ${"very ".repeat(30)}well `,
    description: "Line one.\r\n\r\nLine <two>.",
    tags: ["GPS", "gps", "#satellites", "how gps works", "a,b", ...Array.from({ length: 80 }, (_, i) => `filler tag number ${i}`)],
    hashtags: ["#GPS", "space travel!", "gps", "maps", "extra"],
    alternativeTitles: ["How does GPS find you?", "How does GPS find you?"],
  });
  assert.ok(tidy.title.length <= 100 && tidy.title.endsWith("…") && tidy.title.startsWith("How bGPS/b works"), tidy.title);
  assert.equal(tidy.description, "Line one.\n\nLine two.");
  assert.deepEqual(tidy.tags.slice(0, 4), ["gps", "satellites", "how gps works", "ab"]);
  const cost = tidy.tags.reduce((n, t, i) => n + t.length + (t.includes(" ") ? 2 : 0) + (i ? 1 : 0), 0);
  assert.ok(cost <= TAGS_MAX && cost > TAGS_MAX - 30, `the tags use ${cost} of ${TAGS_MAX} characters`);
  assert.deepEqual(tidy.hashtags, ["GPS", "spacetravel", "gps"]);
  assert.deepEqual(tidy.alternativeTitles, ["How does GPS find you?"]);
  assert.throws(() => tidyDetails({ title: "Only a title" }), /did not give a title and a description/);

  // Claude's answer, with a sentence and a code fence around it.
  const parsed = parseDetails('Here it is:\n```json\n{"title": "How GPS works", "description": "Satellites and clocks.", "tags": "gps, satellites", "hashtags": ["gps"]}\n```');
  assert.deepEqual([parsed.title, parsed.tags, parsed.hashtags], ["How GPS works", ["gps", "satellites"], ["gps"]]);
  assert.throws(() => parseDetails("I would call it GPS."), /could not be read/);

  const chapters = [
    { title: "The question", time: "0:00" },
    { title: "How it works", time: "0:31" },
  ];
  assert.equal(fullDescription(parsed, chapters), "Satellites and clocks.\n\nChapters\n0:00 The question\n0:31 How it works\n\n#gps");
  assert.equal(fullDescription(parsed, chapters.slice(0, 1)), "Satellites and clocks.\n\n#gps", "one chapter is no chapter list");
  const sheet = uploadSheet(parsed, chapters);
  assert.match(sheet, /^TITLE\nHow GPS works\n\nDESCRIPTION\nSatellites and clocks\./);
  assert.match(sheet, /TAGS \(paste into the Tags box\)\ngps, satellites\n$/);
});

test("upload details are written from the video's plan and narration, kept with the project and editable", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const server = await startServer(studio, { port: 0, orchestrator: o });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}${path}`, { method, headers: { "x-studio": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: (await res.json()) as any };
  };
  try {
    const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 60 });
    o.startStage(project.id);
    await o.idle();
    for (const stage of ["bible", "foundation", "chapters", "scenes"]) {
      assert.equal(o.approveStage(project.id).stage, stage);
      await o.idle();
    }
    assert.equal(getYouTubeDetails(studio, project.id), undefined);
    assert.equal((await call("GET", `/api/projects/${project.slug}`)).data.youtube, null);

    // What Claude is given: the request, the outline, the chapters and every word of narration.
    const brief = videoBrief(studio, project.id, "Aim it at students.");
    for (const part of [DESCRIPTION, "Outline:", "Chapters:", "Narration:", "Aim it at students."]) assert.ok(brief.includes(part), part);

    const written = await call("POST", `/api/projects/${project.slug}/youtube`, {});
    assert.equal(written.status, 200, JSON.stringify(written.data));
    assert.equal(written.data.title, project.title);
    assert.ok(written.data.tags.includes("animated explainer"));
    assert.equal(written.data.hashtags.length, 3);
    assert.deepEqual((await call("GET", `/api/projects/${project.slug}`)).data.youtube.title, project.title);

    // The person's edits are held to the same limits, and what they did not touch stays.
    const edited = await call("PATCH", `/api/projects/${project.slug}/youtube`, { title: "How headphones cancel noise", tags: "Noise Cancelling, headphones, noise cancelling" });
    assert.deepEqual([edited.data.title, edited.data.tags], ["How headphones cancel noise", ["noise cancelling", "headphones"]]);
    assert.equal(edited.data.description, written.data.description);
    const emptied = await call("PATCH", `/api/projects/${project.slug}/youtube`, { title: "  " });
    assert.equal(emptied.status, 400);
    assert.equal(getYouTubeDetails(studio, project.id)!.title, "How headphones cancel noise", "an empty title is refused and nothing changes");
    // Written again: the stand-in runner's answer replaces the edits.
    assert.equal((await writeYouTubeDetails(studio, project.id)).title, project.title);
  } finally {
    await server.close();
    o.stop();
    studio.close();
  }
});

// ---------- Thumbnail ----------

const THUMB = `import React from "react";
import { useTheme } from "@pipeline/lib";

export default function Thumbnail() {
  const t = useTheme();
  return (
    <div style={{ position: "absolute", inset: 0, background: t.palette.background }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: t.width / 2, height: t.height, background: "#FF0000" }} />
      <div style={{ position: "absolute", left: 80, top: 260, fontSize: 150, fontWeight: 900, color: "#FFFFFF", fontFamily: t.fontFamily }}>WHY?</div>
    </div>
  );
}
`;

test("a thumbnail run designs through its own tool, and only a still picture passes", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 60 });
  assert.throws(() => o.designThumbnail(project.id), /Wait until the outline is written/);
  o.startStage(project.id);
  await o.idle();

  // Designing a thumbnail holds no stage back and is not counted as the stage's work.
  const before = o.stageStatus(project.id);
  o.designThumbnail(project.id);
  assert.equal(o.stageStatus(project.id).running, before.running);
  assert.deepEqual(o.stageStatus(project.id).waitingOn, before.waitingOn);
  assert.throws(() => o.designThumbnail(project.id), /already being worked on/);
  await o.idle();
  const run = listRuns(studio, project.id).find((r) => r.targetKind === "thumbnail")!;
  assert.equal(run.status, "done", run.error ?? "");
  assert.equal(run.agent, "thumbnail-designer");
  const first = getThumbnail(studio, project.id)!;
  assert.equal(first.version, 1);
  assert.equal(first.image, null, "the stand-in runner without a browser saves the design and draws nothing");
  assert.ok(fs.existsSync(projectPaths(studio, project).abs(first.source)));

  // Asking for changes makes the next version.
  o.designThumbnail(project.id, "Sound waves");
  await o.idle();
  const second = getThumbnail(studio, project.id)!;
  assert.deepEqual([second.version, second.text], [2, "SOUND WAVES"]);

  // The tool belongs to thumbnail runs, and refuses what cannot be a thumbnail.
  const ctx = { studio, projectId: project.id, run, log: () => {} };
  const other = { ...ctx, run: listRuns(studio, project.id).find((r) => r.targetKind === "outline")! };
  assert.equal((await callTool(other, "thumbnail_save", { code: THUMB })).ok, false);
  const moving = await checkThumbnail(studio, project, THUMB.replace("const t = useTheme();", "const t = useTheme();\n  const f = useCurrentFrame();").replace('import React from "react";', 'import React from "react";\nimport { useCurrentFrame } from "remotion";'));
  assert.match(moving.join(" "), /one still picture, so useCurrentFrame has no place in it/);
  assert.match((await checkThumbnail(studio, project, THUMB.replace('from "@pipeline/lib"', 'from "lodash"'))).join(" "), /lodash/);
  assert.match((await checkThumbnail(studio, project, THUMB.replace("t.palette.background", "t.palette.backdrop"))).join(" "), /backdrop/);
  const wordy = (await callTool(ctx, "thumbnail_save", { code: THUMB, text: "why does this happen to everyone always" })).output as any;
  assert.equal(wordy.saved, false);
  assert.match(wordy.problems.join(" "), /has 7 words\. Four is the most/);
  assert.equal(getThumbnail(studio, project.id)!.version, 2, "a refused design replaces nothing");
  o.stop();
  studio.close();
});

test("with a browser: the thumbnail is drawn at 1280 by 720 and small, and shown in the studio", needsBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER } });
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const server = await startServer(studio, { port: 0, orchestrator: o });
  try {
    const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 60 });
    const p = projectPaths(studio, project);
    o.startStage(project.id);
    await o.idle();
    const outline = listRuns(studio, project.id).find((r) => r.targetKind === "outline")!;
    const run = { ...outline, targetKind: "thumbnail" as const };
    const result = await callTool({ studio, projectId: project.id, run, log: () => {} }, "thumbnail_save", { code: THUMB, text: "WHY?", idea: "A question with no answer in sight." });
    const saved = result.output as any;
    assert.equal(saved.saved, true, JSON.stringify(saved));
    assert.deepEqual(saved.size, THUMBNAIL_SIZE);
    // Claude is shown both: the full picture, and the size it is judged at.
    const images = result.images!;
    assert.equal(images.length, 2);
    assert.deepEqual(pngSize(images[0]!.file), { width: 1280, height: 720 });
    assert.deepEqual(pngSize(images[1]!.file), { width: 320, height: 180 });
    assert.match(images[1]!.caption, /Judge this one with the stamp test/);

    const t = getThumbnail(studio, project.id)!;
    assert.deepEqual([t.version, t.text, t.idea], [1, "WHY?", "A question with no answer in sight."]);
    const snap = (await (await fetch(`${server.url}/api/projects/${project.slug}`, { headers: { "x-studio": "1" } })).json()) as any;
    assert.equal(snap.thumbnail.design.text, "WHY?");
    const picture = await fetch(`${server.url}${snap.thumbnail.design.url}`);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers.get("content-type"), "image/png");

    // A second save replaces the first and removes its pictures.
    const again = (await callTool({ studio, projectId: project.id, run, log: () => {} }, "thumbnail_save", { code: THUMB.replace("WHY?", "HOW?"), text: "HOW?" })).output as any;
    assert.equal(again.version, 2);
    assert.deepEqual(fs.readdirSync(p.at("thumbnail")).sort(), ["thumbnail-v2-small.png", "thumbnail-v2.png", "thumbnail.json", "thumbnail.tsx"]);
  } finally {
    await server.close();
    o.stop();
    studio.close();
  }
});
