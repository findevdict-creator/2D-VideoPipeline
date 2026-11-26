import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { VideoData } from "@pipeline/lib/types";
import type { PipelineConfig } from "../../config.js";
import { MANIM_DIR, REPO_ROOT } from "../../paths.js";
import { projectPaths } from "../store/projects.js";
import type { Studio } from "../studio.js";
import { libHash, renderClip, renderStills, templateBundle } from "./remotion.js";
import type { ClipResult, QualitySettings, RenderContext, Renderer } from "./types.js";

const sha = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);
const SCRIPT = path.join(MANIM_DIR, "studio_manim.py");
const SETUP_HINT = "Run: npm run setup:manim";

/** The Python that setup:manim installed, or a configured one, or the system Python. */
export function resolveManimPython(config: PipelineConfig): string {
  if (config.render.manim.python) return config.render.manim.python;
  const windows = process.platform === "win32";
  for (const root of [config.rootDir, REPO_ROOT]) {
    const venv = windows ? path.join(root, ".venv-manim", "Scripts", "python.exe") : path.join(root, ".venv-manim", "bin", "python");
    if (fs.existsSync(venv)) return venv;
  }
  return windows ? "python" : "python3";
}

let helperHashCache: string | undefined;

/** A hash of the Python the studio runs Manim scenes with. Clips are drawn again when it changes. */
export function manimHelperHash(): string {
  if (helperHashCache) return helperHashCache;
  const hash = createHash("sha1");
  for (const name of ["pipeline_manim.py", "studio_manim.py", "scene_check.py"]) hash.update(name).update(fs.readFileSync(path.join(MANIM_DIR, name)));
  return (helperHashCache = hash.digest("hex").slice(0, 16));
}

export interface ManimStatus {
  available: boolean;
  /** Manim's version, when it is installed. */
  version: string | null;
  latex: boolean;
  python: string;
  /** Why Manim scenes cannot be built, in words for the person. */
  why: string | null;
}

const statusCache = new Map<string, ManimStatus>();

/**
 * Whether this machine can build Manim scenes. Asked once per Python and remembered:
 * starting Python and importing Manim takes most of a second.
 */
export function manimStatus(config: PipelineConfig): ManimStatus {
  const python = resolveManimPython(config);
  const cached = statusCache.get(python);
  if (cached) return cached;
  let status: ManimStatus;
  const run = spawnSync(python, [SCRIPT], { input: JSON.stringify({ mode: "probe" }), encoding: "utf8", timeout: 60_000, windowsHide: true, env: pythonEnv() });
  const answer = parseAnswer(run.stdout ?? "");
  if (run.error) {
    status = { available: false, version: null, latex: false, python, why: `Python was not found ("${python}"). Manim scenes need Python and Manim. ${SETUP_HINT}` };
  } else if (answer?.ok) {
    status = { available: true, version: String(answer.manim), latex: Boolean(answer.latex), python, why: null };
  } else {
    status = { available: false, version: null, latex: false, python, why: `Manim is not installed for "${python}". ${SETUP_HINT}` };
  }
  statusCache.set(python, status);
  return status;
}

/** Forget what was learned about Python, for example after setup:manim has run. */
export function forgetManimStatus() {
  statusCache.clear();
}

function pythonEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", ...extra };
}

interface ManimAnswer {
  ok: boolean;
  problems?: string[];
  warnings?: string[];
  cues?: { id: string; occurrence: number; targetSec: number; reachedSec: number }[];
  builtSec?: number | null;
  durationSec?: number;
  plainEquations?: string[];
  latex?: boolean;
  font?: string;
  output?: string;
  frames?: number;
  trace?: string;
  missing?: string;
  manim?: string;
}

function parseAnswer(stdout: string): ManimAnswer | undefined {
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith("STUDIO_RESULT "));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice("STUDIO_RESULT ".length)) as ManimAnswer;
  } catch {
    return undefined;
  }
}

