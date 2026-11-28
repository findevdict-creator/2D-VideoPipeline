import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { documentInfo, prepareDocument, type DocumentUse } from "./documents.js";
import type { Studio } from "./studio.js";
import { importAsset, listAssets, setProjectReference, updateAsset, type Asset } from "./store/assets.js";

/** Where a document came from, when it was added as a link. Kept under `meta.link` of its asset. */
export interface LinkInfo {
  url: string;
  kind: "article" | "youtube" | "pdf";
  title: string;
  /** The site, or for a video the channel. */
  from?: string;
  fetchedAt: string;
  /** For a video: whether its transcript could be fetched. */
  transcript?: boolean;
}

export const linkInfo = (asset: Pick<Asset, "meta">): LinkInfo | undefined => asset.meta.link as LinkInfo | undefined;

const MAX_BYTES = 12 * 1024 * 1024;
// Sites answer a plain browser; many refuse a client that names no browser at all.
const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export function checkUrl(given: string): URL {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(given.trim()) ? given.trim() : `https://${given.trim()}`);
  } catch {
    throw new Error(`"${given}" is not a web address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A link starts with http:// or https://.");
  return url;
}

/** The id of a YouTube video, from any of the forms its address takes. */
export function youtubeId(given: string | URL): string | undefined {
  const url = typeof given === "string" ? checkUrl(given) : given;
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  const id = host === "youtu.be" ? url.pathname.slice(1).split("/")[0] : host === "youtube.com" || host === "youtube-nocookie.com" ? (url.searchParams.get("v") ?? /^\/(?:shorts|embed|live|v)\/([^/?]+)/.exec(url.pathname)?.[1]) : undefined;
  return id && /^[\w-]{6,20}$/.test(id) ? id : undefined;
}

async function get(url: string, timeoutSec = 30): Promise<{ status: number; type: string; body: Buffer; url: string }> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": AGENT, accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8", "accept-language": "en" }, redirect: "follow", signal: AbortSignal.timeout(timeoutSec * 1000) });
  } catch (err) {
    const e = err as Error;
    throw new Error(e.name === "TimeoutError" ? `${new URL(url).hostname} did not answer within ${timeoutSec} seconds.` : `${new URL(url).hostname} could not be reached: ${(e.cause as Error | undefined)?.message ?? e.message}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error("The page is larger than 12 MB. Save what you need from it as a PDF and add that.");
  return { status: res.status, type: (res.headers.get("content-type") ?? "").toLowerCase(), body, url: res.url || url };
}

function decode(body: Buffer, type: string): string {
  const charset = /charset=["']?([\w-]+)/.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString("latin1"))?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return body.toString("utf8");
  }
}

export interface Article {
  title: string;
  from?: string;
  byline?: string;
  /** The article as plain text with "## " headings and "- " list items, paragraphs a blank line apart. */
  text: string;
  words: number;
}

const BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,td,th";

/** The article on a page, without its menus, adverts and comments. */
export function articleFromHtml(html: string, url: string): Article {
  const { document } = parseHTML(html);
  const meta = (name: string) => document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.getAttribute("content")?.trim() || undefined;
  const pageTitle = meta("og:title") ?? document.querySelector("title")?.textContent?.trim() ?? new URL(url).hostname;
  const site = meta("og:site_name") ?? new URL(url).hostname.replace(/^www\./, "");
  // A page with one main heading is named by it: the <title> often carries the site's name or a shortened form.
  const headings = [...document.querySelectorAll("h1")].map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const heading = headings.length === 1 && headings[0]!.split(" ").length >= 3 ? headings[0] : undefined;
  let read: ReturnType<Readability["parse"]> = null;
  try {
    read = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
  } catch {
    // A page Readability cannot make sense of is read whole, below.
  }
  const lines: string[] = [];
  const root = read?.content ? parseHTML(`<!doctype html><html><body>${read.content}</body></html>`).document.body : document.body;
  for (const el of root?.querySelectorAll(BLOCKS) ?? []) {
    // A block that holds other blocks is told by those: a quote by its paragraphs, a list item by its own.
    if (el.querySelector(BLOCKS)) continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const tag = el.tagName.toLowerCase();
    lines.push(/^h[1-6]$/.test(tag) ? `## ${text}` : tag === "li" ? `- ${text}` : text);
  }
  let text = lines.join("\n\n").trim();
  if (!text && read?.textContent) text = read.textContent.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  const withoutSite = (t: string) => (site && t.toLowerCase().endsWith(site.toLowerCase()) ? t.slice(0, -site.length).replace(/\s*[|\-–—:·]\s*$/, "").trim() || t : t);
  return { title: (heading ?? withoutSite(read?.title?.trim() || pageTitle)).slice(0, 200), from: read?.siteName?.trim() || site, byline: read?.byline?.trim() || meta("author"), text, words: text.split(/\s+/).filter(Boolean).length };
}

export interface VideoInfo {
  id: string;
  title: string;
  channel?: string;
  thumbnailUrl?: string;
  /** What is said, in passages of about half a minute. Missing when YouTube did not give it. */
  transcript?: { atSec: number; text: string }[];
  /** Why there is no transcript, in a sentence. */
  transcriptProblem?: string;
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/**
 * What YouTube tells anyone about a video: its title, channel and thumbnail, and its
 * captions when it publishes them. The video itself is not downloaded.
 */
export async function youtubeInfo(id: string, base = "https://www.youtube.com"): Promise<VideoInfo> {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  const info: VideoInfo = { id, title: `YouTube video ${id}` };
  const embed = await get(`${base}/oembed?url=${encodeURIComponent(watch)}&format=json`).catch(() => undefined);
  if (embed?.status === 404 || embed?.status === 400) throw new Error("YouTube has no video at that address. It may be private or removed.");
  if (embed?.status === 401 || embed?.status === 403) throw new Error("That video does not allow itself to be looked up from outside YouTube.");
  if (embed?.status === 200) {
    try {
      const data = JSON.parse(embed.body.toString("utf8")) as { title?: string; author_name?: string; thumbnail_url?: string };
      if (data.title) info.title = data.title;
      info.channel = data.author_name;
      info.thumbnailUrl = data.thumbnail_url;
    } catch {
      // Not the answer expected; the page below may still say.
    }
  }
  try {
    const page = await get(`${base}/watch?v=${id}&hl=en`);
    const html = page.body.toString("utf8");
    if (!embed || embed.status !== 200) {
      const title = /<meta\s+name="title"\s+content="([^"]+)"/.exec(html)?.[1];
      if (title) info.title = title.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }
    const found = /"captionTracks":(\[.*?\])/.exec(html)?.[1];
    if (!found) throw new Error("the video has no captions, or YouTube did not list them");
    const tracks = JSON.parse(found) as { baseUrl: string; languageCode?: string; kind?: string }[];
    const track = tracks.find((t) => t.languageCode?.startsWith("en") && t.kind !== "asr") ?? tracks.find((t) => t.languageCode?.startsWith("en")) ?? tracks[0];
    if (!track?.baseUrl) throw new Error("the video has no captions");
    const address = new URL(track.baseUrl.replace(/\\u0026/g, "&"), base);
    address.searchParams.set("fmt", "json3");
    // A test stands in for YouTube at another address; the captions come from there too.
    const captions = await get(base === "https://www.youtube.com" ? address.toString() : `${base}${address.pathname}${address.search}`);
    const events = (JSON.parse(captions.body.toString("utf8") || "{}") as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] }).events ?? [];
    const passages: { atSec: number; text: string }[] = [];
    for (const e of events) {
      const text = (e.segs ?? []).map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const atSec = (e.tStartMs ?? 0) / 1000;
      const last = passages.at(-1);
      if (last && atSec - last.atSec < 30) last.text += ` ${text}`;
      else passages.push({ atSec, text });
    }
    if (!passages.length) throw new Error("YouTube listed captions but did not hand them over");
    info.transcript = passages;
  } catch (err) {
    info.transcriptProblem = (err as Error).message.split("\n")[0]!;
  }
  return info;
}

