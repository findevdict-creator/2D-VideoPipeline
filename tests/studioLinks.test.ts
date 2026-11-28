import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { startServer } from "../packages/server/src/server.js";
import { documentUse, listSources, readSource, setDocumentUse } from "../packages/core/src/studio/documents.js";
import { addLink, articleFromHtml, checkUrl, linkInfo, youtubeId, youtubeInfo } from "../packages/core/src/studio/links.js";
import { grayPng } from "../packages/core/src/studio/renderers/gpu.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import { systemPrompt } from "../packages/core/src/studio/runs/prompts.js";
import { listAssets, listProjectReferences } from "../packages/core/src/studio/store/assets.js";
import { createProject } from "../packages/core/src/studio/store/projects.js";
import { callTool } from "../packages/core/src/studio/tools/index.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { REPO, tempStudio } from "./helpers/studio.js";

const PARAGRAPH = "Tide pools are small worlds that refill twice a day, and every animal in them has a way to wait out the dry hours between one tide and the next. ";
const ARTICLE = `<!doctype html><html><head><title>Tide pools | Shoreline Weekly</title><meta property="og:site_name" content="Shoreline Weekly"><meta name="author" content="Ines Okafor"></head><body>
<nav><a href="/">Home</a><a href="/subscribe">Subscribe now for more</a></nav>
<article><h1>How tide pools survive the dry hours</h1>
<p>${PARAGRAPH.repeat(3)}</p><h2>Limpets clamp down</h2><p>A limpet returns to the same scar on the rock at every low tide. ${PARAGRAPH.repeat(2)}</p>
<ul><li>Anemones fold inward to hold water.</li><li>Crabs hide under weed.</li></ul>
<blockquote><p>The pool is never the same pool twice.</p></blockquote><p>${PARAGRAPH.repeat(2)}</p></article>
<footer>Copyright Shoreline Weekly. Cookie settings.</footer><script>track()</script></body></html>`;

/** A web for the tests: one article site and a stand-in for YouTube. */
async function fakeWeb() {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen.push(url.pathname);
    const send = (status: number, type: string, body: string | Buffer) => res.writeHead(status, { "content-type": type }).end(body);
    if (url.pathname === "/tide-pools") return send(200, "text/html; charset=utf-8", ARTICLE);
    if (url.pathname === "/members-only") return send(403, "text/html", "<html><body>Sign in to read</body></html>");
    if (url.pathname === "/app-shell") return send(200, "text/html", `<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
    if (url.pathname === "/paper.pdf") return send(200, "application/pdf", fs.readFileSync(path.join(REPO, "tests", "fixtures", "report.pdf")));
    if (url.pathname === "/gone") return send(404, "text/html", "not here");
    if (url.pathname === "/oembed") {
      const id = new URL(url.searchParams.get("url")!).searchParams.get("v");
      if (id === "private0001") return send(404, "text/plain", "Not Found");
      return send(200, "application/json", JSON.stringify({ title: `Why the sky is blue (${id})`, author_name: "Clear Skies", thumbnail_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/thumb.png` }));
    }
    if (url.pathname === "/watch") {
      const tracks = url.searchParams.get("v") === "nocaptions1" ? "" : `"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=x\\u0026lang=de","languageCode":"de"},{"baseUrl":"https://www.youtube.com/api/timedtext?v=x\\u0026lang=en","languageCode":"en","kind":"asr"}],"audioTracks":[]}}`;
      return send(200, "text/html", `<html><head><meta name="title" content="From the page"></head><body><script>var ytInitialPlayerResponse = {${tracks}};</script></body></html>`);
    }
    if (url.pathname === "/api/timedtext") {
      if (url.searchParams.get("lang") !== "en" || url.searchParams.get("fmt") !== "json3") return send(400, "text/plain", "wrong track");
      const events = [
        { tStartMs: 0, segs: [{ utf8: "Why is the sky " }, { utf8: "blue?" }] },
        { tStartMs: 4000, segs: [{ utf8: "Sunlight looks white," }] },
        { tStartMs: 9000, segs: [{ utf8: "\n" }] },
        { tStartMs: 41000, segs: [{ utf8: "but air scatters blue light the most." }] },
      ];
      return send(200, "application/json", JSON.stringify({ events }));
    }
    if (url.pathname === "/thumb.png") return send(200, "image/png", grayPng(64, 36, [20, 90, 200]));
    return send(404, "text/plain", "nothing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("addresses are understood, and an article is told apart from the page around it", () => {
  assert.equal(checkUrl("example.com/a b").toString(), "https://example.com/a%20b");
  assert.throws(() => checkUrl("ftp://example.com/x"), /starts with http/);
  assert.throws(() => checkUrl("http://"), /is not a web address/);
  for (const address of ["https://www.youtube.com/watch?v=aircAruvnKk&t=30s", "https://youtu.be/aircAruvnKk?si=abc", "youtube.com/shorts/aircAruvnKk", "https://m.youtube.com/embed/aircAruvnKk", "https://www.youtube.com/live/aircAruvnKk"]) {
    assert.equal(youtubeId(address), "aircAruvnKk", address);
  }
  for (const address of ["https://www.youtube.com/@channel", "https://vimeo.com/123456789", "https://notyoutube.com/watch?v=aircAruvnKk"]) assert.equal(youtubeId(address), undefined, address);

  const article = articleFromHtml(ARTICLE, "https://shoreline.example/tide-pools");
  assert.deepEqual([article.from, article.byline], ["Shoreline Weekly", "Ines Okafor"]);
  assert.match(article.title, /tide pools/i);
  assert.match(article.text, /## Limpets clamp down\n\nA limpet returns to the same scar/);
  assert.match(article.text, /- Anemones fold inward to hold water\.\n\n- Crabs hide under weed\./);
  assert.equal(article.text.match(/The pool is never the same pool twice\./g)?.length, 1, "a quote is told once, not once for itself and once for its paragraph");
  for (const chrome of ["Subscribe now", "Cookie settings", "track()"]) assert.ok(!article.text.includes(chrome), chrome);
  assert.ok(article.words > 200);
});

