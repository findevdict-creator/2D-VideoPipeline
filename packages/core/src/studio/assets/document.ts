import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** What a document is, as kept with its asset under `meta.document`. */
export interface DocumentInfo {
  format: "pdf" | "text" | "word";
  /** Pages of a PDF. Other documents are cut into parts of about a page each, which count as pages. */
  pages: number;
  words: number;
  /** False for a PDF that is only pictures of pages, such as a scan: it can be looked at but not read or searched. */
  hasText: boolean;
  title?: string;
}

const require = createRequire(import.meta.url);

export function documentFormat(file: string): DocumentInfo["format"] | undefined {
  const ext = path.extname(file).toLowerCase();
  return ext === ".pdf" ? "pdf" : ext === ".docx" ? "word" : ext === ".txt" || ext === ".md" ? "text" : undefined;
}

type Pdf = { numPages: number; getPage: (n: number) => Promise<any>; getMetadata: () => Promise<any>; destroy: () => Promise<void>; canvasFactory: { create: (w: number, h: number) => { canvas: any; context: any } } };

async function openPdf(file: string): Promise<Pdf> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
  try {
    return (await pdfjs.getDocument({
      data: new Uint8Array(fs.readFileSync(file)),
      standardFontDataUrl: path.join(root, "standard_fonts") + path.sep,
      cMapUrl: path.join(root, "cmaps") + path.sep,
      cMapPacked: true,
      verbosity: 0,
    }).promise) as unknown as Pdf;
  } catch (err) {
    const e = err as Error;
    throw new Error(e.name === "PasswordException" ? "The PDF is protected by a password. Save a copy without one and add that." : `The PDF could not be read: ${e.message}`);
  }
}

const tidy = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Cut running text into parts of about a page, at paragraph ends. */
export function intoParts(text: string, wordsPerPart = 450): string[] {
  const parts: string[] = [];
  let part: string[] = [];
  let size = 0;
  for (const para of tidy(text).split(/\n{2,}|\n(?=#)/)) {
    const n = countWords(para);
    if (size && size + n > wordsPerPart) {
      parts.push(part.join("\n\n"));
      part = [];
      size = 0;
    }
    part.push(para);
    size += n;
  }
  if (part.length) parts.push(part.join("\n\n"));
  return parts.length ? parts : [""];
}

/** A document's text, page by page, and what kind of document it is. Throws with the reason when it cannot be read. */
export async function readDocument(file: string, format = documentFormat(file)): Promise<{ info: DocumentInfo; pages: string[] }> {
  if (!format) throw new Error(`"${path.basename(file)}" is not a document the studio reads. It reads .pdf, .docx, .txt and .md.`);
  let pages: string[];
  let title: string | undefined;
  if (format === "pdf") {
    const pdf = await openPdf(file);
    try {
      pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const content = await (await pdf.getPage(n)).getTextContent();
        let text = "";
        for (const item of content.items as { str?: string; hasEOL?: boolean }[]) text += (item.str ?? "") + (item.hasEOL ? "\n" : "");
        pages.push(tidy(text));
      }
      title = String((await pdf.getMetadata().catch(() => undefined))?.info?.Title ?? "").trim() || undefined;
    } finally {
      await pdf.destroy().catch(() => {});
    }
  } else if (format === "word") {
    const mammoth = (await import("mammoth")).default;
    try {
      pages = intoParts((await mammoth.extractRawText({ path: file })).value);
    } catch (err) {
      throw new Error(`The Word file could not be read: ${(err as Error).message}`);
    }
  } else {
    pages = intoParts(fs.readFileSync(file, "utf8"));
  }
  const words = pages.reduce((n, p) => n + countWords(p), 0);
  // A scan has a stray word here and there at most.
  const hasText = format !== "pdf" || words >= Math.max(20, pages.length * 5);
  return { info: { format, pages: pages.length, words, hasText, ...(title ? { title } : {}) }, pages };
}

/** A part of a page, as fractions of its width and height from the top left corner. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Draw one page of a PDF, or a part of it, as a PNG whose long side is about `longSide`
 * pixels. Returns the size of the picture written.
 */
export async function drawPdfPage(file: string, pageNumber: number, out: string, opts: { longSide?: number; crop?: Crop } = {}): Promise<{ width: number; height: number }> {
  const pdf = await openPdf(file);
  try {
    if (pageNumber < 1 || pageNumber > pdf.numPages) throw new Error(`The document has ${pdf.numPages} pages; there is no page ${pageNumber}.`);
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const crop = opts.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const scale = Math.min(8, (opts.longSide ?? 1600) / Math.max(base.width * crop.width, base.height * crop.height));
    const viewport = page.getViewport({ scale });
    const whole = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    // Paper is white; a PDF does not paint it.
    whole.context.fillStyle = "#ffffff";
    whole.context.fillRect(0, 0, whole.canvas.width, whole.canvas.height);
    await page.render({ canvasContext: whole.context, viewport }).promise;
    let canvas = whole.canvas;
    if (opts.crop) {
      const w = Math.max(1, Math.round(whole.canvas.width * crop.width));
      const h = Math.max(1, Math.round(whole.canvas.height * crop.height));
      const cut = pdf.canvasFactory.create(w, h);
      cut.context.drawImage(whole.canvas, Math.round(whole.canvas.width * crop.x), Math.round(whole.canvas.height * crop.y), w, h, 0, 0, w, h);
      canvas = cut.canvas;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, canvas.toBuffer("image/png"));
    return { width: canvas.width, height: canvas.height };
  } finally {
    await pdf.destroy().catch(() => {});
  }
}