export interface AddLinkOptions {
  url: string;
  /** "source": the video is about it. "model": the video should be like it. Left out: a YouTube video is a model, anything else a source. */
  use?: DocumentUse;
  /** What Claude should do with it, in the person's words. */
  note?: string;
  /** For tests: where YouTube is. */
  youtubeBase?: string;
}

const fileName = (title: string, ext: string) => `${title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "link"}${ext}`;

/**
 * Add a web page or a YouTube video to a project by its address. An article's text is
 * kept as a document, as is a video's transcript; a video's thumbnail is kept as an image
 * and marked as a style reference. Returns what was added and anything the person should know.
 */
export async function addLink(studio: Studio, projectId: string, opts: AddLinkOptions): Promise<{ asset: Asset; thumbnail?: Asset; warnings: string[] }> {
  const url = checkUrl(opts.url);
  const already = listAssets(studio, projectId, "document").find((a) => linkInfo(a)?.url === url.toString());
  if (already) throw new Error(`That link is already under Assets, as "${already.label}". Remove it first to fetch it again.`);
  const warnings: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-link-"));
  try {
    const video = youtubeId(url);
    let file: string;
    let link: LinkInfo;
    let thumbnail: Asset | undefined;
    const use: DocumentUse = opts.use ?? (video ? "model" : "source");
    if (video) {
      const info = await youtubeInfo(video, opts.youtubeBase);
      link = { url: url.toString(), kind: "youtube", title: info.title, from: info.channel, fetchedAt: new Date().toISOString(), transcript: Boolean(info.transcript) };
      const body = info.transcript
        ? `## Transcript\n\n${info.transcript.map((p) => `[${clock(p.atSec)}] ${p.text}`).join("\n\n")}`
        : "The transcript of this video could not be fetched, so only its title is known here.";
      file = path.join(dir, fileName(info.title, ".md"));
      fs.writeFileSync(file, `# ${info.title}\n\nA video${info.channel ? ` by ${info.channel}` : ""} on YouTube: ${url}\n\n${body}\n`);
      if (!info.transcript) warnings.push(`YouTube did not give the transcript (${info.transcriptProblem}). To give Claude what is said in it, open the video on YouTube, choose "Show transcript", copy the text into a .txt file and add that file here.`);
      if (info.thumbnailUrl) {
        try {
          const picture = await get(info.thumbnailUrl);
          if (picture.status === 200 && picture.type.startsWith("image/")) {
            const image = path.join(dir, fileName(`${info.title} thumbnail`, picture.type.includes("png") ? ".png" : picture.type.includes("webp") ? ".webp" : ".jpg"));
            fs.writeFileSync(image, picture.body);
            thumbnail = await importAsset(studio, projectId, image, { label: `${info.title} (thumbnail)`.slice(0, 80), kind: "image", sourceNote: `The thumbnail of ${url}` });
            if (use === "model") setProjectReference(studio, projectId, { assetId: thumbnail.id, role: "style", note: "One picture from the video to take after. A hint at its look, not something to copy." });
          }
        } catch {
          // The thumbnail is a nicety.
        }
      }
    } else {
      const page = await get(url.toString());
      if (page.status === 401 || page.status === 402 || page.status === 403 || page.status === 429 || page.status === 451) {
        throw new Error(`${url.hostname} refused to hand the page to the studio (${page.status}). Sites do that for pages behind a login or a paywall, and to anything that is not a person's browser. Open the page in your browser, print it to PDF, and add the PDF here.`);
      }
      if (page.status >= 400) throw new Error(`${url.hostname} answered ${page.status} for that address. Check the link.`);
      if (page.type.includes("application/pdf") || page.body.subarray(0, 5).toString("latin1") === "%PDF-") {
        const title = decodeURIComponent(path.basename(new URL(page.url).pathname)).replace(/\.pdf$/i, "") || url.hostname;
        file = path.join(dir, fileName(title, ".pdf"));
        fs.writeFileSync(file, page.body);
        link = { url: url.toString(), kind: "pdf", title, from: url.hostname.replace(/^www\./, ""), fetchedAt: new Date().toISOString() };
      } else {
        const article = articleFromHtml(decode(page.body, page.type), page.url);
        if (article.words < 80) {
          throw new Error(`The page at ${url.hostname} gave almost no text (${article.words} words). It may need a login, or be drawn by scripts after it loads. Open it in your browser, print it to PDF, and add the PDF here.`);
        }
        link = { url: url.toString(), kind: "article", title: article.title, from: article.from, fetchedAt: new Date().toISOString() };
        file = path.join(dir, fileName(article.title, ".md"));
        fs.writeFileSync(file, `# ${article.title}\n\n${[article.byline && `By ${article.byline}.`, `From ${article.from ?? url.hostname}: ${url}`].filter(Boolean).join(" ")}\n\n${article.text}\n`);
        if (/medium\.com$/.test(url.hostname) && article.words < 400) warnings.push("This looks short for a Medium story. If it is a member-only story, only its opening was fetched: print the full page to PDF from your browser and add that instead.");
      }
    }
    let asset = await importAsset(studio, projectId, file, { label: link.title.slice(0, 80), kind: "document", sourceNote: opts.note?.trim() ?? "" });
    asset = updateAsset(studio, asset.id, { meta: { link, use } });
    await prepareDocument(studio, asset).catch(() => {});
    if (!documentInfo(asset)) throw new Error("The link was fetched but could not be read as a document.");
    return { asset, thumbnail, warnings };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
