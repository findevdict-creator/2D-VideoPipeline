import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer } from "../packages/server/src/server.js";
import { intoParts, readDocument } from "../packages/core/src/studio/assets/document.js";
import { documentInfo, figureFromPage, listSources, pagePicture, readSource, READ_WORDS, searchSources } from "../packages/core/src/studio/documents.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import { systemPrompt } from "../packages/core/src/studio/runs/prompts.js";
import { importAsset, listAssets } from "../packages/core/src/studio/store/assets.js";
import { addChapter } from "../packages/core/src/studio/store/chapters.js";
import { createProject, projectPaths } from "../packages/core/src/studio/store/projects.js";
import { createRun } from "../packages/core/src/studio/store/runs.js";
import { listScenes } from "../packages/core/src/studio/store/scenes.js";
import { callTool } from "../packages/core/src/studio/tools/index.js";
import { pngSize } from "./helpers/media.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { REPO, tempStudio } from "./helpers/studio.js";

const REPORT = path.join(REPO, "tests", "fixtures", "report.pdf");
const SCAN = path.join(REPO, "tests", "fixtures", "scan.pdf");
const DESCRIPTION = "Make the case for closing the eastern outfall, from the harbour water report.";

test("a PDF is read page by page, and other documents are cut into parts", async () => {
  const report = await readDocument(REPORT);
  assert.deepEqual([report.info.format, report.info.pages, report.info.hasText], ["pdf", 3, true]);
  assert.match(report.pages[0]!, /^Harbour Water Quality Report 2025\n/);
  assert.match(report.pages[0]!, /fell by 18 percent between 2019 and 2025/);
  assert.match(report.pages[1]!, /Fish counts fell from 12,400 to 7,900/);
  assert.match(report.pages[2]!, /2\.3 million dollars/);
  assert.equal(report.info.words, report.pages.join(" ").split(/\s+/).filter(Boolean).length);

  const scan = await readDocument(SCAN);
  assert.deepEqual([scan.info.pages, scan.info.words, scan.info.hasText], [2, 0, false]);

  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "studio-doc-"));
  const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}. ${"word ".repeat(99)}`).join("\n\n");
  fs.writeFileSync(path.join(dir, "notes.md"), `# Notes\r\n\r\n${long}`);
  const notes = await readDocument(path.join(dir, "notes.md"));
  assert.deepEqual([notes.info.format, notes.info.hasText], ["text", true]);
  assert.ok(notes.info.pages >= 6 && notes.info.pages <= 9, `${notes.info.pages} parts`);
  assert.ok(notes.pages.every((p) => p.split(/\s+/).length <= 520));
  assert.deepEqual(intoParts(""), [""]);

  const word = await readDocument(path.join(REPO, "tests", "fixtures", "notes.docx"));
  assert.deepEqual([word.info.format, word.info.pages], ["word", 1]);
  assert.equal(word.pages[0], "Interview notes\n\nThe harbour master said the outfall was last inspected in 2017.");

  fs.writeFileSync(path.join(dir, "broken.pdf"), "this is not a pdf");
  await assert.rejects(readDocument(path.join(dir, "broken.pdf")), /The PDF could not be read/);
  await assert.rejects(readDocument(path.join(dir, "sheet.xlsx")), /reads \.pdf, \.docx, \.txt and \.md/);
});

