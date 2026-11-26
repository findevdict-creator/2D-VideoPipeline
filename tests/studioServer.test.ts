import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, type StudioServer } from "../packages/server/src/server.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { Orchestrator } from "../packages/core/src/studio/workflow.js";
import { writeTestCard } from "./helpers/media.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { BROWSER, needsBrowser, tempStudio } from "./helpers/studio.js";

/** What the GUI does, without the GUI: the same requests with the same headers. */
function client(server: StudioServer) {
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const isFile = body instanceof Uint8Array;
    const res = await fetch(server.url + url, {
      method,
      headers: { "x-studio": "1", ...(body !== undefined && !isFile ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : isFile ? Buffer.from(body) : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as any };
  };
  const ok = async (method: string, url: string, body?: unknown, headers?: Record<string, string>) => {
    const res = await call(method, url, body, headers);
    assert.equal(res.status, 200, `${method} ${url}: ${JSON.stringify(res.data)}`);
    return res.data;
  };
  return { call, ok };
}

async function served(studio: Studio, orchestrator: Orchestrator) {
  const server = await startServer(studio, { port: 0, orchestrator });
  return { server, ...client(server) };
}

const DESCRIPTION = "How noise-cancelling headphones erase sound with more sound.";

test("the GUI's whole path works over the API: describe, approve each stage, review scenes, ask for a change", async () => {
  const studio = await tempStudio();
  const runner = new MockStudioRunner();
  const o = new NoRenderOrchestrator(studio, runner);
  const { server, call, ok } = await served(studio, o);
  try {
    // The page and its script are served.
    const page = await fetch(server.url + "/p/anything/scenes");
    assert.match(page.headers.get("content-type")!, /text\/html/);
    assert.match(await page.text(), /<div id="root">/);
    const script = await fetch(server.url + "/app.js");
    assert.match(script.headers.get("content-type")!, /javascript/);
    assert.ok((await script.text()).length > 50_000);
    assert.match((await fetch(server.url + "/app.css")).headers.get("content-type")!, /text\/css/);

    assert.equal((await call("POST", "/api/projects", { description: "too short" })).status, 400);
    const { slug } = await ok("POST", "/api/projects", { description: DESCRIPTION, targetDurationSec: 120, aspect: "16:9" });
    const at = `/api/projects/${slug}`;
    await o.idle();

    let snap = await ok("GET", at);
    assert.equal(snap.stage.stage, "outline");
    assert.deepEqual(snap.stage.waitingOn, []);
    assert.match(snap.documents.outline.markdown, /noise-cancelling/);
    assert.equal(snap.chapters.length, 2);

    // Ask for changes to the outline, then approve stage after stage.
    runner.delayMs = 150;
    await ok("POST", `${at}/stage/start`, { notes: "Open with the airplane hum" });
    assert.equal((await call("POST", `${at}/stage/approve`, {})).status, 400, "not while a run is working");
    await o.idle();
    runner.delayMs = 0;
    assert.match((await ok("GET", at)).documents.outline.markdown, /airplane hum/);
    for (const stage of ["bible", "foundation", "chapters"]) {
      assert.equal((await ok("POST", `${at}/stage/approve`, {})).stage, stage);
      await o.idle();
    }
    snap = await ok("GET", at);
    assert.equal(snap.shared[0].name, "TopicBadge");
    assert.equal(snap.shared[0].status, "approved");
    assert.equal(snap.scenes.length, 4);

    // Edit one scene's narration by hand before anything is built.
    const first = snap.scenes[0];
    await ok("PATCH", `/api/scenes/${first.id}/plan`, { narration: "Ever noticed the hum on a plane? Here is how headphones erase it." });
    assert.equal((await call("PATCH", `/api/scenes/${first.id}/plan`, { narration: "x" })).status, 400);
    assert.equal((await ok("POST", `${at}/stage/approve`, {})).stage, "scenes");
    await o.idle();

    snap = await ok("GET", at);
    assert.ok(snap.scenes.every((s: any) => s.status === "needs_review"));
    assert.match(snap.scenes[0].narration, /hum on a plane/);
    assert.equal((await call("PATCH", `/api/scenes/${first.id}/plan`, { narration: "Too late to edit by hand now." })).status, 400);

    // Review: approve three, ask for a change to one.
    const detail = await ok("GET", `/api/scenes/${first.id}`);
    assert.equal(detail.versions.length, 1);
    assert.match(detail.code, /export default function Scene/);
    assert.equal(detail.spec.cues[0].id, "first");
    assert.equal((await call("POST", `/api/scenes/${first.id}/revise`, { notes: "" })).status, 400);
    await ok("POST", `/api/scenes/${first.id}/revise`, { notes: "Say Anti-noise on the badge" });
    await o.idle();
    const revised = await ok("GET", `/api/scenes/${first.id}`);
    assert.equal(revised.version, 2);
    assert.match(revised.code, /Anti-noise/);
    assert.equal(revised.reviews[0].notes, "Say Anti-noise on the badge");
    const log = await ok("GET", `/api/runs/${revised.runs[0].id}/log`);
    assert.equal(log.status, "done");
    assert.ok(log.lines.some((l: any) => l.text === "scene_submit"));

    // Going back to version 1 is one request.
    await ok("POST", `/api/scenes/${first.id}/rollback`, { version: 1 });
    assert.equal((await ok("GET", `/api/scenes/${first.id}`)).version, 1);
    for (const scene of snap.scenes) await ok("POST", `/api/scenes/${scene.id}/approve`, {});
    assert.equal((await ok("POST", `${at}/stage/approve`, {})).stage, "assembly");
    assert.equal((await ok("GET", "/api/projects")).projects[0].approved, 4);

    assert.equal((await call("GET", "/api/projects/no-such-project")).status, 404);
    assert.equal((await call("GET", "/api/nothing-here")).status, 404);
  } finally {
    await server.close();
    studio.close();
  }
});

test("files are uploaded, served back, marked as references, and removed", async () => {
  const studio = await tempStudio();
  const { server, call, ok } = await served(studio, new NoRenderOrchestrator(studio, new MockStudioRunner()));
  try {
    const { slug } = await ok("POST", "/api/projects", { description: DESCRIPTION, targetDurationSec: 60, aspect: "16:9" });
    const card = path.join(studio.workspaceDir, "card.png");
    writeTestCard(card, 400, 250);
    const bytes = new Uint8Array(fs.readFileSync(card));
    const uploaded = await ok("POST", `/api/projects/${slug}/assets`, bytes, { "x-file-name": encodeURIComponent("Cutaway of a headphone.png"), "content-type": "application/octet-stream" });
    assert.equal(uploaded.kind, "image");

    await ok("PATCH", `/api/assets/${uploaded.id}`, { reference: { role: "style", note: "the flat colours" } });
    assert.equal((await call("PATCH", `/api/assets/${uploaded.id}`, { reference: { role: "copy-this" } })).status, 400);
    let asset = (await ok("GET", `/api/projects/${slug}`)).assets[0];
    assert.equal(asset.label, "Cutaway of a headphone");
    assert.equal(asset.width, 400);
    assert.deepEqual(asset.reference, { assetId: uploaded.id, role: "style", note: "the flat colours" });

    // The file comes back from the address the page uses, with ranges for video players.
    const file = await fetch(server.url + asset.url);
    assert.equal(file.headers.get("content-type"), "image/png");
    assert.equal((await file.arrayBuffer()).byteLength, bytes.length);
    assert.equal(file.headers.get("access-control-allow-origin"), null, "other sites cannot read project files");
    assert.equal((await fetch(server.url + asset.url, { headers: { range: "bytes=0-9" } })).status, 206);
    assert.notEqual((await fetch(`${server.url}/files/${slug}/..%2F..%2Fstudio.db`)).status, 200);

    await ok("PATCH", `/api/assets/${uploaded.id}`, { reference: { role: null } });
    asset = (await ok("GET", `/api/projects/${slug}`)).assets[0];
    assert.equal(asset.reference, null);
    await ok("DELETE", `/api/assets/${uploaded.id}`);
    assert.equal((await ok("GET", `/api/projects/${slug}`)).assets.length, 0);
  } finally {
    await server.close();
    studio.close();
  }
});

test("the server answers only its own page: no other site, no other host name", async () => {
  const studio = await tempStudio();
  const { server } = await served(studio, new NoRenderOrchestrator(studio, new MockStudioRunner()));
  try {
    const post = (headers: Record<string, string>) =>
      fetch(`${server.url}/api/projects`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ description: DESCRIPTION }) });
    assert.equal((await post({})).status, 403, "a form on another site cannot send the studio's own header");
    assert.equal((await post({ "x-studio": "1", origin: "https://example.com" })).status, 403);
    assert.equal((await post({ "x-studio": "1", origin: server.url })).status, 200);
    // A page that reaches the server under another name, as in DNS rebinding, is refused.
    const viaOtherName = await new Promise<number>((resolve, reject) => {
      import("node:http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port: server.port, path: "/api/projects", headers: { host: "studio.example.com" } }, (res) => resolve(res.statusCode ?? 0));
        req.on("error", reject);
        req.end();
      });
    });
    assert.equal(viaOtherName, 403);
  } finally {
    await server.close();
    studio.close();
  }
});

