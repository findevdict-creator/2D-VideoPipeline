import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { openBrowser } from "@remotion/renderer";
import { ffmpeg } from "../media/ffmpeg.js";
import type { Studio } from "../studio.js";

/** "auto" uses the graphics card where it works, "on" insists on it, "off" never touches it. */
export type GpuMode = Studio["config"]["render"]["gpu"];

/**
 * The H.264 encoder that runs on a graphics card, by operating system. These are the ones
 * Remotion can drive: NVIDIA's on Windows and Linux, Apple's on a Mac. Intel and AMD cards
 * still draw frames, but the picture is encoded on the processor.
 */
export function hardwareEncoder(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "darwin") return "h264_videotoolbox";
  if (platform === "win32" || platform === "linux") return "h264_nvenc";
  return undefined;
}

export interface EncoderCheck {
  /** The hardware encoder to use, when one works on this machine. */
  encoder?: string;
  /** Why not, in a sentence, when none does. */
  reason?: string;
}

function crc32(data: Buffer): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ~crc >>> 0;
}

/** A plain gray PNG, written by hand so the check needs nothing but ffmpeg. */
export function grayPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits per channel, RGB
  // Each row is a filter byte (0, none) and then its pixels.
  const rows = Buffer.alloc((width * 3 + 1) * height, 128);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

type RunFfmpeg = (args: string[]) => Promise<unknown>;

/**
 * Encode a few blank frames with the hardware encoder. ffmpeg listing an encoder says only
 * that it was built in; whether this machine has the card and driver for it shows when it runs.
 */
