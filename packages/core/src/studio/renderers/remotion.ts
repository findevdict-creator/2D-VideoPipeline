import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bundle, type WebpackOverrideFn } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { LIB_DIR, LIB_INDEX, LIB_THREE, LIB_TSCONFIG, REPO_ROOT } from "../../paths.js";
import { checkSceneSource } from "../../render/sceneCheck.js";
import type { VideoData } from "@pipeline/lib/types";
import { projectPaths, type Project } from "../store/projects.js";
import type { SceneType } from "../model/scene.js";
import type { Studio } from "../studio.js";
import { checkThreeSource } from "./threeCheck.js";
import type { ClipResult, QualitySettings, RenderContext, Renderer } from "./types.js";

const sha = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);

const libHashCache = new Map<boolean, string>();

/**
 * A hash of the Remotion library's source. Clips are re-rendered when the library changes.
 * The 3D half counts only for 3D scenes, so changing it leaves 2D clips alone.
 */
export function libHash(withThree = false): string {
  const cached = libHashCache.get(withThree);
  if (cached) return cached;
  const hash = createHash("sha1");
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (withThree || full !== path.dirname(LIB_THREE)) walk(full);
      } else if (/\.(tsx?|json)$/.test(entry.name)) hash.update(entry.name).update(fs.readFileSync(full));
    }
  };
  walk(path.join(LIB_DIR, "src"));
  const value = hash.digest("hex").slice(0, 16);
  libHashCache.set(withThree, value);
  return value;
}

const IMPORT = /(?:from|import)\s*["']([^"']+)["']/g;

