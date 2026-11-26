import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Remotion ships its own ffmpeg and ffprobe, so nobody has to install them.
 * FFMPEG_DIR overrides that with a folder holding your own builds.
 */
function bundledDir(): string | undefined {
  const names: Record<string, string[]> = {
    "linux-x64": ["@remotion/compositor-linux-x64-gnu", "@remotion/compositor-linux-x64-musl"],
    "linux-arm64": ["@remotion/compositor-linux-arm64-gnu", "@remotion/compositor-linux-arm64-musl"],
    "darwin-x64": ["@remotion/compositor-darwin-x64"],
    "darwin-arm64": ["@remotion/compositor-darwin-arm64"],
    "win32-x64": ["@remotion/compositor-win32-x64-msvc"],
  };
  for (const name of names[`${process.platform}-${process.arch}`] ?? []) {
    try {
      const dir = path.dirname(require.resolve(`${name}/package.json`));
      if (existsSync(path.join(dir, exe("ffmpeg")))) return dir;
    } catch {
      // not installed for this platform
    }
  }
  return undefined;
}

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

let cached: { dir?: string } | undefined;

function binary(name: "ffmpeg" | "ffprobe"): { cmd: string; env: NodeJS.ProcessEnv } {
  cached ??= { dir: process.env.FFMPEG_DIR || bundledDir() };
  if (!cached.dir) return { cmd: name, env: process.env };
  const dir = cached.dir;
  // The bundled binaries load their libraries from the folder they sit in.
  const libVar = process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  const env = { ...process.env, [libVar]: [dir, process.env[libVar]].filter(Boolean).join(path.delimiter) };
  return { cmd: path.join(dir, exe(name)), env };
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

function run(name: "ffmpeg" | "ffprobe", args: string[], opts: { cwd?: string; signal?: AbortSignal } = {}): Promise<RunResult> {
  const { cmd, env } = binary(name);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd: opts.cwd, windowsHide: true, signal: opts.signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => reject(new Error(`Could not start ${name}: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${name} failed (exit code ${code}):\n${stderr.trim().split(/\r?\n/).slice(-12).join("\n")}`));
    });
  });
}

export const ffmpeg = (args: string[], opts?: { cwd?: string; signal?: AbortSignal }) =>
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], opts);

export interface MediaInfo {
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  frames?: number;
  codec?: string;
}

/** What ffprobe can tell about an image, video or audio file. */
export async function probe(file: string): Promise<MediaInfo> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-count_packets", file]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; duration?: string; nb_read_packets?: string }[];
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration);
  let fps: number | undefined;
  if (video?.r_frame_rate) {
    const [n, d] = video.r_frame_rate.split("/").map(Number);
    if (n && d) fps = n / d;
  }
  return {
    durationSec: Number.isFinite(duration) ? duration : undefined,
    width: video?.width,
    height: video?.height,
    fps,
    hasVideo: !!video,
    hasAudio: !!audio,
    frames: video?.nb_read_packets ? Number(video.nb_read_packets) : undefined,
    codec: video?.codec_name ?? audio?.codec_name,
  };
}