test("a document under Assets can be read, searched and looked at, and a chart becomes an image", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: DESCRIPTION });
  const p = projectPaths(studio, project);
  const report = await importAsset(studio, project.id, REPORT, { sourceNote: "Argue for the recommendation on page 3." });
  assert.equal(report.kind, "document");
  assert.deepEqual([documentInfo(report)?.pages, documentInfo(report)?.hasText], [3, true]);
  assert.deepEqual(listSources(studio, project.id).map((s) => [s.label, s.pages, s.whatToDoWithIt]), [["report", 3, "Argue for the recommendation on page 3."]]);

  const broken = path.join(studio.workspaceDir, "broken.pdf");
  fs.writeFileSync(broken, "%PDF-1.4 nothing");
  await assert.rejects(importAsset(studio, project.id, broken), /"broken\.pdf" cannot be used as it is: The PDF could not be read/);
  assert.equal(listAssets(studio, project.id).length, 1, "a document that cannot be read is not stored");

  const all = await readSource(studio, project.id, report.id);
  assert.deepEqual(all.read.map((r) => r.page), [1, 2, 3]);
  assert.equal(all.nextPage, undefined);
  assert.deepEqual((await readSource(studio, project.id, report.id, 2, 2)).read.map((r) => r.page), [2]);
  await assert.rejects(readSource(studio, project.id, report.id, 4), /has 3 pages; there is no page 4/);
  assert.ok(fs.existsSync(path.join(p.work, "documents", report.sha256.slice(0, 16), "text.json")), "the text is kept, so the file is read once");

  // A long document is read in steps.
  const long = path.join(studio.workspaceDir, "long.txt");
  fs.writeFileSync(long, Array.from({ length: 60 }, (_, i) => `Section ${i + 1}. ${"word ".repeat(398)}`).join("\n\n"));
  const book = await importAsset(studio, project.id, long);
  const first = await readSource(studio, project.id, book.id);
  const words = first.read.reduce((n, r) => n + r.text.split(/\s+/).length, 0);
  assert.ok(words <= READ_WORDS && words > READ_WORDS - 900, `${words} words in one read`);
  assert.equal(first.nextPage, first.read.length + 1);
  assert.equal((await readSource(studio, project.id, book.id, first.nextPage)).read[0]!.page, first.nextPage);

  const found = await searchSources(studio, project.id, "fish counts", report.id);
  assert.deepEqual(found.matches.map((m) => m.page), [2]);
  assert.match(found.matches[0]!.snippet, /Fish counts fell from 12,400 to 7,900/);
  assert.deepEqual((await searchSources(studio, project.id, "outfall eastern")).matches.map((m) => m.page), [1, 3], "every word, in any order, in any document");
  assert.equal((await searchSources(studio, project.id, "2.3 million")).matches[0]!.page, 3);
  assert.equal((await searchSources(studio, project.id, "submarine")).total, 0);

  const page = await pagePicture(studio, project.id, report.id, 2);
  assert.deepEqual(pngSize(page.file), { width: page.width, height: page.height });
  assert.equal(Math.max(page.width, page.height), 1600);
  assert.ok(page.height > page.width, "an upright page");
  const made = fs.statSync(page.file).mtimeMs;
  assert.equal(fs.statSync((await pagePicture(studio, project.id, report.id, 2)).file).mtimeMs, made, "a page is drawn once");
  await assert.rejects(pagePicture(studio, project.id, report.id, 9), /no page 9/);
  await assert.rejects(pagePicture(studio, project.id, report.id, 1, { crop: { x: 0.5, y: 0, width: 0.8, height: 0.5 } }), /inside the page/);
  await assert.rejects(pagePicture(studio, project.id, book.id, 1), /text file, which has no pages to look at/);

  // The chart on page 2, cut out and kept as an image that knows where it came from.
  const figure = await figureFromPage(studio, project.id, { assetId: report.id, page: 2, crop: { x: 0.05, y: 0.1, width: 0.7, height: 0.3 }, label: "Figure 1, oxygen by year" });
  assert.deepEqual([figure.kind, figure.label, figure.sourceNote], ["image", "Figure 1, oxygen by year", 'From page 2 of "report"']);
  assert.deepEqual(figure.meta.fromDocument, { assetId: report.id, page: 2, crop: { x: 0.05, y: 0.1, width: 0.7, height: 0.3 } });
  assert.ok(figure.width! > figure.height! && figure.width === 2400, `${figure.width} by ${figure.height}`);
  assert.equal((await figureFromPage(studio, project.id, { assetId: report.id, page: 2, crop: { x: 0.05, y: 0.1, width: 0.7, height: 0.3 } })).id, figure.id, "the same cut twice is one image");
  studio.close();
});

