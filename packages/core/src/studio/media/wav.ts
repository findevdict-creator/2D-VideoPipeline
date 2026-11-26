import fs from "node:fs";
import path from "node:path";

export interface Pcm {
  sampleRate: number;
  /** Mono, 16-bit. */
  samples: Int16Array;
}

/** Read a WAV file (16-bit, 24-bit or float PCM) as mono 16-bit samples. */
export function readWav(file: string): Pcm {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file} is not a WAV file`);
  let format = 1;
  let channels = 1;
  let sampleRate = 24000;
  let bits = 16;
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in its sub-format field.
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    at = body + size + (size % 2);
  }
  if (!data) throw new Error(`${file} has no audio data`);
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bytes;
      if (format === 3) sum += (bits === 64 ? data.readDoubleLE(o) : data.readFloatLE(o)) * 32767;
      else if (bits === 16) sum += data.readInt16LE(o);
      else if (bits === 24) sum += data.readIntLE(o, 3) >> 8;
      else if (bits === 32) sum += data.readInt32LE(o) >> 16;
      else if (bits === 8) sum += (data.readUInt8(o) - 128) << 8;
      else throw new Error(`${file}: ${bits}-bit WAV audio is not supported`);
    }
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(sum / channels)));
  }
  return { sampleRate, samples };
}

function wavHeader(sampleRate: number, samples: number): Buffer {
  const data = samples * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data, 40);
  return header;
}

const bytesOf = (samples: Int16Array) => Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2);

export function writeWav(file: string, pcm: Pcm) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.sampleRate, pcm.samples.length), bytesOf(pcm.samples)]));
}

/** Change a clip's sample rate by linear interpolation. Enough for speech placed under a mix. */
export function resample(pcm: Pcm, sampleRate: number): Pcm {
  if (pcm.sampleRate === sampleRate) return pcm;
  const ratio = pcm.sampleRate / sampleRate;
  const out = new Int16Array(Math.floor(pcm.samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const a = Math.floor(x);
    const s0 = pcm.samples[a] ?? 0;
    const s1 = pcm.samples[a + 1] ?? s0;
    out[i] = Math.round(s0 + (s1 - s0) * (x - a));
  }
  return { sampleRate, samples: out };
}

/**
 * Lay narration clips end to end on the video's frame grid. Each clip starts exactly where
 * its scene starts, so rounding each scene to whole frames never lets the voice drift.
 */
export function layVoiceTrack(items: { file: string; startFrame: number; frames: number }[], fps: number, outFile: string): { sampleRate: number; samples: number } {
  const first = items[0] ? readWav(items[0].file) : { sampleRate: 24000, samples: new Int16Array(0) };
  const sampleRate = first.sampleRate;
  const at = (frame: number) => Math.round((frame / fps) * sampleRate);
  const total = at(items.reduce((n, i) => Math.max(n, i.startFrame + i.frames), 0));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  // Written clip by clip into a file of silence, so an hour of narration never has to fit in memory at once.
  const out = fs.openSync(outFile, "w");
  try {
    fs.writeSync(out, wavHeader(sampleRate, total), 0, 44, 0);
    fs.ftruncateSync(out, 44 + total * 2);
    items.forEach((item, index) => {
      const pcm = resample(index === 0 ? first : readWav(item.file), sampleRate);
      const start = at(item.startFrame);
      const room = Math.min(pcm.samples.length, at(item.startFrame + item.frames) - start, total - start);
      if (room > 0) fs.writeSync(out, bytesOf(pcm.samples.subarray(0, room)), 0, room * 2, 44 + start * 2);
    });
  } finally {
    fs.closeSync(out);
  }
  return { sampleRate, samples: total };
}