test("an article's link becomes a document the video is about, and pages that cannot be read say what to do instead", async () => {
  const web = await fakeWeb();
  const studio = await tempStudio();
  try {
    const project = createProject(studio, { description: "How the animals of a tide pool get through low tide." });
    const { asset, warnings } = await addLink(studio, project.id, { url: `${web.base}/tide-pools`, note: "Explain the three ways of waiting." });
    assert.deepEqual(warnings, []);
    assert.deepEqual([asset.kind, asset.label, asset.sourceNote, documentUse(asset)], ["document", "How tide pools survive the dry hours", "Explain the three ways of waiting.", "source"]);
    assert.deepEqual([linkInfo(asset)?.kind, linkInfo(asset)?.url, linkInfo(asset)?.from], ["article", `${web.base}/tide-pools`, "Shoreline Weekly"]);
    const text = (await readSource(studio, project.id, asset.id)).read.map((r) => r.text).join("\n\n");
    assert.match(text, /^# How tide pools survive the dry hours\n\nBy Ines Okafor\. From Shoreline Weekly: http/);
    assert.match(text, /A limpet returns to the same scar/);
    const [source] = listSources(studio, project.id);
    assert.deepEqual([source!.use, source!.from, source!.whatToDoWithIt], ["source", `${web.base}/tide-pools`, "Explain the three ways of waiting."]);

    await assert.rejects(addLink(studio, project.id, { url: `${web.base}/tide-pools` }), /already under Assets, as "How tide pools survive/);
    await assert.rejects(addLink(studio, project.id, { url: `${web.base}/members-only` }), /refused to hand the page to the studio \(403\).*print it to PDF, and add the PDF here/s);
    await assert.rejects(addLink(studio, project.id, { url: `${web.base}/app-shell` }), /gave almost no text.*print it to PDF/s);
    await assert.rejects(addLink(studio, project.id, { url: `${web.base}/gone` }), /answered 404 for that address/);
    await assert.rejects(addLink(studio, project.id, { url: "http://127.0.0.1:1/x" }), /could not be reached/);
    assert.equal(listAssets(studio, project.id).length, 1, "a link that failed leaves nothing behind");

    // A link straight to a PDF is kept as the PDF it is.
    const pdf = await addLink(studio, project.id, { url: `${web.base}/paper.pdf` });
    assert.deepEqual([pdf.asset.mime, pdf.asset.label, linkInfo(pdf.asset)?.kind, (pdf.asset.meta.document as any).pages], ["application/pdf", "paper", "pdf", 3]);
  } finally {
    studio.close();
    await web.close();
  }
});

test("a YouTube link gives the title, the thumbnail and the transcript, as something to be like", async () => {
  const web = await fakeWeb();
  const studio = await tempStudio();
  try {
    const info = await youtubeInfo("aircAruvnKk", web.base);
    assert.deepEqual([info.title, info.channel], ["Why the sky is blue (aircAruvnKk)", "Clear Skies"]);
    assert.deepEqual(info.transcript, [
      { atSec: 0, text: "Why is the sky blue? Sunlight looks white," },
      { atSec: 41, text: "but air scatters blue light the most." },
    ]);

    const project = createProject(studio, { description: "Why the sea looks blue, for curious ten-year-olds." });
    const added = await addLink(studio, project.id, { url: "https://youtu.be/aircAruvnKk", youtubeBase: web.base });
    assert.deepEqual(added.warnings, []);
    assert.deepEqual([documentUse(added.asset), linkInfo(added.asset)?.kind, linkInfo(added.asset)?.from, linkInfo(added.asset)?.transcript], ["model", "youtube", "Clear Skies", true]);
    const text = (await readSource(studio, project.id, added.asset.id)).read[0]!.text;
    assert.match(text, /A video by Clear Skies on YouTube: https:\/\/youtu\.be\/aircAruvnKk/);
    assert.match(text, /## Transcript\n\n\[0:00\] Why is the sky blue\? Sunlight looks white,\n\n\[0:41\] but air scatters/);
    assert.ok(!web.seen.some((p) => /videoplayback|\.mp4/.test(p)), "the video itself is never asked for");

    // Its thumbnail is the one picture there is of how it looks.
    assert.equal(added.thumbnail?.kind, "image");
    assert.deepEqual(listProjectReferences(studio, project.id).map((r) => [r.assetId, r.role]), [[added.thumbnail!.id, "style"]]);

    // Claude is told it is a model, not the subject.
    const told = (await callTool({ studio, projectId: project.id, log: () => {} }, "project_get", {})).output.sources as { documents: any[]; howToUse: string };
    assert.equal(told.documents[0].use, "model");
    assert.match(told.documents[0].whatThatMeans, /Take no facts from it, and copy none of its sentences/);
    assert.match(told.documents[0].whatToDoWithIt, /make the video like this one/);
    assert.match(told.howToUse, /whose structure, pacing and tone you follow without taking facts or sentences from it/);
    assert.match(systemPrompt("chapter"), /A document marked "model" is a piece to be like/);

    // The person can change their mind about what a document is for.
    assert.equal(documentUse(setDocumentUse(studio, project.id, added.asset.id, "source")), "source");
    assert.throws(() => setDocumentUse(studio, project.id, added.asset.id, "decoration"), /used as one of: source, model/);
    assert.throws(() => setDocumentUse(studio, project.id, added.thumbnail!.id, "model"), /is not a document/);

    // No captions: the link is still added, and the person is told how to supply the words.
    const silent = await addLink(studio, project.id, { url: "https://www.youtube.com/watch?v=nocaptions1", youtubeBase: web.base });
    assert.equal(linkInfo(silent.asset)?.transcript, false);
    assert.match(silent.warnings[0]!, /YouTube did not give the transcript.*Show transcript.*\.txt file/s);
    await assert.rejects(addLink(studio, project.id, { url: "https://www.youtube.com/watch?v=private0001", youtubeBase: web.base }), /no video at that address/);
  } finally {
    studio.close();
    await web.close();
  }
});

test("links are added and changed through the GUI's routes", async () => {
  const web = await fakeWeb();
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const server = await startServer(studio, { port: 0, orchestrator: o });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${server.url}${url}`, { method, headers: { "x-studio": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as any };
  };
  try {
    const project = createProject(studio, { description: "How the animals of a tide pool get through low tide." });
    const added = await call("POST", `/api/projects/${project.slug}/links`, { url: `${web.base}/tide-pools`, use: "model", note: "The same calm pace." });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    const refused = await call("POST", `/api/projects/${project.slug}/links`, { url: `${web.base}/members-only` });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /print it to PDF/);
    let snap = (await call("GET", `/api/projects/${project.slug}`)).json;
    assert.deepEqual([snap.assets.length, snap.assets[0].use, snap.assets[0].link.kind, snap.assets[0].link.url, snap.assets[0].sourceNote], [1, "model", "article", `${web.base}/tide-pools`, "The same calm pace."]);
    assert.equal((await call("PATCH", `/api/assets/${added.json.id}`, { use: "source" })).status, 200);
    assert.equal((await call("PATCH", `/api/assets/${added.json.id}`, { use: "wallpaper" })).status, 400);
    snap = (await call("GET", `/api/projects/${project.slug}`)).json;
    assert.equal(snap.assets[0].use, "source");
  } finally {
    await server.close();
    studio.close();
    await web.close();
  }
});