/** The shared components a piece of code imports, directly or through other shared components. */
export function sharedImports(code: string, sharedDir: string): string[] {
  const seen = new Set<string>();
  const visit = (source: string, fromDir: string) => {
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1]!;
      const base = spec.startsWith("@shared/") ? path.join(sharedDir, spec.slice(8)) : spec.startsWith(".") ? path.resolve(fromDir, spec) : undefined;
      if (!base) continue;
      const file = [base, `${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
      if (!file || seen.has(file) || path.relative(sharedDir, file).startsWith("..")) continue;
      seen.add(file);
      visit(fs.readFileSync(file, "utf8"), path.dirname(file));
    }
  };
  visit(code, sharedDir);
  return [...seen].sort();
}

/** Hash of the shared components a scene's code uses. Changing a component a scene does not import leaves its clip alone. */
export function sharedHash(code: string, sharedDir: string): string {
  const hash = createHash("sha1");
  for (const file of sharedImports(code, sharedDir)) hash.update(path.relative(sharedDir, file)).update(fs.readFileSync(file));
  return hash.digest("hex").slice(0, 16);
}

/** Lets scene files outside the repo import the library, the project's shared components, and React. */
function webpackOverride(sharedDir: string): WebpackOverrideFn {
  return (config) => ({
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...((config.resolve?.alias as Record<string, string> | undefined) ?? {}),
        // "$" makes each an exact match, so "@pipeline/lib/three" is not read as a path under the index file.
        "@pipeline/lib/three$": LIB_THREE,
        "@pipeline/lib$": LIB_INDEX,
        "@shared": sharedDir,
      },
      modules: [path.join(REPO_ROOT, "node_modules"), "node_modules", ...(config.resolve?.modules ?? [])],
    },
  });
}

export const browser = (studio: Studio) => studio.config.render.browserExecutable || null;
const importPath = (file: string) => JSON.stringify(file.split(path.sep).join("/"));

/**
 * Bundle an entry file, reusing the last bundle in `outDir` when its key matches.
 * Bundling is the slow part of a still, so this matters when an agent asks for frames twice.
 */
export function bundleOnce(key: string, outDir: string, entrySource: string, sharedDir: string): Promise<string> {
  // Two renders that need the same bundle at the same moment share one build instead of writing over each other.
  const running = bundling.get(outDir);
  if (running && running.key === key) return running.done;
  const done = (running ? running.done.catch(() => {}) : Promise.resolve())
    .then(() => bundleNow(key, outDir, entrySource, sharedDir))
    .finally(() => {
      if (bundling.get(outDir)?.done === done) bundling.delete(outDir);
    });
  bundling.set(outDir, { key, done });
  return done;
}

const bundling = new Map<string, { key: string; done: Promise<string> }>();

async function bundleNow(key: string, outDir: string, entrySource: string, sharedDir: string): Promise<string> {
  const marker = path.join(outDir, "bundle.key");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === key && fs.existsSync(path.join(outDir, "index.html"))) return outDir;
  fs.rmSync(outDir, { recursive: true, force: true });
  const work = `${outDir}-src`;
  fs.mkdirSync(path.join(work, "public"), { recursive: true });
  const entryPoint = path.join(work, "entry.tsx");
  fs.writeFileSync(entryPoint, entrySource);
  // Webpack's own cache is off: every scene is its own entry, so it is never hit, and it costs a quarter of a gigabyte of disk per scene.
  await bundle({ entryPoint, outDir, publicDir: path.join(work, "public"), webpackOverride: webpackOverride(sharedDir), rootDir: REPO_ROOT, enableCaching: false });
  fs.writeFileSync(marker, key);
  return outDir;
}

type Gl = NonNullable<Studio["config"]["render"]["gl"]>;
type ChromiumOptions = { gl?: Gl };

/** The backend that last drew a 3D frame in this process, so the next render starts with it. */
let glThatWorks: Gl | undefined;

/**
 * Run a render with a way of drawing 3D that works on this machine. 2D scenes need
 * nothing special. For 3D, the setting wins; without one, try the graphics card first
 * and software drawing second, and remember which one worked.
 */
export async function withGl<T>(studio: Studio, three: boolean, log: (m: string) => void, job: (chromiumOptions: ChromiumOptions) => Promise<T>): Promise<T> {
  if (!three) return job({});
  const set = studio.config.render.gl;
  const choices: Gl[] = set ? [set] : glThatWorks ? [glThatWorks] : ["angle", "swangle"];
  let lastError: unknown;
  for (const gl of choices) {
    try {
      const result = await job({ gl });
      glThatWorks = gl;
      return result;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!/webgl|web gl|gl context|ThreeCanvas/i.test(message) || gl === choices.at(-1)) break;
      log(`Drawing 3D with "${gl}" did not work on this machine; trying "${choices[choices.indexOf(gl) + 1]}".`);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  if (/webgl|web gl|gl context/i.test(message)) {
    throw new Error(`Chrome could not start 3D drawing (WebGL) on this machine. Set render.gl to "swangle" in pipeline.config.json to draw in software.\n${message.split("\n")[0]}`);
  }
  throw lastError;
}

export async function renderStills(ctx: RenderContext, serveUrl: string, frames: number[], outDir: string, scale: number, three = false): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  for (const old of fs.readdirSync(outDir)) if (old.endsWith(".png")) fs.rmSync(path.join(outDir, old), { force: true });
  const inputProps = { data: ctx.data };
  return withGl(ctx.studio, three, ctx.log, async (chromiumOptions) => {
    const composition = await selectComposition({ serveUrl, id: "Scene", inputProps, browserExecutable: browser(ctx.studio), chromiumOptions, logLevel: "error" });
    const files: string[] = [];
    for (const frame of frames) {
      const output = path.join(outDir, `f${String(frame).padStart(5, "0")}.png`);
      await renderStill({ composition, serveUrl, inputProps, frame, output, scale, browserExecutable: browser(ctx.studio), chromiumOptions, logLevel: "error" });
      files.push(output);
    }
    return files;
  });
}

export async function renderClip(ctx: RenderContext, serveUrl: string, q: QualitySettings, output: string, onProgress: (p: number) => void, three = false): Promise<ClipResult> {
  return withGl(ctx.studio, three, ctx.log, (chromiumOptions) => renderClipWith(ctx, serveUrl, q, output, onProgress, chromiumOptions));
}

async function renderClipWith(ctx: RenderContext, serveUrl: string, q: QualitySettings, output: string, onProgress: (p: number) => void, chromiumOptions: ChromiumOptions): Promise<ClipResult> {
  const inputProps = { data: ctx.data };
  const composition = await selectComposition({ serveUrl, id: "Scene", inputProps, browserExecutable: browser(ctx.studio), chromiumOptions, logLevel: "error" });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const partial = `${output}.part.mp4`;
  await renderMedia({
    composition,
    serveUrl,
    inputProps,
    // Every clip uses the same codec and pixel format, so the assembler can join them without re-encoding.
    codec: "h264",
    crf: q.crf,
    pixelFormat: "yuv420p",
    muted: true,
    outputLocation: partial,
    scale: q.scale,
    concurrency: ctx.studio.config.render.concurrency,
    browserExecutable: browser(ctx.studio),
    chromiumOptions,
    logLevel: "error",
    onProgress: ({ progress }) => onProgress(progress),
  });
  fs.renameSync(partial, output);
  return {
    file: output,
    durationFrames: composition.durationInFrames,
    width: Math.round(composition.width * q.scale),
    height: Math.round(composition.height * q.scale),
  };
}

/**
 * A still of a shared asset, so the agent that built it and the person approving it can
 * both see it. A component's Demo is drawn as a three-second scene of its own; a
 * character is drawn as its sheet, every pose and expression with its name.
 */
export async function renderSharedPreview(studio: Studio, project: Project, name: string, sourceFile: string, output: string, kind: "component" | "character" = "component"): Promise<void> {
  const p = projectPaths(studio, project);
  const code = fs.readFileSync(sourceFile, "utf8");
  const entry =
    kind === "character"
      ? `// Generated by the studio. Do not edit.
import React from "react";
import { registerRoot } from "remotion";
import { CharacterSheet, makeSceneRoot } from "@pipeline/lib";
import { ${name} } from ${importPath(sourceFile)};

registerRoot(makeSceneRoot(() => React.createElement(CharacterSheet, { character: ${name} })));
`
      : `// Generated by the studio. Do not edit.
import { registerRoot } from "remotion";
import { makeSceneRoot } from "@pipeline/lib";
import { Demo } from ${importPath(sourceFile)};

registerRoot(makeSceneRoot(Demo));
`;
  const key = sha(JSON.stringify([code, kind, libHash(), sharedHash(code, p.sharedComponents)]));
  const serveUrl = await bundleOnce(key, path.join(p.work, "shared-preview", name, "bundle"), entry, p.sharedComponents);
  const fps = project.fps;
  const durationInFrames = fps * 3;
  const data: VideoData = {
    title: project.title,
    fps,
    width: project.width,
    height: project.height,
    style: project.settings.theme,
    transitionFrames: 0,
    captionSafeArea: 0,
    scenes: [
      {
        id: `demo-${name}`,
        title: name,
        narration: "",
        layout: "",
        visualDescription: "",
        elements: [],
        onScreenText: [],
        transitionIn: "cut",
        camera: "static",
        startFrame: 0,
        durationInFrames,
        speechStartFrame: 0,
        speechEndFrame: durationInFrames,
        audio: null,
        cues: [],
        words: [],
        kind: "code",
        overlays: [],
      },
    ],
    captions: { enabled: false, fontSize: 54, position: "bottom", highlight: "accent", pages: [] },
    music: { src: null, volume: 0 },
  };
  const inputProps = { data };
  const browserExecutable = browser(studio);
  const composition = await selectComposition({ serveUrl, id: "Scene", inputProps, browserExecutable, logLevel: "error" });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // Two seconds in, entrances have finished.
  await renderStill({ composition, serveUrl, inputProps, frame: fps * 2, output, scale: studio.config.render.stillScale, browserExecutable, logLevel: "error" });
}

/** Type-check one scene file against the library. Returns error lines, shortened to start at the file name. */
export async function typecheckScene(sourceFile: string, workDir: string, sharedDir: string): Promise<string[]> {
  fs.mkdirSync(workDir, { recursive: true });
  const tsconfig = path.join(workDir, "tsconfig.json");
  fs.writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        extends: LIB_TSCONFIG,
        compilerOptions: {
          // Projects live outside the repo, so point module lookups at the repo's packages.
          paths: {
            "@pipeline/lib": [LIB_INDEX],
            "@pipeline/lib/three": [LIB_THREE],
            "@shared/*": [path.join(sharedDir, "*")],
            "*": [path.join(REPO_ROOT, "node_modules", "@types", "*"), path.join(REPO_ROOT, "node_modules", "*")],
          },
          typeRoots: [path.join(REPO_ROOT, "node_modules", "@types")],
        },
        include: [sourceFile],
      },
      null,
      2,
    ) + "\n",
  );
  const tsc = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, "-p", tsconfig, "--pretty", "false"], { cwd: workDir });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
  const name = path.basename(sourceFile);
  return output
    .split(/\r?\n/)
    .filter((line) => /error TS\d+/.test(line))
    .map((line) => {
      const at = line.lastIndexOf(name);
      return (at >= 0 ? line.slice(at) : line).trim();
    });
}

/** Imports a code scene may use. Shared components come from the project's shared folder. */
export const SCENE_IMPORTS: Partial<Record<SceneType, string[]>> = {
  "remotion-2d": ["@pipeline/lib", "remotion", "react"],
  r3f: ["@pipeline/lib", "@pipeline/lib/three", "remotion", "react", "three", "@react-three/fiber", "@react-three/drei"],
};

/** A scene written as a React component in scene.tsx: 2D with Remotion, or 3D with react-three-fiber inside it. */
export class RemotionCodeRenderer implements Renderer {
  readonly revision = "1";
  constructor(readonly type: SceneType = "remotion-2d") {}

  private get three() {
    return this.type === "r3f";
  }

  private sharedDir(ctx: RenderContext) {
    return projectPaths(ctx.studio, ctx.project).sharedComponents;
  }

  private source(ctx: RenderContext): string | undefined {
    return ctx.sourceFile && fs.existsSync(ctx.sourceFile) ? fs.readFileSync(ctx.sourceFile, "utf8") : undefined;
  }

  async check(ctx: RenderContext): Promise<string[]> {
    const code = this.source(ctx);
    if (code === undefined) return [`The scene's code file does not exist yet. Write it to ${ctx.sourceFile}`];
    const problems = checkSceneSource(code, { allowed: SCENE_IMPORTS[this.type], allowedPrefixes: ["@shared/"] });
    if (this.three) problems.push(...checkThreeSource(code));
    if (problems.length) return problems;
    return typecheckScene(ctx.sourceFile!, path.join(ctx.workDir, "check"), this.sharedDir(ctx));
  }

  private async bundle(ctx: RenderContext): Promise<string> {
    const code = this.source(ctx);
    if (code === undefined) throw new Error(`The scene's code file does not exist: ${ctx.sourceFile}`);
    const shared = this.sharedDir(ctx);
    const key = sha(JSON.stringify([code, libHash(this.three), sharedHash(code, shared), this.revision]));
    const entry = `// Generated by the studio. Do not edit.
import { registerRoot } from "remotion";
import { makeSceneRoot } from "@pipeline/lib";
import Scene from ${importPath(ctx.sourceFile!)};

registerRoot(makeSceneRoot(Scene));
`;
    return bundleOnce(key, path.join(ctx.workDir, "bundle"), entry, shared);
  }

  async stills(ctx: RenderContext, frames: number[], outDir: string, scale: number) {
    return renderStills(ctx, await this.bundle(ctx), frames, outDir, scale, this.three);
  }

  async render(ctx: RenderContext, q: QualitySettings, output: string, onProgress: (p: number) => void) {
    return renderClip(ctx, await this.bundle(ctx), q, output, onProgress, this.three);
  }

  async cacheInputs(ctx: RenderContext) {
    const code = this.source(ctx) ?? "";
    return { code: sha(code), lib: libHash(this.three), shared: sharedHash(code, this.sharedDir(ctx)) };
  }
}

