import fs from "node:fs";
import path from "node:path";
import { drawPdfPage, readDocument, type Crop, type DocumentInfo } from "./assets/document.js";
import type { Studio } from "./studio.js";
import { findAsset, importAsset, listAssets, updateAsset, type Asset } from "./store/assets.js";
import { getProject, projectPaths } from "./store/projects.js";

export type { Crop, DocumentInfo } from "./assets/document.js";

export const documentInfo = (asset: Pick<Asset, "meta">): DocumentInfo | undefined => asset.meta.document as DocumentInfo | undefined;

/**
 * What a document is to the video. A "source" is what the video is about: its facts come
 * from it. A "model" is something the video should be like, such as another video's
 * transcript: its structure and tone are followed, and nothing is taken from it as fact.
 */
export const DOCUMENT_USES = ["source", "model"] as const;
export type DocumentUse = (typeof DOCUMENT_USES)[number];

export const documentUse = (asset: Pick<Asset, "meta">): DocumentUse => (asset.meta.use === "model" ? "model" : "source");

export function setDocumentUse(studio: Studio, projectId: string, assetId: string, use: string): Asset {
  if (!(DOCUMENT_USES as readonly string[]).includes(use)) throw new Error(`A document is used as one of: ${DOCUMENT_USES.join(", ")}.`);
  return updateAsset(studio, sourceOf(studio, projectId, assetId).asset.id, { meta: { use } });
}

const DEFAULT_NOTE: Record<DocumentUse, string> = {
  source: "(the person left no note: treat it as the material the video is about)",
  model: "(the person left no note: make the video like this one in how it is built)",
};

const USE_GUIDE: Record<DocumentUse, string> = {
  source: "What the video is about. Its facts come from here.",
  model:
    "Something the person wants this video to be like, not what it is about. Study how it opens, how it orders its points, how long it stays on each, and how it sounds, and build this video the same way on this video's own subject. Take no facts from it, and copy none of its sentences.",
};

/** Where a scene's facts came from: a page of one of the project's documents. */
export interface SourceRef {
  assetId: string;
  page: number;
  note?: string;
}

function sourceOf(studio: Studio, projectId: string, assetId: string): { asset: Asset; info: DocumentInfo } {
  const asset = findAsset(studio, projectId, assetId);
  if (!asset) throw new Error(`There is no asset with the id "${assetId}" in this project.`);
  const info = documentInfo(asset);
  if (asset.kind !== "document" || !info) throw new Error(`"${asset.label}" is not a document.`);
  return { asset, info };
}

const cacheDir = (studio: Studio, asset: Asset) => path.join(projectPaths(studio, getProject(studio, asset.projectId)).work, "documents", asset.sha256.slice(0, 16));

/** The text of every page. Read from the file once and kept in the project's work folder. */
export async function documentPages(studio: Studio, projectId: string, assetId: string): Promise<string[]> {
  const { asset } = sourceOf(studio, projectId, assetId);
  const file = path.join(cacheDir(studio, asset), "text.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as string[];
  } catch {
    // Not read yet, or the work folder was cleared.
  }
  const { pages } = await readDocument(projectPaths(studio, getProject(studio, projectId)).abs(asset.path));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(pages));
  return pages;
}

/** The small picture of a PDF's first page, if it has been drawn. For the asset's card. */
export function pageThumbnail(studio: Studio, asset: Asset): string | null {
  const file = path.join(cacheDir(studio, asset), "p1-640.png");
  return fs.existsSync(file) ? file : null;
}

/** Read a document's text and draw its first page, so the first run that needs them does not wait. */
export async function prepareDocument(studio: Studio, asset: Asset): Promise<void> {
  await documentPages(studio, asset.projectId, asset.id);
  if (documentInfo(asset)?.format === "pdf") await pagePicture(studio, asset.projectId, asset.id, 1, { longSide: 640 });
}

/** The project's documents, as a planning run is told about them. */
export function listSources(studio: Studio, projectId: string) {
  return listAssets(studio, projectId, "document").map((a) => {
    const info = documentInfo(a)!;
    const use = documentUse(a);
    const link = a.meta.link as { url?: string; kind?: string } | undefined;
    return { assetId: a.id, label: a.label, format: info.format, pages: info.pages, words: info.words, hasText: info.hasText, use, whatThatMeans: USE_GUIDE[use], ...(link?.url ? { from: link.url } : {}), whatToDoWithIt: a.sourceNote || DEFAULT_NOTE[use] };
  });
}

/** The most text one read hands back, so a long report is read in steps and not all at once. */
export const READ_WORDS = 6000;

/**
 * Pages of a document as text, from one page on. Stops before the read would pass
 * READ_WORDS, and says where to carry on.
 */
export async function readSource(studio: Studio, projectId: string, assetId: string, from = 1, to?: number) {
  const { asset, info } = sourceOf(studio, projectId, assetId);
  const pages = await documentPages(studio, projectId, assetId);
  if (from < 1 || from > pages.length) throw new Error(`"${asset.label}" has ${pages.length} pages; there is no page ${from}.`);
  const last = Math.min(to ?? pages.length, pages.length);
  const out: { page: number; text: string }[] = [];
  let words = 0;
  for (let n = from; n <= last; n++) {
    const text = pages[n - 1]!;
    const count = text.split(/\s+/).filter(Boolean).length;
    if (out.length && words + count > READ_WORDS) break;
    out.push({ page: n, text });
    words += count;
  }
  const reached = out.at(-1)!.page;
  return { label: asset.label, pages: info.pages, hasText: info.hasText, read: out, ...(reached < last ? { nextPage: reached + 1 } : {}) };
}

