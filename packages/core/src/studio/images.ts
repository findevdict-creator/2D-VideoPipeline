import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grayPng } from "./renderers/gpu.js";
import type { Studio } from "./studio.js";
import { assetUsage, findAsset, importAsset, replaceAssetFile, updateAsset, type Asset } from "./store/assets.js";
import { getProject, projectPaths, updateProject, type Project } from "./store/projects.js";
import { getScene, setSceneStatus } from "./store/scenes.js";

/** The shapes an image can be asked for in. The video's own shape is the default. */
export const IMAGE_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];

/** What is kept with a generated image, under `meta.generated` of its asset. */
export interface GeneratedInfo {
  prompt: string;
  model: string;
  aspect: string;
  by: "claude" | "you";
  at: string;
  /** How many times it has been made again. */
  round: number;
}

export const generatedInfo = (asset: Pick<Asset, "meta">): GeneratedInfo | undefined => asset.meta.generated as GeneratedInfo | undefined;

// ---------- The key ----------

const keyFile = (studio: Studio) => path.join(studio.workspaceDir, "keys.json");

/**
 * The Google AI Studio key, and where it came from. An environment variable wins, then the
 * key pasted in the studio (kept in the workspace, outside the repository), then pipeline.config.json.
 */
export function imageKey(studio: Studio): { key: string; from: "environment" | "studio" | "config" | null } {
  const env = tidyKey(process.env.GEMINI_API_KEY ?? "") || tidyKey(process.env.GOOGLE_API_KEY ?? "");
  if (env) return { key: env, from: "environment" };
  try {
    const saved = tidyKey(String((JSON.parse(fs.readFileSync(keyFile(studio), "utf8")) as { gemini?: string }).gemini ?? ""));
    if (saved) return { key: saved, from: "studio" };
  } catch {
    // No key saved yet.
  }
  const config = tidyKey(studio.config.studio.images.apiKey);
  return config ? { key: config, from: "config" } : { key: "", from: null };
}

/**
 * A key as it was pasted, without what tends to come along: spaces, line breaks, quotes,
 * invisible characters, and a "GEMINI_API_KEY=" in front.
 */
export function tidyKey(pasted: string): string {
  return pasted
    .replace(/[\u200b-\u200d\u2060\ufeff\u00a0]/g, " ")
    .trim()
    .replace(/^(?:export\s+)?[A-Za-z_]+\s*[=:]\s*/, "")
    .replace(/^["'`\u201c\u2018]+|["'`\u201d\u2019;,]+$/g, "")
    .trim();
}

/** Keep a key in the workspace, or forget it with an empty one. */
export function saveImageKey(studio: Studio, key: string): void {
  const k = tidyKey(key);
  // Whether it is a real key is for Google to say, the first time an image is made. Only what cannot be sent at all is refused here.
  if (k && !/^[\x21-\x7e]+$/.test(k)) throw new Error("The key has a space or an unusual character in the middle of it. Copy it again from Google AI Studio, as one unbroken word.");
  let all: Record<string, string> = {};
  try {
    all = JSON.parse(fs.readFileSync(keyFile(studio), "utf8")) as Record<string, string>;
  } catch {
    // The first key.
  }
  if (k) all.gemini = k;
  else delete all.gemini;
  fs.writeFileSync(keyFile(studio), JSON.stringify(all, null, 2), { mode: 0o600 });
  studio.emit("project.updated", {});
}

// ---------- The switch, and where a project stands ----------

const logFile = (studio: Studio, project: Project) => path.join(projectPaths(studio, project).assets, "generated.jsonl");

/** Images Claude has made for a project, counting ones made again. */
export function claudeImageCount(studio: Studio, project: Project): number {
  try {
    return fs
      .readFileSync(logFile(studio, project), "utf8")
      .split("\n")
      .filter((l) => l.includes('"by":"claude"')).length;
  } catch {
    return 0;
  }
}

export interface ImageStatus {
  /** The person allowed generated images for this video. */
  enabled: boolean;
  /** Enabled, and there is a key (or the stand-in engine), so an image can be made now. */
  ready: boolean;
  engine: "gemini" | "mock";
  model: string;
  keyFrom: "environment" | "studio" | "config" | null;
  /** Made by Claude so far, and the most it may make. */
  madeByClaude: number;
  limit: number;
}

export function imageStatus(studio: Studio, projectId: string): ImageStatus {
  const project = getProject(studio, projectId);
  const cfg = studio.config.studio.images;
  const { from } = imageKey(studio);
  const enabled = project.settings.images.enabled;
  return { enabled, ready: enabled && (cfg.engine === "mock" || from !== null), engine: cfg.engine, model: cfg.model, keyFrom: from, madeByClaude: claudeImageCount(studio, project), limit: cfg.maxPerProject };
}

/** Allow or forbid generated images for one video. */
export function setImagesEnabled(studio: Studio, projectId: string, enabled: boolean): Project {
  return updateProject(studio, projectId, { settings: { images: { enabled } } });
}

// ---------- Asking Google ----------

export interface ImageRequest {
  prompt: string;
  aspect: string;
  /** Pictures to keep the new one in line with: the same style, or the picture being changed. */
  references?: { mime: string; data: Buffer }[];
}

/** The first picture anywhere in an answer, whichever of Google's shapes it came in. */
export function findImage(answer: unknown): { mime: string; data: Buffer } | undefined {
  const seen = new Set<unknown>();
  const walk = (node: unknown): { mime: string; data: Buffer } | undefined => {
    if (!node || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return undefined;
    }
    const o = node as Record<string, unknown>;
    const mime = String(o.mime_type ?? o.mimeType ?? "");
    if (typeof o.data === "string" && o.data.length > 100 && (mime.startsWith("image/") || o.type === "image" || !mime)) {
      const data = Buffer.from(o.data, "base64");
      const sniffed = sniffMime(data);
      if (sniffed) return { mime: sniffed, data };
    }
    for (const value of Object.values(o)) {
      const found = walk(value);
      if (found) return found;
    }
    return undefined;
  };
  return walk(answer);
}

function sniffMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

/** Why an answer holds no picture, in Google's words where it gave any. */
function refusalIn(answer: unknown): string {
  const text = JSON.stringify(answer ?? {});
  const reason = /"(?:finishReason|finish_reason|blockReason|block_reason|status)"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const said = /"text"\s*:\s*"((?:[^"\\]|\\.){1,300})/.exec(text)?.[1];
  return [reason && reason !== "STOP" && reason !== "completed" ? `(${reason})` : "", said ? `It said: ${said.replace(/\\n/g, " ")}` : ""].filter(Boolean).join(" ");
}