/**
 * The bundle that draws scenes from data alone. One serves every such scene in the
 * workspace: the scene arrives as input props.
 */
export function templateBundle(studio: Studio, project: Project): Promise<string> {
  const entry = `// Generated by the studio. Do not edit.
import { registerRoot } from "remotion";
import { makeSceneRoot } from "@pipeline/lib";

registerRoot(makeSceneRoot());
`;
  const outDir = path.join(studio.workspaceDir, ".cache", `templates-${libHash()}`);
  return bundleOnce(libHash(), outDir, entry, projectPaths(studio, project).sharedComponents);
}

/** Illustration and footage scenes: no code of their own, drawn by the library from the spec. */
export class RemotionTemplateRenderer implements Renderer {
  readonly revision = "1";
  constructor(readonly type: SceneType) {}

  async check(): Promise<string[]> {
    return [];
  }

  private bundle(ctx: RenderContext): Promise<string> {
    return templateBundle(ctx.studio, ctx.project);
  }

  async stills(ctx: RenderContext, frames: number[], outDir: string, scale: number) {
    return renderStills(ctx, await this.bundle(ctx), frames, outDir, scale);
  }

  async render(ctx: RenderContext, q: QualitySettings, output: string, onProgress: (p: number) => void) {
    return renderClip(ctx, await this.bundle(ctx), q, output, onProgress);
  }

  async cacheInputs(ctx: RenderContext) {
    // The asset files themselves: replacing an image under the same id must re-render.
    const spec = ctx.version.spec;
    const ids = spec.type === "illustration" ? spec.illustration.shots.map((s) => s.assetId) : spec.type === "footage" ? [spec.footage.assetId] : [];
    const hashes = ids.map((id) => ctx.studio.db.get<{ sha256: string }>("SELECT sha256 FROM assets WHERE id = ?", [id])?.sha256 ?? "");
    return { lib: libHash(), assets: hashes };
  }
}
