import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { startServer } from "../packages/server/src/server.js";
import { findImage, generateImage, generatedInfo, imageKey, imageStatus, requestImage, saveImageKey, setImagesEnabled } from "../packages/core/src/studio/images.js";
import { grayPng } from "../packages/core/src/studio/renderers/gpu.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import { checkSpecAssets } from "../packages/core/src/studio/scenes/validate.js";
import { getAsset, listAssets } from "../packages/core/src/studio/store/assets.js";
import { addChapter } from "../packages/core/src/studio/store/chapters.js";
import { createProject, getProject, projectPaths } from "../packages/core/src/studio/store/projects.js";
import { createRun } from "../packages/core/src/studio/store/runs.js";
import { addScene, getScene, saveSpec, setSceneStatus } from "../packages/core/src/studio/store/scenes.js";
import { callTool } from "../packages/core/src/studio/tools/index.js";
import { pngSize } from "./helpers/media.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { tempStudio } from "./helpers/studio.js";

// A key in the environment of whoever runs the tests must not reach them.
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;

const DESCRIPTION = "How a lighthouse lens throws its beam thirty kilometres out to sea.";
const PROMPT = "A watercolour of a lighthouse on a cliff at dusk, soft warm light, no text";
const KEY = "AIzaTestKey_0123456789abcdefghij";

