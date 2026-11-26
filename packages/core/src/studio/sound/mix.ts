import fs from "node:fs";
import path from "node:path";
import { loadPronunciations } from "../../voice/text.js";
import { ffmpeg } from "../media/ffmpeg.js";
import { layVoiceTrack, readWav, wavHeader, wavLayout } from "../media/wav.js";
import type { Studio } from "../studio.js";
import { findAsset, type Asset } from "../store/assets.js";
import { projectPaths, type Project } from "../store/projects.js";
import { getVersion, type SceneVersion } from "../store/scenes.js";
import { cueFrames, getVoiceTrack, type VoiceTrack } from "../voice.js";
import { builtInSound } from "./builtin.js";

/** Everything is mixed at this rate. */
export const MIX_RATE = 48000;

/**
 * Any audio file of the project as a 16-bit WAV at the mixing rate, converted once and
 * kept in the work folder. "mono" folds it to one channel; "own" keeps one or two
 * channels as they are, and folds anything wider down to two.
 */
async function asWav(studio: Studio, project: Project, asset: Asset, channels: "mono" | "own"): Promise<string> {
  const p = projectPaths(studio, project);
  const file = path.join(p.work, "sound", `${asset.sha256.slice(0, 16)}-${channels}.wav`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const part = `${file}.part.wav`;
    const convert = (ac: string[]) => ffmpeg(["-i", p.abs(asset.path), "-vn", ...ac, "-ar", String(MIX_RATE), "-c:a", "pcm_s16le", part]);
    await convert(channels === "mono" ? ["-ac", "1"] : []);
    if (channels === "own" && wavLayout(part).channels > 2) await convert(["-ac", "2"]);
    fs.renameSync(part, file);
  }
  return file;
}

// ---------- Sound effects ----------

export interface SfxEvent {
  /** When the sound's moment is: the time the picture changes. In seconds from the start of whatever is being mixed. */
  atSec: number;
  /** Where the sound itself starts, which is earlier for a sound that swells up to its moment. */
  startSec: number;
  samples: Float32Array;
  gain: number;
  /** What it is, for logs and the scene page. */
  label: string;
}

/**
 * The sound effects of one scene version, timed from the scene's start. A sound tied to a
 * cue is placed on the frame the cue's phrase starts on, which is the frame the picture
 * reacts on.
 */
export async function sceneSfx(studio: Studio, project: Project, version: SceneVersion, track: VoiceTrack): Promise<SfxEvent[]> {
  const spec = version.spec;
  if (!spec.sfx.length) return [];
  const cues = cueFrames(spec.cues, track, project.fps, await loadPronunciations(studio.config));
  const master = project.settings.sfx.volume;
  const events: SfxEvent[] = [];
  for (const sfx of spec.sfx) {
    const frame = sfx.at.cue !== undefined ? (cues.find((c) => c.id === sfx.at.cue)?.startFrame ?? 0) : Math.round((sfx.at.sec ?? 0) * project.fps);
    const atSec = frame / project.fps;
    if (atSec >= track.durationSec) continue;
    let samples: Float32Array;
    let leadSec = 0;
    let label: string;
    if (sfx.sound) {
      const sound = builtInSound(sfx.sound, MIX_RATE);
      samples = sound.samples;
      leadSec = sound.leadSec;
      label = sfx.sound;
    } else {
      const asset = sfx.assetId ? findAsset(studio, project.id, sfx.assetId) : undefined;
      if (!asset) continue; // The scene's check reports a missing file; the mix goes on without it.
      const pcm = readWav(await asWav(studio, project, asset, "mono"));
      samples = Float32Array.from(pcm.samples, (v) => v / 32768);
      label = asset.label;
    }
    events.push({ atSec, startSec: Math.max(0, atSec - leadSec), samples, gain: sfx.volume * master, label });
  }
  return events;
}

/**
 * Write sound effects into one mono track of `totalSec`, a second at a time, so the track
 * of a long video never has to fit in memory. Sounds that overlap add up; a sound that
 * rings on past the end is cut there.
 */