const fold = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");

/**
 * Find pages by words. A page matches when it holds every word of the query; pages that
 * hold the query as a phrase come first. Each match comes with the text around it.
 */
export async function searchSources(studio: Studio, projectId: string, query: string, assetId?: string, limit = 12) {
  const words = fold(query).split(/[^\p{L}\p{N}.%$'-]+/u).filter((w) => w.length > 1);
  if (!words.length) throw new Error("Search for at least one word.");
  const phrase = fold(query).trim();
  const sources = assetId ? [sourceOf(studio, projectId, assetId).asset] : listAssets(studio, projectId, "document");
  const hits: { assetId: string; label: string; page: number; snippet: string; exact: boolean }[] = [];
  for (const asset of sources) {
    const pages = await documentPages(studio, projectId, asset.id);
    pages.forEach((text, i) => {
      const folded = fold(text);
      if (!words.every((w) => folded.includes(w))) return;
      const exact = folded.includes(phrase);
      const at = exact ? folded.indexOf(phrase) : folded.indexOf(words.reduce((a, b) => (a.length >= b.length ? a : b)));
      const flat = text.replace(/\s+/g, " ");
      const start = Math.max(0, at - 160);
      const snippet = `${start > 0 ? "…" : ""}${flat.slice(start, at + 240).trim()}${at + 240 < flat.length ? "…" : ""}`;
      hits.push({ assetId: asset.id, label: asset.label, page: i + 1, snippet, exact });
    });
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact));
  return { matches: hits.slice(0, limit).map(({ exact: _exact, ...h }) => h), total: hits.length };
}

const cropKey = (c?: Crop) => (c ? `-${[c.x, c.y, c.width, c.height].map((v) => Math.round(v * 1000)).join("_")}` : "");

export function checkCrop(crop: Crop | undefined): Crop | undefined {
  if (!crop) return undefined;
  const ok = [crop.x, crop.y, crop.width, crop.height].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) && crop.width >= 0.05 && crop.height >= 0.05 && crop.x + crop.width <= 1.0001 && crop.y + crop.height <= 1.0001;
  if (!ok) throw new Error("A crop is given as fractions of the page from its top left corner: x, y, width and height between 0 and 1, inside the page, and at least 0.05 wide and high.");
  return crop;
}

/** A picture of one page, or a part of it. Only a PDF has pages to draw. Drawn once and kept. */
export async function pagePicture(studio: Studio, projectId: string, assetId: string, page: number, opts: { crop?: Crop; longSide?: number } = {}): Promise<{ file: string; width: number; height: number }> {
  const { asset, info } = sourceOf(studio, projectId, assetId);
  if (info.format !== "pdf") throw new Error(`"${asset.label}" is a ${info.format === "word" ? "Word" : "text"} file, which has no pages to look at. Read it with source_read.`);
  if (!Number.isInteger(page) || page < 1 || page > info.pages) throw new Error(`"${asset.label}" has ${info.pages} pages; there is no page ${page}.`);
  const crop = checkCrop(opts.crop);
  const longSide = opts.longSide ?? 1600;
  const file = path.join(cacheDir(studio, asset), `p${page}-${longSide}${cropKey(crop)}.png`);
  const size = path.join(cacheDir(studio, asset), `p${page}-${longSide}${cropKey(crop)}.json`);
  if (fs.existsSync(file) && fs.existsSync(size)) return { file, ...(JSON.parse(fs.readFileSync(size, "utf8")) as { width: number; height: number }) };
  const drawn = await drawPdfPage(projectPaths(studio, getProject(studio, projectId)).abs(asset.path), page, file, { crop, longSide });
  fs.writeFileSync(size, JSON.stringify(drawn));
  return { file, ...drawn };
}

/**
 * Make an image asset from a page of a PDF, or from a part of it such as a chart or a
 * table, so a scene can show it. The image remembers the page it came from.
 */
export async function figureFromPage(studio: Studio, projectId: string, input: { assetId: string; page: number; crop?: Crop; label?: string }): Promise<Asset> {
  const { asset } = sourceOf(studio, projectId, input.assetId);
  const picture = await pagePicture(studio, projectId, input.assetId, input.page, { crop: input.crop, longSide: 2400 });
  const label = (input.label?.trim() || `${asset.label}, page ${input.page}`).slice(0, 60);
  const made = await importAsset(studio, projectId, picture.file, { originalName: `${label.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "figure"}.png`, label, kind: "image", sourceNote: `From page ${input.page} of "${asset.label}"` });
  return made.meta.fromDocument ? made : updateAsset(studio, made.id, { meta: { fromDocument: { assetId: asset.id, page: input.page, ...(input.crop ? { crop: input.crop } : {}) } } });
}

/** Problems with the pages a scene says its facts came from, in words a planning run can act on. */
export function checkSourceRefs(studio: Studio, projectId: string, refs: SourceRef[] | undefined, where: string): string[] {
  const problems: string[] = [];
  for (const [i, ref] of (refs ?? []).entries()) {
    const asset = findAsset(studio, projectId, ref.assetId);
    const info = asset && documentInfo(asset);
    if (!asset || asset.kind !== "document" || !info) problems.push(`${where}.sources.${i}: there is no document with the id "${ref.assetId}". project_get lists the documents.`);
    else if (ref.page > info.pages) problems.push(`${where}.sources.${i}: "${asset.label}" has ${info.pages} pages; there is no page ${ref.page}.`);
  }
  return problems;
}
