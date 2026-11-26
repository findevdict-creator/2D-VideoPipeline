import fs from "node:fs";
import path from "node:path";
import { ffmpeg, ffmpegStream } from "../media/ffmpeg.js";
import { encodePng } from "../media/png.js";
import type { Studio } from "../studio.js";
import { getAsset } from "../store/assets.js";
import { getProject, projectPaths } from "../store/projects.js";
import { assetPreview } from "./preview.js";

export interface Keyframe {
  /** Counted from 1, in the order they appear in the video. */
  index: number;
  /** The moment the frame was taken at. */
  atSec: number;
  /** The stretch of the video this frame stands for. */
  shotStartSec: number;
  shotEndSec: number;
  /** Absolute path of the picture. */
  file: string;
  /** True for a frame that was asked for by its time, as opposed to found by looking at the video. */
  asked?: boolean;
}

export interface ReferenceKeyframes {
  keyframes: Keyframe[];
  /** One picture with every keyframe on it, numbered and timed. Null for a still image. */
  sheet: string | null;
  durationSec: number;
}

/** How small the video is made before its frames are compared. Detail does not matter for telling shots apart. */
const SMALL = 48;
/** A change this large between two neighbouring samples is a cut. Measured as the mean difference of all colour values, from 0 to 1. */
const CUT = 0.08;
/** A picture that has drifted this far from where its shot began counts as a new shot, which is how slow fades and build-ups are caught. */
const DRIFT = 0.12;
/** Samples looked at, at most: a long video is sampled more sparsely, not for longer. */
const MAX_SAMPLES = 480;

export interface Shot {
  /** First and last sample of the shot. */
  start: number;
  end: number;
  /** The sample that shows the shot best. */
  pick: number;
}

/**
 * Split a run of small frames into shots and choose one frame for each. `raw` holds the
 * frames back to back, `frameBytes` each. A shot ends at a cut, or when the picture has
 * drifted far from how the shot began. The frame chosen is the calmest one of the shot's
 * second half, so a scene that builds up is shown complete and a transition is never
 * picked. With more shots than `max`, the most alike neighbours are merged.
 */
export function pickShots(raw: Buffer, frameBytes: number, max: number): Shot[] {
  const n = Math.floor(raw.length / frameBytes);
  if (n <= 0) return [];
  const diff = (a: number, b: number) => {
    let sum = 0;
    const oa = a * frameBytes;
    const ob = b * frameBytes;
    for (let i = 0; i < frameBytes; i++) sum += Math.abs(raw[oa + i]! - raw[ob + i]!);
    return sum / frameBytes / 255;
  };
  const step = new Float64Array(n);
  for (let i = 1; i < n; i++) step[i] = diff(i - 1, i);

  let shots: Shot[] = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && step[i]! <= CUT && diff(start, i) <= DRIFT) continue;
    shots.push({ start, end: i - 1, pick: start });
    start = i;
  }
  // A single sample between two cuts is a transition caught halfway, not a shot.
  if (shots.length > 1) {
    const real = shots.filter((s) => s.end > s.start);
    if (real.length) shots = real;
  }
  for (const shot of shots) {
    const from = Math.floor((shot.start + shot.end) / 2);
    let best = Infinity;
    for (let i = from; i <= shot.end; i++) {
      const motion = (i > shot.start ? step[i]! : 0) + (i < shot.end ? step[i + 1]! : 0);
      // On a tie the later frame wins: things have arrived by then.
      if (motion <= best + 0.002) {
        best = Math.min(best, motion);
        shot.pick = i;
      }
    }
  }
  while (shots.length > Math.max(1, max)) {
    let at = 0;
    let least = Infinity;
    for (let i = 0; i + 1 < shots.length; i++) {
      const d = diff(shots[i]!.pick, shots[i + 1]!.pick);
      if (d < least) {
        least = d;
        at = i;
      }
    }
    const a = shots[at]!;
    const b = shots[at + 1]!;
    const longer = b.end - b.start > a.end - a.start ? b : a;
    shots.splice(at, 2, { start: a.start, end: b.end, pick: longer.pick });
  }
  return shots;
}