export async function probeEncoder(encoder: string | undefined = hardwareEncoder(), run: RunFfmpeg = ffmpeg): Promise<EncoderCheck> {
  if (!encoder) return { reason: `No hardware video encoder is supported on ${process.platform}.` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-gpu-"));
  try {
    // The ffmpeg that ships with Remotion reads images but not raw frames or test patterns.
    const frame = grayPng(320, 240);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `f${i}.png`), frame);
    await run(["-framerate", "30", "-i", path.join(dir, "f%d.png"), ...withEncoderQuality(["-c:v", encoder], 18), "-pix_fmt", "yuv420p", path.join(dir, "out.mp4")]);
    return { encoder };
  } catch (err) {
    const lines = (err instanceof Error ? err.message : String(err)).split(/\r?\n/).filter(Boolean);
    // ffmpeg's first complaint is the cause; what follows is it giving up.
    const cause = lines.find((l) => /nvenc|nvidia|cuda|videotoolbox|driver|unknown encoder|no capable devices|cannot load/i.test(l)) ?? lines.at(-1) ?? "it did not run";
    return { reason: `${encoder} did not work on this machine: ${cause.replace(/^\[[^\]]*\]\s*/, "").trim()}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let checked: Promise<EncoderCheck> | undefined;
let said = false;

/** Forget what was found, so the next render checks again. For tests, and after a hardware render failed. */
export function forgetEncoder(result?: EncoderCheck): void {
  checked = result ? Promise.resolve(result) : undefined;
  said = false;
}

/**
 * The hardware encoder to render with, or none. Checked once per run of the studio.
 * With render.gpu "on" a machine that cannot do it is an error instead of a quiet fallback.
 */
export async function encoderFor(studio: Studio, log: (message: string) => void = () => {}, probe: () => Promise<EncoderCheck> = probeEncoder): Promise<string | undefined> {
  const mode = studio.config.render.gpu;
  if (mode === "off") return undefined;
  checked ??= probe();
  const found = await checked;
  if (!found.encoder && mode === "on") {
    throw new Error(`render.gpu is "on" but the graphics card cannot encode video. ${found.reason ?? ""}\nSet render.gpu to "auto" in pipeline.config.json to fall back to the processor.`);
  }
  if (!said) {
    said = true;
    log(found.encoder ? `Encoding video on the graphics card (${found.encoder}).` : `Encoding video on the processor. ${found.reason ?? ""}`);
  }
  return found.encoder;
}

/** NVENC's constant-quality number that looks about like a given x264 CRF. */
export const nvencQuality = (crf: number) => Math.max(1, Math.min(51, crf + 3));

/**
 * Remotion starts a hardware encoder with no quality setting, which gives NVENC's small
 * default bitrate. Ask for constant quality instead, matched to the CRF the clip would have had.
 */
export function withEncoderQuality(args: string[], crf: number): string[] {
  const at = args.indexOf("h264_nvenc");
  if (at < 0 || args.includes("-cq")) return args;
  return [...args.slice(0, at + 1), "-preset", "p5", "-rc", "vbr", "-cq", String(nvencQuality(crf)), "-b:v", "0", ...args.slice(at + 1)];
}

/** A bitrate for encoders that take no quality number (Apple's), from the picture size and the CRF. */
export function bitrateFor(width: number, height: number, fps: number, crf: number): string {
  // About 0.1 bits per pixel at CRF 18, halving every 6 steps, as x264 does.
  const bits = width * height * fps * 0.1 * 2 ** ((18 - crf) / 6);
  return `${Math.max(300, Math.round(bits / 1000))}k`;
}

/**
 * True when a failed render failed because of the hardware encoder, so the processor should
 * be tried. When the encoder dies, Remotion is left writing frames to a closed pipe, and
 * that (EPIPE) is all it reports.
 */
export const isEncoderFailure = (message: string) => /nvenc|nvidia|cuda|videotoolbox|no capable devices|openencodesession|hardware accel|EPIPE/i.test(message);

/**
 * Run a hardware render so that a dying encoder cannot take the studio down with it. Besides
 * failing the render, Remotion's write to the closed pipe is rejected a second time with
 * nobody listening, which Node treats as a crash. That one error is absorbed while the render runs.
 */
export async function guardBrokenPipe<T>(job: () => Promise<T>): Promise<T> {
  const absorb = (reason: unknown) => {
    const pipe = (reason as NodeJS.ErrnoException | undefined)?.code === "EPIPE" || /EPIPE/.test(String(reason));
    // Anything else is somebody else's, and still ends the process when nobody else handles it.
    if (!pipe && process.listenerCount("unhandledRejection") === 1) throw reason;
  };
  process.on("unhandledRejection", absorb);
  try {
    return await job();
  } finally {
    // The stray rejection arrives a moment after the render's own.
    setTimeout(() => process.off("unhandledRejection", absorb), 2000).unref();
  }
}

export interface GpuReport {
  mode: GpuMode;
  /** What Chrome draws with, as it names it: the card's name, or a software renderer. */
  drawing: { gl: string; device?: string; software?: boolean; problem?: string }[];
  encoding: EncoderCheck;
}

const WHICH_DEVICE = `(() => {
  const gl = document.createElement("canvas").getContext("webgl");
  if (!gl) return "";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
})()`;

/** Software renderers Chrome falls back to when it has no graphics card to use. */
export const isSoftwareDevice = (device: string) => /swiftshader|llvmpipe|softpipe|basic render|warp|software/i.test(device);

/** Start Chrome the way a render does and ask which device it draws with. */
export async function drawingDevice(studio: Studio, gl: string | null): Promise<{ device?: string; problem?: string }> {
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  try {
    browser = await openBrowser("chrome", {
      browserExecutable: studio.config.render.browserExecutable || null,
      chromiumOptions: gl ? { gl: gl as "angle" } : {},
      logLevel: "error",
    });
    // Remotion's page type keeps `evaluate` to itself, so this goes around the types.
    const page = (await (browser as unknown as { newPage: (o: unknown) => Promise<{ evaluate: (code: string) => Promise<unknown> }> }).newPage({
      context: () => null,
      logLevel: "error",
      indent: false,
      pageIndex: 0,
      onBrowserLog: null,
      onLog: () => {},
    })) as { evaluate: (code: string) => Promise<unknown> };
    const device = String((await page.evaluate(WHICH_DEVICE)) ?? "");
    return device ? { device } : { problem: "Chrome could not start WebGL." };
  } catch (err) {
    return { problem: (err instanceof Error ? err.message : String(err)).split("\n")[0] };
  } finally {
    await browser?.close({ silent: true }).catch(() => {});
  }
}

/** What the graphics card is used for on this machine. Behind "npm run studio -- gpu". */
export async function gpuReport(studio: Studio): Promise<GpuReport> {
  const mode = studio.config.render.gpu;
  const choices = [...new Set([studio.config.render.gl ?? "angle", "swangle"])];
  const drawing: GpuReport["drawing"] = [];
  for (const gl of choices) {
    const found = await drawingDevice(studio, gl);
    drawing.push({ gl, ...found, software: found.device ? isSoftwareDevice(found.device) : undefined });
  }
  return { mode, drawing, encoding: await probeEncoder() };
}
