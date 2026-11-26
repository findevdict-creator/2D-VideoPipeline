import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bundle, type WebpackOverrideFn } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { LIB_DIR, LIB_INDEX, LIB_TSCONFIG, REPO_ROOT } from "../../paths.js";
import { checkSceneSource } from "../../render/sceneCheck.js";
import { projectPaths } from "../store/projects.js";
import type { SceneType } from "../model/scene.js";
import type { Studio } from "../studio.js";
import type { ClipResult, QualitySettings, RenderContext, Renderer } from "./types.js";

const sha = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);

let libHashCache: string | undefined;

/** A hash of the Remotion library's source. Clips are re-rendered when the library changes. */
export function libHash(): string {
  if (libHashCache) return libHashCache;
  const hash = createHash("sha1");
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|json)$/.test(entry.name)) hash.update(entry.name).update(fs.readFileSync(full));
    }
  };
  walk(path.join(LIB_DIR, "src"));
  return (libHashCache = hash.digest("hex").slice(0, 16));
}

/** Hash of every file in a folder, for the project's shared components. Empty folders hash the same. */
export function folderHash(dir: string): string {
  const hash = createHash("sha1");
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isFile()) hash.update(name).update(fs.readFileSync(full));
    }
  }
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
        "@pipeline/lib": LIB_INDEX,
        "@shared": sharedDir,
      },
      modules: [path.join(REPO_ROOT, "node_modules"), "node_modules", ...(config.resolve?.modules ?? [])],
    },
  });
}

const browser = (studio: Studio) => studio.config.render.browserExecutable || null;
const importPath = (file: string) => JSON.stringify(file.split(path.sep).join("/"));

/**
 * Bundle an entry file, reusing the last bundle in `outDir` when its key matches.
 * Bundling is the slow part of a still, so this matters when an agent asks for frames twice.
 */
async function bundleOnce(key: string, outDir: string, entrySource: string, sharedDir: string): Promise<string> {
  const marker = path.join(outDir, "bundle.key");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === key && fs.existsSync(path.join(outDir, "index.html"))) return outDir;
  fs.rmSync(outDir, { recursive: true, force: true });
  const work = `${outDir}-src`;
  fs.mkdirSync(path.join(work, "public"), { recursive: true });
  const entryPoint = path.join(work, "entry.tsx");
  fs.writeFileSync(entryPoint, entrySource);
  await bundle({ entryPoint, outDir, publicDir: path.join(work, "public"), webpackOverride: webpackOverride(sharedDir), rootDir: REPO_ROOT });
  fs.writeFileSync(marker, key);
  return outDir;
}

async function renderStills(ctx: RenderContext, serveUrl: string, frames: number[], outDir: string, scale: number): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  for (const old of fs.readdirSync(outDir)) if (old.endsWith(".png")) fs.rmSync(path.join(outDir, old), { force: true });
  const inputProps = { data: ctx.data };
  const composition = await selectComposition({ serveUrl, id: "Scene", inputProps, browserExecutable: browser(ctx.studio), logLevel: "error" });
  const files: string[] = [];
  for (const frame of frames) {
    const output = path.join(outDir, `f${String(frame).padStart(5, "0")}.png`);
    await renderStill({ composition, serveUrl, inputProps, frame, output, scale, browserExecutable: browser(ctx.studio), logLevel: "error" });
    files.push(output);
  }
  return files;
}

async function renderClip(ctx: RenderContext, serveUrl: string, q: QualitySettings, output: string, onProgress: (p: number) => void): Promise<ClipResult> {
  const inputProps = { data: ctx.data };
  const composition = await selectComposition({ serveUrl, id: "Scene", inputProps, browserExecutable: browser(ctx.studio), logLevel: "error" });
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
};

/** A scene written as a Remotion component in scene.tsx. */
export class RemotionCodeRenderer implements Renderer {
  readonly revision = "1";
  constructor(readonly type: SceneType = "remotion-2d") {}

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
    if (problems.length) return problems;
    return typecheckScene(ctx.sourceFile!, path.join(ctx.workDir, "check"), this.sharedDir(ctx));
  }

  private async bundle(ctx: RenderContext): Promise<string> {
    const code = this.source(ctx);
    if (code === undefined) throw new Error(`The scene's code file does not exist: ${ctx.sourceFile}`);
    const shared = this.sharedDir(ctx);
    const key = sha(JSON.stringify([code, libHash(), folderHash(shared), this.revision]));
    const entry = `// Generated by the studio. Do not edit.
import { registerRoot } from "remotion";
import { makeSceneRoot } from "@pipeline/lib";
import Scene from ${importPath(ctx.sourceFile!)};

registerRoot(makeSceneRoot(Scene));
`;
    return bundleOnce(key, path.join(ctx.workDir, "bundle"), entry, shared);
  }

  async stills(ctx: RenderContext, frames: number[], outDir: string, scale: number) {
    return renderStills(ctx, await this.bundle(ctx), frames, outDir, scale);
  }

  async render(ctx: RenderContext, q: QualitySettings, output: string, onProgress: (p: number) => void) {
    return renderClip(ctx, await this.bundle(ctx), q, output, onProgress);
  }

  async cacheInputs(ctx: RenderContext) {
    return { code: sha(this.source(ctx) ?? ""), lib: libHash(), shared: folderHash(this.sharedDir(ctx)) };
  }
}

/** Illustration and footage scenes: no code of their own, drawn by the library from the spec. */
export class RemotionTemplateRenderer implements Renderer {
  readonly revision = "1";
  constructor(readonly type: SceneType) {}

  async check(): Promise<string[]> {
    return [];
  }

  private bundle(ctx: RenderContext): Promise<string> {
    const entry = `// Generated by the studio. Do not edit.
import { registerRoot } from "remotion";
import { makeSceneRoot } from "@pipeline/lib";

registerRoot(makeSceneRoot());
`;
    // One bundle serves every data-only scene in the workspace: the scene arrives as input props.
    const outDir = path.join(ctx.studio.workspaceDir, ".cache", `templates-${libHash()}`);
    return bundleOnce(libHash(), outDir, entry, projectPaths(ctx.studio, ctx.project).sharedComponents);
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