export function laySfx(events: SfxEvent[], totalSec: number, outFile: string): void {
  const total = Math.round(totalSec * MIX_RATE);
  const placed = events.map((e) => ({ ...e, start: Math.round(e.startSec * MIX_RATE) })).sort((a, b) => a.start - b.start);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const out = fs.openSync(outFile, "w");
  try {
    fs.writeSync(out, wavHeader(MIX_RATE, total));
    const block = new Float32Array(MIX_RATE);
    const bytes = Buffer.alloc(block.length * 2);
    for (let from = 0; from < total; from += block.length) {
      const length = Math.min(block.length, total - from);
      block.fill(0);
      for (const e of placed) {
        if (e.start >= from + length) break;
        const first = Math.max(from, e.start);
        const last = Math.min(from + length, e.start + e.samples.length);
        for (let i = first; i < last; i++) block[i - from]! += e.samples[i - e.start]! * e.gain;
      }
      for (let i = 0; i < length; i++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, block[i]!)) * 32767), i * 2);
      fs.writeSync(out, bytes, 0, length * 2);
    }
  } finally {
    fs.closeSync(out);
  }
}

// ---------- Music ----------

export interface DuckOptions {
  /** How loud the music is under the voice, and where nobody speaks. */
  under: number;
  full: number;
  /** Seconds the music takes to go down, ending as the voice starts. */
  attackSec?: number;
  /** Seconds the music stays down after the voice stops, so it does not jump up at every breath. */
  holdSec?: number;
  /** Seconds it takes to come back up. */
  releaseSec?: number;
}

export interface Breakpoint {
  sec: number;
  gain: number;
}

/**
 * How loud the music is over time: down under each stretch of speech, back up in the
 * pauses that are long enough to be worth it. Returned as corner points; between two
 * points the level moves in a straight line. A pause too short for the music to come up
 * and go down again is left alone, which is what stops the music from pumping between
 * sentences.
 */
export function duckingEnvelope(speech: [number, number][], totalSec: number, opts: DuckOptions): Breakpoint[] {
  const attack = opts.attackSec ?? 0.3;
  const hold = opts.holdSec ?? 0.4;
  const release = opts.releaseSec ?? 0.8;
  const spans = speech
    .filter(([a, b]) => b > a)
    .map(([a, b]) => [Math.max(0, a - attack), b + hold] as [number, number])
    .sort((x, y) => x[0] - y[0]);
  // Stretches the music stays down for. Two join when the music could not get back up between them.
  const down: [number, number][] = [];
  for (const span of spans) {
    const last = down.at(-1);
    if (last && span[0] <= last[1] + release) last[1] = Math.max(last[1], span[1]);
    else down.push([...span]);
  }
  const points: Breakpoint[] = [{ sec: 0, gain: down[0]?.[0] === 0 ? opts.under : opts.full }];
  for (const [start, end] of down) {
    // `start` already includes the attack: the level begins to fall there and is down by the first word.
    if (start > 0) points.push({ sec: start, gain: opts.full }, { sec: start + attack, gain: opts.under });
    if (end < totalSec) points.push({ sec: end, gain: opts.under }, { sec: Math.min(totalSec, end + release), gain: end + release <= totalSec ? opts.full : opts.under + ((opts.full - opts.under) * (totalSec - end)) / release });
  }
  points.push({ sec: Math.max(totalSec, points.at(-1)!.sec), gain: points.at(-1)!.gain });
  return points;
}

/** The level at a moment, from an envelope's corner points. */
export function levelAt(points: Breakpoint[], sec: number): number {
  if (sec <= points[0]!.sec) return points[0]!.gain;
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (sec > b.sec) continue;
    const a = points[i - 1]!;
    return b.sec === a.sec ? b.gain : a.gain + ((b.gain - a.gain) * (sec - a.sec)) / (b.sec - a.sec);
  }
  return points.at(-1)!.gain;
}