/** Run one job in Python. Stops it when it takes longer than the limit. */
function runManim(config: PipelineConfig, job: Record<string, unknown>, cwd: string, timeoutSec: number): Promise<ManimAnswer> {
  const python = resolveManimPython(config);
  fs.mkdirSync(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(python, [SCRIPT], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: pythonEnv() });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSec * 1000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-8000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Python ("${python}"): ${err.message}. ${SETUP_HINT}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const minutes = Math.round(timeoutSec / 60);
        reject(new Error(`Manim took longer than ${minutes >= 1 ? `${minutes} minute(s)` : `${timeoutSec} seconds`} to draw this scene and was stopped. Draw less, or raise render.manim.timeoutSec in pipeline.config.json.`));
        return;
      }
      const answer = parseAnswer(stdout);
      if (answer) resolve(answer);
      else reject(new Error(`Manim stopped without an answer (exit code ${code}):\n${stderr.trim().split(/\r?\n/).slice(-8).join("\n")}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(job));
  });
}

/** What the Python helper reads: the scene's look, length and cue times, in seconds. */
export function manimSceneData(data: VideoData) {
  const scene = data.scenes[0]!;
  const sec = (frame: number) => Math.round((frame / data.fps) * 10000) / 10000;
  return {
    title: scene.title,
    narration: scene.narration,
    fps: data.fps,
    width: data.width,
    height: data.height,
    durationSec: sec(scene.durationInFrames),
    durationInFrames: scene.durationInFrames,
    captionSafeArea: data.captionSafeArea,
    style: { palette: data.style.palette, fontFamily: data.style.fontFamily },
    cues: scene.cues.map((c) => ({ id: c.elementId, phrase: c.cue, startSec: sec(c.startFrame), endSec: sec(c.endFrame) })),
  };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * A scene written in Python for Manim, in scene.py. Manim draws the picture to a silent
 * video; that video is then played inside the same template as a footage scene, so its
 * entrance, overlays, captions and encoding match every other clip.
 */
export class ManimRenderer implements Renderer {
  readonly type = "manim" as const;
  readonly revision = "1";

  unavailable(studio: Studio): string | null {
    return manimStatus(studio.config).why;
  }

  /** Whether equations are typeset: LaTeX is installed and has not been switched off. */
  private latex(studio: Studio): boolean {
    return manimStatus(studio.config).latex && studio.config.render.manim.latex !== "off";
  }

  private source(ctx: RenderContext): string | undefined {
    return ctx.sourceFile && fs.existsSync(ctx.sourceFile) ? fs.readFileSync(ctx.sourceFile, "utf8") : undefined;
  }

  private dir(ctx: RenderContext) {
    return path.join(ctx.workDir, "manim");
  }

  /** Write the scene's data where Python reads it, and return the file with a hash of what decides the picture. */
  private prepare(ctx: RenderContext, code: string) {
    const dir = this.dir(ctx);
    fs.mkdirSync(dir, { recursive: true });
    const data = manimSceneData(ctx.data);
    const text = JSON.stringify(data, null, 2) + "\n";
    const dataFile = path.join(dir, "data.json");
    if (!fs.existsSync(dataFile) || fs.readFileSync(dataFile, "utf8") !== text) fs.writeFileSync(dataFile, text);
    const key = sha(JSON.stringify([code, text, manimHelperHash(), manimStatus(ctx.studio.config).version, this.latex(ctx.studio), this.revision]));
    return { dir, dataFile, key };
  }

  async check(ctx: RenderContext, notes: string[] = []): Promise<string[]> {
    const code = this.source(ctx);
    if (code === undefined) return [`The scene's code file does not exist yet. Write it to ${ctx.sourceFile}`];
    const status = manimStatus(ctx.studio.config);
    if (!status.available) return [`${status.why} Until then, give this scene another type.`];

    const { dir, dataFile, key } = this.prepare(ctx, code);
    const cacheFile = path.join(dir, "check.json");
    let answer: ManimAnswer | undefined;
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { key: string; answer: ManimAnswer };
      if (cached.key === key) answer = cached.answer;
    }
    if (!answer) {
      // Runs the scene without drawing it: finds errors and measures when each animation happens.
      answer = await runManim(ctx.studio.config, { mode: "check", source: ctx.sourceFile, data: dataFile, mediaDir: path.join(dir, "media"), latex: this.latex(ctx.studio) }, dir, Math.min(180, ctx.studio.config.render.manim.timeoutSec));
      fs.writeFileSync(cacheFile, JSON.stringify({ key, answer }));
    }
    const problems = [...(answer.problems ?? [])];
    for (const warning of answer.warnings ?? []) {
      // Animations that run past the narration or reach a cue late are for the scene's author to fix.
      const timing = /^(OVERRUN|LATE) (.*)$/s.exec(warning);
      if (timing) problems.push(timing[2]!);
      else notes.push(warning);
    }
    const plain = answer.plainEquations ?? [];
    if (plain.length) {
      const installed = manimStatus(ctx.studio.config).latex;
      const why = installed ? "LaTeX is switched off (render.manim.latex)" : "LaTeX is not installed on this machine";
      // The longest one is the one a person will recognise: the others are often single numbers on an axis.
      const example = plain.reduce((a, b) => (b.length > a.length ? b : a));
      notes.push(`${why}, so equations and numbers are shown as plain text in the video's font, for example "${example}".${installed ? "" : " Install LaTeX to have them typeset."}`);
    }
    return problems;
  }

  /** Have Manim draw the scene at a size, or reuse the video it drew for the same code and data. */
  private async raw(ctx: RenderContext, scale: number, onProgress: (p: number) => void = () => {}): Promise<{ file: string; frames: number }> {
    const code = this.source(ctx);
    if (code === undefined) throw new Error(`The scene's code file does not exist: ${ctx.sourceFile}`);
    const status = manimStatus(ctx.studio.config);
    if (!status.available) throw new Error(status.why!);
    const { dir, dataFile, key } = this.prepare(ctx, code);
    const width = even(ctx.project.width * scale);
    const height = even(ctx.project.height * scale);
    const outDir = path.join(dir, `${key}-${width}x${height}`);
    const file = path.join(outDir, "scene.mp4");
    const resultFile = path.join(outDir, "result.json");
    if (fs.existsSync(file) && fs.existsSync(resultFile)) {
      return { file, frames: (JSON.parse(fs.readFileSync(resultFile, "utf8")) as { frames: number }).frames };
    }
    // Older drawings of this scene are no use once its code or narration has changed.
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[0-9a-f]{16}-\d+x\d+$/.test(entry.name) && !entry.name.startsWith(key)) fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    }
    ctx.log(`Manim is drawing "${ctx.scene.title}" at ${width}x${height}.`);
    onProgress(0.02);
    const answer = await runManim(
      ctx.studio.config,
      { mode: "render", source: ctx.sourceFile, data: dataFile, mediaDir: path.join(dir, "media"), output: file, width, height, latex: this.latex(ctx.studio) },
      dir,
      ctx.studio.config.render.manim.timeoutSec,
    );
    if (!answer.ok || !answer.frames) throw new Error(`Manim could not draw the scene:\n  - ${(answer.problems ?? ["no video was written"]).join("\n  - ")}`);
    const needed = ctx.data.scenes[0]!.durationInFrames;
    if (answer.frames < needed) throw new Error(`Manim drew ${answer.frames} frames but the narration needs ${needed}.`);
    fs.writeFileSync(resultFile, JSON.stringify({ frames: answer.frames, warnings: answer.warnings ?? [] }));
    fs.rmSync(path.join(dir, "media"), { recursive: true, force: true });
    return { file, frames: answer.frames };
  }

  /** The scene's data with Manim's video in the place a footage scene has its clip. */
  private withVideo(ctx: RenderContext, raw: { file: string }): RenderContext {
    const scene = ctx.data.scenes[0]!;
    const src = projectPaths(ctx.studio, ctx.project).rel(raw.file).split(path.sep).join("/");
    const footage = { src, trimBeforeFrames: 0, playbackRate: 1, coveredFrames: scene.durationInFrames, after: "hold" as const, objectFit: "contain" as const };
    return { ...ctx, data: { ...ctx.data, scenes: [{ ...scene, kind: "footage", footage }] } };
  }

  async stills(ctx: RenderContext, frames: number[], outDir: string, scale: number) {
    const raw = await this.raw(ctx, ctx.studio.config.render.previewScale);
    return renderStills(this.withVideo(ctx, raw), await templateBundle(ctx.studio, ctx.project), frames, outDir, scale);
  }

  async render(ctx: RenderContext, q: QualitySettings, output: string, onProgress: (p: number) => void): Promise<ClipResult> {
    const raw = await this.raw(ctx, q.scale, onProgress);
    onProgress(0.3);
    return renderClip(this.withVideo(ctx, raw), await templateBundle(ctx.studio, ctx.project), q, output, (p) => onProgress(0.3 + 0.7 * p));
  }

  async cacheInputs(ctx: RenderContext) {
    const status = manimStatus(ctx.studio.config);
    return { code: sha(this.source(ctx) ?? ""), helper: manimHelperHash(), manim: status.version, latex: this.latex(ctx.studio), lib: libHash() };
  }
}