/** One call to the Gemini API. Returns the picture, or throws with what Google answered. */
export async function requestImage(cfg: Studio["config"]["studio"]["images"], key: string, req: ImageRequest): Promise<{ mime: string; data: Buffer }> {
  const base = cfg.endpoint.replace(/\/+$/, "");
  const refs = req.references ?? [];
  let url: string;
  let body: unknown;
  if (cfg.api === "interactions") {
    url = `${base}/v1beta/interactions`;
    body = {
      model: cfg.model,
      input: [...refs.map((r) => ({ type: "image", mime_type: r.mime, data: r.data.toString("base64") })), { type: "text", text: req.prompt }],
      response_format: { type: "image", mime_type: "image/png", aspect_ratio: req.aspect, ...(cfg.size ? { image_size: cfg.size } : {}) },
    };
  } else {
    url = `${base}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
    body = {
      contents: [{ parts: [...refs.map((r) => ({ inline_data: { mime_type: r.mime, data: r.data.toString("base64") } })), { text: req.prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: req.aspect, ...(cfg.size ? { imageSize: cfg.size } : {}) } },
    };
  }
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutSec * 1000) });
  } catch (err) {
    const e = err as Error;
    throw new Error(e.name === "TimeoutError" ? `Google did not answer within ${cfg.timeoutSec} seconds.` : `Google's image service could not be reached: ${e.message}`);
  }
  const text = await res.text();
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    answer = undefined;
  }
  if (!res.ok) {
    const message = (answer as { error?: { message?: string } } | undefined)?.error?.message ?? text.slice(0, 300);
    const hint =
      res.status === 401 || res.status === 403 || /api key/i.test(message)
        ? " Check the key."
        : res.status === 404
          ? ` Check studio.images.model ("${cfg.model}") and studio.images.api ("${cfg.api}") in pipeline.config.json.`
          : res.status === 429
            ? " That is a rate or billing limit on the key."
            : "";
    throw new Error(`Google refused the image (${res.status}): ${message.trim()}${hint}`);
  }
  const image = findImage(answer);
  if (!image) throw new Error(`Google answered without a picture. ${refusalIn(answer)} Try other words in the prompt.`.replace(/\s+/g, " "));
  return image;
}

/** A plain picture in the right shape, coloured by its prompt, for the stand-in engine. */
function placeholder(req: ImageRequest): { mime: string; data: Buffer } {
  const [w, h] = req.aspect.split(":").map(Number) as [number, number];
  const hash = createHash("sha256").update(req.prompt).update(String(req.references?.length ?? 0)).digest();
  const long = 320;
  const width = w >= h ? long : Math.round((long * w) / h);
  const height = w >= h ? Math.round((long * h) / w) : long;
  return { mime: "image/png", data: grayPng(width, height, [hash[0]!, hash[1]!, hash[2]!]) };
}