/** Stands in for Google: records what it was sent and answers in the shape asked for. */
async function fakeGoogle(answer: (url: string, body: any) => { status?: number; json: unknown }) {
  const calls: { url: string; key: string | undefined; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      calls.push({ url: req.url ?? "", key: req.headers["x-goog-api-key"] as string | undefined, body });
      const a = answer(req.url ?? "", body);
      res.writeHead(a.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(a.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { endpoint, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

const PNG = grayPng(160, 90, [200, 80, 40]);

test("images are off for a new video, and nothing is made until the person allows it", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: DESCRIPTION });
  assert.equal(project.settings.images.enabled, false);
  assert.deepEqual(imageStatus(studio, project.id), { enabled: false, ready: false, engine: "mock", model: "gemini-nano-banana-2.1", keyFrom: null, madeByClaude: 0, limit: 30 });
  await assert.rejects(generateImage(studio, project.id, { prompt: PROMPT, by: "you" }), /switched off for this video/);
  assert.equal(listAssets(studio, project.id).length, 0);

  setImagesEnabled(studio, project.id, true);
  assert.equal(imageStatus(studio, project.id).ready, true, "the stand-in engine needs no key");
  const { asset } = await generateImage(studio, project.id, { prompt: PROMPT, label: "Lighthouse at dusk", by: "you" });
  const p = projectPaths(studio, project);
  assert.deepEqual([asset.kind, asset.label, asset.width, asset.height], ["image", "Lighthouse at dusk", 320, 180]);
  assert.deepEqual(pngSize(p.abs(asset.path)), { width: 320, height: 180 });
  assert.deepEqual([generatedInfo(asset)?.prompt, generatedInfo(asset)?.by, generatedInfo(asset)?.round], [PROMPT, "you", 0]);
  // The shape follows what was asked, and the video's own shape is the default.
  assert.deepEqual(pngSize(p.abs((await generateImage(studio, project.id, { prompt: `${PROMPT}, upright`, aspect: "9:16", by: "you" })).asset.path)), { width: 180, height: 320 });
  await assert.rejects(generateImage(studio, project.id, { prompt: PROMPT, aspect: "7:5", by: "you" }), /shape is one of/);
  await assert.rejects(generateImage(studio, project.id, { prompt: "a cat", by: "you" }), /Describe the picture/);

  setImagesEnabled(studio, project.id, false);
  await assert.rejects(generateImage(studio, project.id, { prompt: PROMPT, by: "you" }), /switched off/);

  // A project made before this setting existed reads as off, not as broken.
  const old = JSON.parse(studio.db.get<{ settings_json: string }>("SELECT settings_json FROM projects WHERE id = ?", [project.id])!.settings_json);
  delete old.images;
  studio.db.run("UPDATE projects SET settings_json = ? WHERE id = ?", [JSON.stringify(old), project.id]);
  assert.deepEqual(getProject(studio, project.id).settings.images, { enabled: false });
  assert.equal(imageStatus(studio, project.id).enabled, false);
  studio.close();
});

test("the key is kept in the workspace, is never part of what the GUI is sent, and can be forgotten", async () => {
  const studio = await tempStudio({ studio: { images: { engine: "gemini" } } });
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const server = await startServer(studio, { port: 0, orchestrator: o });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${server.url}${url}`, { method, headers: { "x-studio": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, text: await res.text() };
  };
  try {
    const project = createProject(studio, { description: DESCRIPTION });
    assert.deepEqual(imageKey(studio), { key: "", from: null });
    assert.equal((await call("POST", `/api/projects/${project.slug}/images`, { enabled: true })).status, 200);
    assert.equal(imageStatus(studio, project.id).ready, false, "allowed, but there is no key yet");
    const none = await call("POST", `/api/projects/${project.slug}/images/generate`, { prompt: PROMPT });
    assert.equal(none.status, 400);
    assert.match(none.text, /no Google AI Studio key yet/);

    assert.equal((await call("POST", "/api/image-key", { key: "not a key" })).status, 400);
    assert.equal((await call("POST", "/api/image-key", { key: `  ${KEY}\n` })).status, 200);
    assert.deepEqual(imageKey(studio), { key: KEY, from: "studio" });
    assert.ok(fs.existsSync(path.join(studio.workspaceDir, "keys.json")));
    const snap = await call("GET", `/api/projects/${project.slug}`);
    assert.ok(!snap.text.includes(KEY), "the key never leaves the server");
    assert.deepEqual([JSON.parse(snap.text).images.keyFrom, JSON.parse(snap.text).images.ready], ["studio", true]);

    process.env.GEMINI_API_KEY = "AIzaFromTheEnvironment_0123456789";
    assert.equal(imageKey(studio).from, "environment");
    delete process.env.GEMINI_API_KEY;

    assert.equal((await call("POST", "/api/image-key", { key: "" })).status, 200);
    assert.deepEqual(imageKey(studio), { key: "", from: null });
  } finally {
    await server.close();
    studio.close();
  }
});

test("Google is asked in either of its two styles, and its refusals are passed on in its own words", async () => {
  const google = await fakeGoogle((url, body) => {
    if (body.model === "blocked" || url.includes("blocked")) return { json: { outputs: [{ type: "text", text: "I can't make that." }], status: "blocked" } };
    if (url.includes("/interactions")) return { json: { id: "x", outputs: [{ type: "thought" }, { type: "image", mime_type: "image/png", data: PNG.toString("base64") }] } };
    if (url.includes("gone")) return { status: 404, json: { error: { message: "models/gone is not found" } } };
    return { json: { candidates: [{ content: { parts: [{ text: "Here you go" }, { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] } }] } };
  });
  try {
    const cfg = { engine: "gemini" as const, model: "gemini-nano-banana-2.1", api: "interactions" as const, apiKey: "", endpoint: google.endpoint, size: "2K", maxPerProject: 30, timeoutSec: 20 };
    const ref = { mime: "image/png", data: PNG };
    const a = await requestImage(cfg, KEY, { prompt: PROMPT, aspect: "16:9", references: [ref] });
    assert.ok(a.data.equals(PNG) && a.mime === "image/png");
    assert.deepEqual([google.calls[0]!.url, google.calls[0]!.key], ["/v1beta/interactions", KEY]);
    assert.deepEqual(google.calls[0]!.body, {
      model: "gemini-nano-banana-2.1",
      input: [
        { type: "image", mime_type: "image/png", data: PNG.toString("base64") },
        { type: "text", text: PROMPT },
      ],
      response_format: { type: "image", mime_type: "image/png", aspect_ratio: "16:9", image_size: "2K" },
    });

    const b = await requestImage({ ...cfg, api: "generateContent", model: "gemini-2.5-flash-image", size: "" }, KEY, { prompt: PROMPT, aspect: "9:16" });
    assert.ok(b.data.equals(PNG));
    assert.equal(google.calls[1]!.url, "/v1beta/models/gemini-2.5-flash-image:generateContent");
    assert.deepEqual(google.calls[1]!.body, { contents: [{ parts: [{ text: PROMPT }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "9:16" } } });

    await assert.rejects(requestImage({ ...cfg, api: "generateContent", model: "gone" }, KEY, { prompt: PROMPT, aspect: "1:1" }), /Google refused the image \(404\): models\/gone is not found Check studio\.images\.model \("gone"\)/);
    await assert.rejects(requestImage({ ...cfg, model: "blocked" }, KEY, { prompt: PROMPT, aspect: "1:1" }), /answered without a picture\. \(blocked\) It said: I can't make that\./);
    await assert.rejects(requestImage({ ...cfg, endpoint: "http://127.0.0.1:1" }, KEY, { prompt: PROMPT, aspect: "1:1" }), /could not be reached/);
  } finally {
    await google.close();
  }
  // A picture is found wherever it sits, and text that is not a picture is not mistaken for one.
  assert.equal(findImage({ output_image: { data: PNG.toString("base64") } })?.mime, "image/png");
  assert.equal(findImage({ outputs: [{ type: "image", data: "A".repeat(400) }] }), undefined);
  assert.equal(findImage({ text: "no picture here" }), undefined);
});

test("Claude can make images only in a planning or scene run, only when allowed, and only up to the limit", async () => {
  const studio = await tempStudio({ studio: { images: { maxPerProject: 2 } } });
  const project = createProject(studio, { description: DESCRIPTION });
  const chapter = addChapter(studio, project.id, { title: "Only chapter" });
  const scene = addScene(studio, chapter.id, { title: "The lens", type: "illustration", narration: "A lighthouse lens gathers a small flame into one bright beam that sweeps the sea." });
  const run = createRun(studio, { projectId: project.id, kind: "scene", targetId: scene.id, agent: "scene-builder" });
  const ctx = { studio, projectId: project.id, run, log: () => {} };
  const ask = { prompt: PROMPT, label: "Lighthouse" };

  const told = (await callTool(ctx, "project_get", {})).output.generatedImages as { allowed: boolean; note: string };
  assert.equal(told.allowed, false);
  assert.match(told.note, /has not allowed AI-generated images/);
  const off = await callTool(ctx, "image_generate", ask);
  assert.equal(off.ok, false);
  assert.match(String(off.output.refused), /has not allowed AI-generated images/);
  assert.equal(listAssets(studio, project.id).length, 0);

  setImagesEnabled(studio, project.id, true);
  assert.deepEqual([(await callTool(ctx, "project_get", {})).output.generatedImages].map((g: any) => [g.allowed, g.left]), [[true, 2]]);
  const made = await callTool(ctx, "image_generate", ask);
  assert.equal(made.ok, true, JSON.stringify(made.output));
  const assetId = String(made.output.assetId);
  assert.equal(made.images.length, 1, "the run is shown what it made");
  assert.ok(fs.existsSync(made.images[0]!.file));
  assert.equal(generatedInfo(getAsset(studio, assetId))?.by, "claude");
  const listed = ((await callTool(ctx, "asset_list", {})).output.assets as any[])[0];
  assert.deepEqual(listed.generated, { prompt: PROMPT, by: "claude" });

  // The image can go straight into the scene.
  const spec = { type: "illustration", title: "The lens", narration: scene.plan.narration, visual: { description: "The lighthouse" }, cues: [], illustration: { shots: [{ assetId }] } };
  assert.ok(saveSpec(studio, scene.id, spec, "test", (s) => checkSpecAssets(studio, project.id, s)).ok);

  // Making it again keeps the id, changes the picture, and marks a drawn scene out of date.
  setSceneStatus(studio, scene.id, "approved");
  const before = getAsset(studio, assetId);
  const again = await callTool(ctx, "image_generate", { ...ask, prompt: `${PROMPT}, seen from the sea`, replaceAssetId: assetId });
  assert.equal(again.output.assetId, assetId);
  const after = getAsset(studio, assetId);
  assert.notEqual(after.sha256, before.sha256);
  assert.equal(generatedInfo(after)?.round, 1);
  const p = projectPaths(studio, project);
  assert.ok(fs.existsSync(p.abs(after.path)) && !fs.existsSync(p.abs(before.path)), "the old picture is gone");
  assert.deepEqual([getScene(studio, scene.id).status, getScene(studio, scene.id).staleReason], ["stale", 'Its image "Lighthouse" was generated again']);
  assert.equal(listAssets(studio, project.id).length, 1);

  // Two made: the limit. The person can still make their own.
  const third = await callTool(ctx, "image_generate", { ...ask, label: "Another" });
  assert.match(String(third.output.refused), /limit on generated images for this video is reached/);
  assert.equal((await generateImage(studio, project.id, { prompt: `${PROMPT}, by day`, by: "you" })).asset.kind, "image");
  assert.equal(imageStatus(studio, project.id).madeByClaude, 2);

  // A file the person added is theirs, and is never generated over.
  const own = path.join(studio.workspaceDir, "own.png");
  fs.writeFileSync(own, grayPng(64, 36, [1, 2, 3]));
  const { importAsset } = await import("../packages/core/src/studio/store/assets.js");
  const mine = await importAsset(studio, project.id, own);
  await assert.rejects(generateImage(studio, project.id, { prompt: PROMPT, replaceAssetId: mine.id, by: "you" }), /was not generated/);

  // Other kinds of run have no business making pictures.
  const bible = createRun(studio, { projectId: project.id, kind: "bible", agent: "art-director" });
  const refused = await callTool({ ...ctx, run: bible }, "image_generate", ask);
  assert.match(String(refused.output.refused), /not yours to call/);
  studio.close();
});

test("the person generates and regenerates from the GUI's routes", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const server = await startServer(studio, { port: 0, orchestrator: o });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${server.url}${url}`, { method, headers: { "x-studio": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as any };
  };
  try {
    const project = createProject(studio, { description: DESCRIPTION });
    const refused = await call("POST", `/api/projects/${project.slug}/images/generate`, { prompt: PROMPT });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /switched off/);
    await call("POST", `/api/projects/${project.slug}/images`, { enabled: true });
    const made = await call("POST", `/api/projects/${project.slug}/images/generate`, { prompt: PROMPT, label: "Dusk", aspect: "1:1" });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    let snap = (await call("GET", `/api/projects/${project.slug}`)).json;
    assert.deepEqual([snap.images.enabled, snap.images.ready, snap.assets.length], [true, true, 1]);
    assert.deepEqual([snap.assets[0].label, snap.assets[0].width, snap.assets[0].generated.by, snap.assets[0].generated.prompt], ["Dusk", 320, "you", PROMPT]);
    const url = snap.assets[0].url;

    const again = await call("POST", `/api/assets/${made.json.id}/regenerate`, {});
    assert.equal(again.status, 200, JSON.stringify(again.json));
    snap = (await call("GET", `/api/projects/${project.slug}`)).json;
    assert.deepEqual([snap.assets.length, snap.assets[0].id, snap.assets[0].generated.round, snap.assets[0].generated.aspect], [1, made.json.id, 1, "1:1"]);
    assert.notEqual(snap.assets[0].url, url, "a new picture has a new address, so the browser does not show the old one");
  } finally {
    await server.close();
    studio.close();
  }
});