/** Seconds the music fades in over at the start of the video, and out over at its end. */
const FADE_IN_SEC = 0.6;
const FADE_OUT_SEC = 1.8;
/** Seconds of fade on each side of the point where the music starts over. */
const LOOP_FADE_SEC = 0.04;

/**
 * Write the music track: `source` (a 16-bit WAV at the mixing rate) repeated to fill
 * `totalSec`, shaped by the envelope, faded in at the start and out at the end. Worked
 * through a second at a time.
 */
export function layMusic(source: string, totalSec: number, envelope: Breakpoint[], outFile: string): void {
  const { channels, dataOffset, frames, sampleRate } = wavLayout(source);
  if (sampleRate !== MIX_RATE) throw new Error(`The music was expected at ${MIX_RATE} Hz, found ${sampleRate}`);
  const total = Math.round(totalSec * MIX_RATE);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const out = fs.openSync(outFile, "w");
  const src = fs.openSync(source, "r");
  try {
    fs.writeSync(out, wavHeader(MIX_RATE, total, channels));
    if (frames <= 0) return void fs.ftruncateSync(out, 44 + total * 2 * channels);
    const size = 2 * channels;
    const block = Buffer.alloc(MIX_RATE * size);
    const loopFade = Math.min(Math.floor(frames / 4), Math.round(LOOP_FADE_SEC * MIX_RATE));
    let at = 0; // position in the source
    let point = 1; // the envelope corner the current sample lies before
    for (let from = 0; from < total; ) {
      // Read up to a second, without crossing the end of the source.
      const length = Math.min(MIX_RATE, total - from, frames - at);
      fs.readSync(src, block, 0, length * size, dataOffset + at * size);
      for (let i = 0; i < length; i++) {
        const n = from + i;
        const sec = n / MIX_RATE;
        while (point < envelope.length - 1 && envelope[point]!.sec < sec) point++;
        const a = envelope[point - 1]!;
        const b = envelope[point]!;
        let gain = b.sec <= a.sec || sec >= b.sec ? b.gain : sec <= a.sec ? a.gain : a.gain + ((b.gain - a.gain) * (sec - a.sec)) / (b.sec - a.sec);
        gain *= Math.min(1, sec / FADE_IN_SEC, (totalSec - sec) / FADE_OUT_SEC);
        const inSource = at + i;
        if (loopFade > 0 && total > frames) gain *= Math.min(1, (inSource + 1) / loopFade, (frames - inSource) / loopFade);
        for (let c = 0; c < channels; c++) {
          const o = (i * channels + c) * 2;
          block.writeInt16LE(Math.round(Math.max(-32768, Math.min(32767, block.readInt16LE(o) * Math.max(0, gain)))), o);
        }
      }
      fs.writeSync(out, block, 0, length * size);
      from += length;
      at = (at + length) % frames;
    }
  } finally {
    fs.closeSync(src);
    fs.closeSync(out);
  }
}