/**
 * The frames of a reference video worth looking at: one for each shot, found by comparing
 * the video's frames, plus a contact sheet that shows them all at once. Made once for each
 * `max` and kept in the project's work folder. For an image, the image itself.
 *
 * `include` adds frames at exact times, such as a moment the person picked by hand.
 */
export async function referenceKeyframes(studio: Studio, assetId: string, opts: { max?: number; include?: number[]; maxSide?: number } = {}): Promise<ReferenceKeyframes> {
  const asset = getAsset(studio, assetId);
  const max = Math.min(16, Math.max(1, Math.round(opts.max ?? 8)));
  if (asset.kind === "image") {
    const [image] = await assetPreview(studio, assetId, { maxSide: opts.maxSide });
    return { keyframes: [{ index: 1, atSec: 0, shotStartSec: 0, shotEndSec: 0, file: image!.file }], sheet: null, durationSec: 0 };
  }
  if (asset.kind !== "video") throw new Error(`Asset "${asset.label}" is ${asset.kind}, which has no frames to show.`);

  const p = projectPaths(studio, getProject(studio, asset.projectId));
  const source = p.abs(asset.path);
  const length = asset.durationSec ?? 0;
  const dir = path.join(p.work, "keyframes", asset.sha256.slice(0, 16));
  fs.mkdirSync(dir, { recursive: true });
  const width = asset.width ?? 16;
  const height = asset.height ?? 9;
  const maxSide = opts.maxSide ?? 1280;
  const scale = Math.max(width, height) > maxSide ? (width >= height ? `scale=${maxSide}:-2` : `scale=-2:${maxSide}`) : undefined;

  // Which moments: worked out once for each `max`, then read back.
  const planFile = path.join(dir, `shots-${max}.json`);
  let plan: { atSec: number; shotStartSec: number; shotEndSec: number }[];
  if (fs.existsSync(planFile)) {
    plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  } else {
    // Every frame is read small and every few are kept, which gives each sample an exact time.
    const fps = Number(asset.meta.fps) > 0 ? Number(asset.meta.fps) : 30;
    const every = Math.max(1, Math.round(fps / Math.min(4, Math.max(0.1, MAX_SAMPLES / Math.max(1, length)))));
    const rate = fps / every;
    const sw = width >= height ? SMALL : Math.max(8, Math.round((SMALL * width) / height));
    const sh = width >= height ? Math.max(8, Math.round((SMALL * height) / width)) : SMALL;
    const frameBytes = sw * sh * 3;
    const kept: Buffer[] = [];
    let current = Buffer.alloc(frameBytes);
    let filled = 0;
    let seen = 0;
    await ffmpegStream(["-i", source, "-an", "-vf", `scale=${sw}:${sh}`, "-f", "image2pipe", "-c:v", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], (chunk) => {
      for (let at = 0; at < chunk.length; ) {
        const take = Math.min(frameBytes - filled, chunk.length - at);
        if (seen % every === 0) chunk.copy(current, filled, at, at + take);
        filled += take;
        at += take;
        if (filled === frameBytes) {
          if (seen % every === 0) {
            kept.push(current);
            current = Buffer.alloc(frameBytes);
          }
          filled = 0;
          seen++;
        }
      }
    });
    const raw = Buffer.concat(kept);
    const last = Math.max(0, length - 0.05);
    const time = (sample: number) => Math.round(Math.min(last, Math.max(0, sample / rate)) * 100) / 100;
    plan = pickShots(raw, frameBytes, max).map((s) => ({ atSec: time(s.pick), shotStartSec: time(s.start), shotEndSec: s.end + 1 >= kept.length ? Math.round(length * 100) / 100 : time(s.end + 1) }));
    if (!plan.length) plan = [{ atSec: time(0), shotStartSec: 0, shotEndSec: Math.round(length * 100) / 100 }];
    fs.writeFileSync(planFile, JSON.stringify(plan));
  }

  const frame = async (atSec: number) => {
    const file = path.join(dir, `at-${Math.round(atSec * 1000)}-${maxSide}.jpg`);
    if (!fs.existsSync(file)) await ffmpeg(["-ss", String(atSec), "-i", source, ...(scale ? ["-vf", scale] : []), "-frames:v", "1", "-q:v", "3", file]);
    return file;
  };
  const keyframes: Keyframe[] = [];
  for (const shot of plan) keyframes.push({ index: 0, ...shot, file: await frame(shot.atSec) });
  for (const asked of opts.include ?? []) {
    const atSec = Math.round(Math.min(Math.max(0, length - 0.05), Math.max(0, asked)) * 100) / 100;
    const same = keyframes.find((k) => Math.abs(k.atSec - atSec) < 0.02);
    if (same) same.asked = true;
    else {
      const shot = plan.find((s) => atSec >= s.shotStartSec && atSec <= s.shotEndSec);
      keyframes.push({ index: 0, atSec, shotStartSec: shot?.shotStartSec ?? atSec, shotEndSec: shot?.shotEndSec ?? atSec, file: await frame(atSec), asked: true });
    }
  }
  keyframes.sort((a, b) => a.atSec - b.atSec);
  keyframes.forEach((k, i) => (k.index = i + 1));

  const sheet = path.join(dir, `sheet-${max}-${keyframes.map((k) => Math.round(k.atSec * 1000)).join("-").slice(0, 80)}.png`);
  if (!fs.existsSync(sheet)) await contactSheet(keyframes, width / height, sheet);
  return { keyframes, sheet, durationSec: length };
}