test("runs are told about the documents, read them through tools, and say which pages a scene's facts are on", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: DESCRIPTION });
  const chapter = addChapter(studio, project.id, { title: "The case" });
  const reader = { studio, projectId: project.id, log: () => {} };
  assert.equal((await callTool(reader, "project_get", {})).output.sources, undefined, "no documents, nothing said about them");

  const report = await importAsset(studio, project.id, REPORT);
  const scan = await importAsset(studio, project.id, SCAN);
  const told = (await callTool(reader, "project_get", {})).output.sources as { documents: any[]; howToUse: string };
  assert.deepEqual(told.documents.map((d) => [d.assetId, d.pages, d.hasText]), [[report.id, 3, true], [scan.id, 2, false]]);
  assert.match(told.howToUse, /Every number, name, date and quotation the narration states must be in a source document/);
  for (const kind of ["outline", "bible", "chapter", "scene"] as const) assert.match(systemPrompt(kind), /state no number, name, date or quotation that is not in the sources/);
  assert.match(systemPrompt("chapter"), /give each scene that states facts from them its "sources"/);

  const read = await callTool(reader, "source_read", { assetId: report.id, fromPage: 3 });
  assert.match(JSON.stringify(read.output.read), /Close the eastern outfall/);
  assert.match(String((await callTool(reader, "source_read", { assetId: scan.id })).output.note), /pictures of pages and no text/);
  assert.equal(((await callTool(reader, "source_search", { query: "18 percent" })).output.matches as any[])[0].page, 1);
  const view = await callTool(reader, "source_page_view", { assetId: scan.id, page: 1 });
  assert.equal(view.images.length, 1, "a scan is read by looking at it");
  assert.match(String((await callTool(reader, "asset_view", { assetId: report.id })).output.refused), /is a document\. Read it with source_read/);
  assert.match(String((await callTool(reader, "source_read", { assetId: "as_nope" })).output.refused), /no asset with the id/);
  // Cutting a figure out makes something, so it is for the runs that plan and build scenes.
  assert.match(String((await callTool(reader, "source_figure", { assetId: report.id, page: 2, label: "Figure 1" })).output.refused), /Only reading is allowed/);

  const run = createRun(studio, { projectId: project.id, kind: "chapter", targetId: chapter.id, agent: "scriptwriter" });
  const ctx = { ...reader, run };
  const figure = await callTool(ctx, "source_figure", { assetId: report.id, page: 2, crop: { x: 0.05, y: 0.1, width: 0.7, height: 0.3 }, label: "Figure 1" });
  assert.equal(figure.ok, true, JSON.stringify(figure.output));
  const scene = (sources: unknown) => ({ title: "Oxygen is falling", type: "illustration", narration: "Dissolved oxygen in the harbour fell by eighteen percent in six years.", visualIdea: `Figure 1 (${figure.output.assetId})`, sources });
  const wrong = await callTool(ctx, "scenes_propose", { scenes: [scene([{ assetId: report.id, page: 7 }, { assetId: figure.output.assetId, page: 1 }])] });
  assert.equal(wrong.output.saved, false);
  assert.match(JSON.stringify(wrong.output.problems), /scenes\.0\.sources\.0: \\"report\\" has 3 pages; there is no page 7/);
  assert.match(JSON.stringify(wrong.output.problems), /scenes\.0\.sources\.1: there is no document with the id/);
  const saved = await callTool(ctx, "scenes_propose", { scenes: [scene([{ assetId: report.id, page: 1, note: "fell by 18 percent" }])] });
  assert.equal(saved.output.saved, true, JSON.stringify(saved.output));
  const [made] = listScenes(studio, project.id);
  assert.deepEqual(made!.plan.sources, [{ assetId: report.id, page: 1, note: "fell by 18 percent" }]);
  const sceneRun = createRun(studio, { projectId: project.id, kind: "scene", targetId: made!.id, agent: "scene-builder" });
  assert.match(String((await callTool({ ...reader, run: sceneRun }, "scene_get", {})).output.sourcesNote), /Read those pages with source_read/);
  studio.close();
});

test("the GUI gets a document's size, its first page, and each scene's page references", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const server = await startServer(studio, { port: 0, orchestrator: o });
  try {
    const project = createProject(studio, { description: DESCRIPTION });
    const chapter = addChapter(studio, project.id, { title: "The case" });
    const up = await fetch(`${server.url}/api/projects/${project.slug}/assets`, { method: "POST", headers: { "x-studio": "1", "x-file-name": encodeURIComponent("Harbour report.pdf") }, body: fs.readFileSync(REPORT) });
    assert.equal(up.status, 200, await up.clone().text());
    const { id } = (await up.json()) as { id: string };
    await fetch(`${server.url}/api/assets/${id}`, { method: "PATCH", headers: { "x-studio": "1", "content-type": "application/json" }, body: JSON.stringify({ sourceNote: "Background only." }) });
    const run = createRun(studio, { projectId: project.id, kind: "chapter", targetId: chapter.id, agent: "scriptwriter" });
    await callTool({ studio, projectId: project.id, run, log: () => {} }, "scenes_propose", { scenes: [{ title: "The cost", type: "remotion-2d", narration: "Closing the outfall and adding aeration would cost two point three million dollars.", sources: [{ assetId: id, page: 3 }] }] });

    let snap: any;
    for (let i = 0; i < 100; i++) {
      snap = await (await fetch(`${server.url}/api/projects/${project.slug}`, { headers: { "x-studio": "1" } })).json();
      if (snap.assets[0].previewUrl) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const asset = snap.assets[0];
    assert.deepEqual([asset.kind, asset.label, asset.sourceNote, asset.document.pages, asset.document.hasText], ["document", "Harbour report", "Background only.", 3, true]);
    assert.ok(asset.previewUrl, "the first page is drawn after the upload");
    const picture = await fetch(`${server.url}${asset.previewUrl}`);
    assert.equal(picture.status, 200);
    assert.deepEqual(snap.scenes[0].sources, [{ assetId: id, page: 3, label: "Harbour report", url: `${asset.url}#page=3` }]);
    const bad = await fetch(`${server.url}/api/projects/${project.slug}/assets`, { method: "POST", headers: { "x-studio": "1", "x-file-name": "broken.pdf" }, body: "not a pdf" });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /cannot be used as it is/);
  } finally {
    await server.close();
    studio.close();
  }
});