/** The stretches of a narration in which words are spoken, with breaths between words closed up. */
export function speechSpans(track: VoiceTrack, joinWithinSec = 0.35): [number, number][] {
  const words = track.words.length ? track.words.map((w) => [w.startSec, w.endSec] as [number, number]) : [[track.speechStartSec, track.speechEndSec] as [number, number]];
  const spans: [number, number][] = [];
  for (const [start, end] of words) {
    const last = spans.at(-1);
    if (last && start - last[1] <= joinWithinSec) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  return spans;
}

// ---------- The whole soundtrack ----------

export interface Soundtrack {
  /** The narration, laid on the frame grid. */
  voice: string;
  /** The music, already shaped and as long as the video. Absent without music. */
  music?: string;
  /** The sound effects. Absent when there are none, or they are switched off. */
  sfx?: string;
  /** When each sound effect is heard, in seconds from the start. */
  effects: { atSec: number; label: string }[];
  /** When somebody speaks. */
  speech: [number, number][];
  durationSec: number;
}

/**
 * Make the audio tracks of a video from the scene versions in it: the narration, the
 * sound effects their specs name, and the project's music dipped under the voice. The
 * tracks are written into `workDir`; mixArgs() turns them into the ffmpeg arguments
 * that mix them.
 */
export async function buildSoundtrack(
  studio: Studio,
  project: Project,
  parts: { versionId: string; startFrame: number; frames: number }[],
  workDir: string,
  log: (message: string) => void = () => {},
): Promise<Soundtrack> {
  const p = projectPaths(studio, project);
  const fps = project.fps;
  const totalFrames = parts.reduce((n, part) => Math.max(n, part.startFrame + part.frames), 0);
  const durationSec = totalFrames / fps;
  const voiceItems: { file: string; startFrame: number; frames: number }[] = [];
  const events: SfxEvent[] = [];
  const speech: [number, number][] = [];
  const effectsOn = project.settings.sfx.enabled;
  for (const part of parts) {
    const version = getVersion(studio, part.versionId);
    const track = version.voiceTrackId ? getVoiceTrack(studio, version.voiceTrackId) : undefined;
    if (!track) continue;
    const startSec = part.startFrame / fps;
    const endSec = (part.startFrame + part.frames) / fps;
    voiceItems.push({ file: p.abs(track.audioPath), startFrame: part.startFrame, frames: part.frames });
    for (const [a, b] of speechSpans(track)) if (startSec + a < endSec) speech.push([startSec + a, Math.min(endSec, startSec + b)]);
    if (effectsOn) for (const e of await sceneSfx(studio, project, version, track)) events.push({ ...e, atSec: startSec + e.atSec, startSec: startSec + e.startSec });
  }
  fs.mkdirSync(workDir, { recursive: true });
  const sound: Soundtrack = { voice: path.join(workDir, "voice.wav"), effects: events.map((e) => ({ atSec: e.atSec, label: e.label })), speech, durationSec };
  layVoiceTrack(voiceItems, fps, sound.voice);
  if (events.length) {
    sound.sfx = path.join(workDir, "sfx.wav");
    laySfx(events, durationSec, sound.sfx);
    log(`Placed ${events.length} sound effect(s)`);
  }
  const m = project.settings.music;
  const music = m.assetId ? findAsset(studio, project.id, m.assetId) : undefined;
  if (music) {
    const envelope = m.duck ? duckingEnvelope(speech, durationSec, { under: m.volume, full: Math.max(m.volume, m.gapVolume) }) : [{ sec: 0, gain: m.volume }, { sec: durationSec, gain: m.volume }];
    sound.music = path.join(workDir, "music.wav");
    layMusic(await asWav(studio, project, music, "own"), durationSec, envelope, sound.music);
    log(m.duck ? `Laid "${music.label}" under the narration, dipping for ${envelope.length > 2 ? "each stretch of speech" : "all of it"}` : `Laid "${music.label}" at a steady level`);
  }
  return sound;
}

/**
 * The ffmpeg arguments that mix a soundtrack: its files as inputs, and the filter that
 * joins them into one stereo stream called [mix]. `firstInput` is the number the first of
 * these inputs will have on the command line. A soundtrack that is only narration needs
 * no filter and gets none.
 */
export function mixArgs(sound: Soundtrack, firstInput: number): { inputs: string[]; filter: string | null; map: string } {
  const files = [sound.voice, sound.music, sound.sfx].filter((f): f is string => Boolean(f));
  const inputs = files.flatMap((f) => ["-i", f]);
  if (files.length === 1) return { inputs, filter: null, map: `${firstInput}:a` };
  // A one-channel track goes to both sides at its own level. (Left to itself, ffmpeg would turn it down by 3 dB on the way.)
  const stereo = files.map((file, i) => `[${firstInput + i}:a]aresample=${MIX_RATE},${wavLayout(file).channels === 1 ? "pan=stereo|c0=c0|c1=c0" : "aformat=channel_layouts=stereo"}[a${i}]`);
  return { inputs, filter: `${stereo.join(";")};${files.map((_, i) => `[a${i}]`).join("")}amix=inputs=${files.length}:duration=first:normalize=0[mix]`, map: "[mix]" };
}