// ---------- Making an image for a project ----------

export interface GenerateOptions {
  prompt: string;
  /** The name it gets under Assets. */
  label?: string;
  aspect?: string;
  /** Image assets to keep in line with, up to three. */
  referenceAssetIds?: string[];
  /** A generated image to make again under the same id, so the scenes that use it follow. */
  replaceAssetId?: string;
  by: "claude" | "you";
}

const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

/**
 * Make an image and put it under the project's assets, or make one of its generated images
 * again. Refuses unless the person switched image generation on for this video.
 */
export async function generateImage(studio: Studio, projectId: string, opts: GenerateOptions): Promise<{ asset: Asset; stale: string[] }> {
  const project = getProject(studio, projectId);
  const cfg = studio.config.studio.images;
  const p = projectPaths(studio, project);
  if (!project.settings.images.enabled) throw new Error("Generated images are switched off for this video. The person switches them on under Assets.");
  const prompt = opts.prompt.trim();
  if (prompt.length < 10) throw new Error("Describe the picture in at least a few words.");
  const aspect = opts.aspect ?? project.aspect;
  if (!(IMAGE_ASPECTS as readonly string[]).includes(aspect)) throw new Error(`An image's shape is one of: ${IMAGE_ASPECTS.join(", ")}.`);
  const made = claudeImageCount(studio, project);
  if (opts.by === "claude" && made >= cfg.maxPerProject) throw new Error(`Claude has made ${made} images for this video, which is the limit (studio.images.maxPerProject). Use the images there are.`);

  const previous = opts.replaceAssetId ? findAsset(studio, project.id, opts.replaceAssetId) : undefined;
  if (opts.replaceAssetId && !previous) throw new Error(`There is no asset with the id "${opts.replaceAssetId}" in this project.`);
  if (previous && !generatedInfo(previous)) throw new Error(`"${previous.label}" was not generated, so it cannot be generated again. It is the person's own file.`);

  const references: NonNullable<ImageRequest["references"]> = [];
  for (const id of (opts.referenceAssetIds ?? []).slice(0, 3)) {
    const ref = findAsset(studio, project.id, id);
    if (!ref) throw new Error(`There is no asset with the id "${id}" in this project.`);
    if (ref.kind !== "image" || !EXT[ref.mime ?? ""]) throw new Error(`"${ref.label}" is not a PNG, JPEG or WebP image, so it cannot guide a new one.`);
    references.push({ mime: ref.mime!, data: fs.readFileSync(p.abs(ref.path)) });
  }

  let image: { mime: string; data: Buffer };
  if (cfg.engine === "mock") {
    image = placeholder({ prompt: `${prompt}#${previous ? (generatedInfo(previous)!.round ?? 0) + 1 : 0}`, aspect, references });
  } else {
    const { key } = imageKey(studio);
    if (!key) throw new Error("There is no Google AI Studio key yet. Paste one under Assets, or set GEMINI_API_KEY before starting the studio.");
    image = await requestImage(cfg, key, { prompt, aspect, references });
  }

  const info: GeneratedInfo = { prompt, model: cfg.engine === "mock" ? "stand-in" : cfg.model, aspect, by: opts.by, at: new Date().toISOString(), round: previous ? (generatedInfo(previous)!.round ?? 0) + 1 : 0 };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-image-"));
  try {
    const label = (opts.label?.trim() || previous?.label || prompt.split(/\s+/).slice(0, 6).join(" ")).slice(0, 60);
    const tmp = path.join(tmpDir, `${label.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "image"}${EXT[image.mime] ?? ".png"}`);
    fs.writeFileSync(tmp, image.data);
    let asset: Asset;
    const stale: string[] = [];
    if (previous) {
      asset = await replaceAssetFile(studio, previous.id, tmp, { generated: info });
      // The clips that show the old picture are out of date; drawing them again needs no Claude run.
      for (const sceneId of assetUsage(studio, previous.id)) {
        if (["rendered", "needs_review", "approved"].includes(getScene(studio, sceneId).status)) {
          setSceneStatus(studio, sceneId, "stale", `Its image "${asset.label}" was generated again`);
          stale.push(sceneId);
        }
      }
    } else {
      asset = await importAsset(studio, project.id, tmp, { label, kind: "image", sourceNote: `Generated from: ${prompt}`.slice(0, 500) });
      // The same picture twice is the same asset; what it was made from is kept the first time only.
      if (!generatedInfo(asset)) asset = updateAsset(studio, asset.id, { meta: { generated: info } });
    }
    fs.mkdirSync(p.assets, { recursive: true });
    fs.appendFileSync(logFile(studio, project), `${JSON.stringify({ at: info.at, by: info.by, assetId: asset.id, model: info.model, prompt })}\n`);
    return { asset, stale };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