// ---------- The contact sheet ----------

const CELL = 440;
const GAP = 12;
const STRIP = 34;
const PAPER: Rgb = [17, 24, 39];
const INK: Rgb = [226, 232, 240];
const MARK: Rgb = [251, 191, 36];
type Rgb = [number, number, number];

/** A 5 by 7 dot font for the sheet's captions: digits and the few signs a time needs. */
const GLYPHS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "*": ["00000", "10101", "01110", "11111", "01110", "10101", "00000"],
};

/** "1:05.5" for 65.5 seconds. */
export const clock = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, "0")}`;

/** Draw every keyframe into one picture: a grid, each cell numbered and timed underneath. */
async function contactSheet(keyframes: Keyframe[], aspect: number, outFile: string) {
  const n = keyframes.length;
  const columns = n <= 3 ? n : n === 4 ? 2 : n <= 6 ? 3 : n === 9 ? 3 : 4;
  const rows = Math.ceil(n / columns);
  const cw = aspect >= 1 ? CELL : Math.max(120, Math.round(CELL * aspect));
  const ch = aspect >= 1 ? Math.max(120, Math.round(CELL / aspect)) : CELL;
  const width = columns * cw + (columns + 1) * GAP;
  const height = rows * (ch + STRIP) + (rows + 1) * GAP;
  const sheet = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) sheet.set(PAPER, i * 3);

  const text = (label: string, x0: number, y0: number, colour: Rgb, size = 3) => {
    let x = x0;
    for (const char of label) {
      const glyph = GLYPHS[char];
      if (glyph) {
        glyph.forEach((row, gy) => {
          for (let gx = 0; gx < 5; gx++) {
            if (row[gx] !== "1") continue;
            for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) sheet.set(colour, ((y0 + gy * size + dy) * width + x + gx * size + dx) * 3);
          }
        });
      }
      x += 6 * size;
    }
  };

  for (const [i, key] of keyframes.entries()) {
    const x0 = GAP + (i % columns) * (cw + GAP);
    const y0 = GAP + Math.floor(i / columns) * (ch + STRIP + GAP);
    const tmp = `${outFile}.${i}.rgb`;
    await ffmpeg(["-i", key.file, "-vf", `scale=${cw}:${ch}`, "-frames:v", "1", "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "image2", tmp]);
    const cell = fs.readFileSync(tmp);
    fs.rmSync(tmp, { force: true });
    for (let y = 0; y < ch; y++) cell.copy(sheet, ((y0 + y) * width + x0) * 3, y * cw * 3, (y + 1) * cw * 3);
    // A star marks a frame the person asked for.
    text(`#${key.index}  ${clock(key.atSec)}${key.asked ? " *" : ""}`, x0 + 2, y0 + ch + 7, key.asked ? MARK : INK);
  }
  fs.writeFileSync(outFile, encodePng(width, height, sheet));
}