test("changes made by runs reach the page as live events", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const { server, ok } = await served(studio, o);
  try {
    const abort = new AbortController();
    const stream = await fetch(`${server.url}/api/events`, { signal: abort.signal });
    assert.match(stream.headers.get("content-type")!, /text\/event-stream/);
    const reader = stream.body!.getReader();
    let text = "";
    const read = (async () => {
      while (!/"kind":"document.changed"/.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    })();
    await ok("POST", "/api/projects", { description: DESCRIPTION, targetDurationSec: 60, aspect: "16:9" });
    await o.idle();
    await Promise.race([read, new Promise((_, reject) => setTimeout(() => reject(new Error("no event arrived")), 5000))]);
    abort.abort();
    assert.match(text, /"kind":"run.changed"/);
    assert.match(text, /"kind":"document.changed"/);
  } finally {
    await server.close();
    studio.close();
  }
});

test("through the server with real rendering: every scene gets a clip to watch, and the video is assembled", needsBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER } });
  const runner = new MockStudioRunner();
  const o = new Orchestrator(studio, runner);
  const { server, ok } = await served(studio, o);
  try {
    const { slug } = await ok("POST", "/api/projects", { description: DESCRIPTION, targetDurationSec: 20, aspect: "9:16" });
    const at = `/api/projects/${slug}`;
    await o.idle();
    for (let i = 0; i < 4; i++) {
      await ok("POST", `${at}/stage/approve`, {});
      await o.idle();
    }
    let snap = await ok("GET", at);
    assert.equal(snap.stage.stage, "scenes");
    assert.match(snap.shared[0].versions[0].previewUrl, /^\/files\//);
    for (const scene of snap.scenes) {
      assert.equal(scene.status, "needs_review", scene.reason ?? "");
      const video = await fetch(server.url + scene.current.reviewUrl, { headers: { range: "bytes=0-99" } });
      assert.equal(video.status, 206);
      assert.equal(video.headers.get("content-type"), "video/mp4");
      assert.ok(scene.current.stills.length > 0);
      await ok("POST", `/api/scenes/${scene.id}/approve`, {});
    }
    await ok("POST", `${at}/stage/approve`, {});
    await ok("POST", `${at}/assemble`, { quality: "final" });
    await o.idle();
    snap = await ok("GET", at);
    assert.equal(snap.renders.length, 1);
    assert.equal(snap.renders[0].kind, "final");
    assert.equal(snap.jobs.find((j: any) => j.kind === "assemble").status, "done");
    const head = await fetch(server.url + snap.renders[0].url, { method: "HEAD" });
    assert.ok(Number(head.headers.get("content-length")) > 10_000);
    assert.match(await (await fetch(server.url + snap.renders[0].srtUrl)).text(), /-->/);
  } finally {
    await server.close();
    studio.close();
  }
});
