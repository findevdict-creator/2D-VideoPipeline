import fs from "node:fs";
import zlib from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};

/** Write a PNG whose colour at each pixel comes from `pixel`. Enough to tell where a camera is looking. */
export function writePng(file: string, width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]),
  );
}

/** A test card: four coloured quarters with a white grid, so pans and zooms are easy to see. */
export function writeTestCard(file: string, width = 1600, height = 1000) {
  const quarters: [number, number, number][] = [[200, 60, 60], [60, 160, 80], [60, 90, 200], [220, 180, 50]];
  writePng(file, width, height, (x, y) => {
    if (x % 100 < 3 || y % 100 < 3) return [255, 255, 255];
    return quarters[(x < width / 2 ? 0 : 1) + (y < height / 2 ? 0 : 2)]!;
  });
}

/** A scene that shows the frame number in huge digits, for telling which frame of a clip is on screen. */
export const COUNTER_SCENE = `import React from "react";
import { useCurrentFrame } from "remotion";
import { Background } from "@pipeline/lib";

export default function Scene() {
  const frame = useCurrentFrame();
  return (
    <>
      <Background />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 420, fontWeight: 800, color: "white", fontFamily: "sans-serif" }}>
        {frame}
      </div>
    </>
  );
}
`;

/** The colour of one pixel of one frame of a video or image, by decoding that frame with ffmpeg. */
export async function pixelAt(
  ffmpeg: (args: string[]) => Promise<unknown>,
  file: string,
  size: { width: number; height: number },
  at: { x: number; y: number; sec?: number },
): Promise<[number, number, number]> {
  const out = `${file}.${Math.round((at.sec ?? 0) * 1000)}.rgb`;
  await ffmpeg(["-y", ...(at.sec !== undefined ? ["-ss", at.sec.toFixed(3)] : []), "-i", file, "-frames:v", "1", "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "image2", out]);
  const raw = fs.readFileSync(out);
  fs.rmSync(out);
  const o = (Math.round(at.y * (size.height - 1)) * size.width + Math.round(at.x * (size.width - 1))) * 3;
  return [raw[o]!, raw[o + 1]!, raw[o + 2]!];
}

/** Which of the test card's quarters a colour belongs to, or "other". */
export function quarterOf([r, g, b]: [number, number, number]): "red" | "green" | "blue" | "yellow" | "other" {
  const near = (c: [number, number, number]) => Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]) < 90;
  if (near([200, 60, 60])) return "red";
  if (near([60, 160, 80])) return "green";
  if (near([60, 90, 200])) return "blue";
  if (near([220, 180, 50])) return "yellow";
  return "other";
}

/** Every pixel of an image or of one frame of a video, as RGB triples in a flat buffer. */
export async function rawPixels(ffmpeg: (args: string[]) => Promise<unknown>, file: string, sec?: number): Promise<Buffer> {
  const out = `${file}.${Math.round((sec ?? 0) * 1000)}.all.rgb`;
  await ffmpeg(["-y", ...(sec !== undefined ? ["-ss", sec.toFixed(3)] : []), "-i", file, "-frames:v", "1", "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "image2", out]);
  const raw = fs.readFileSync(out);
  fs.rmSync(out);
  return raw;
}

/** How many pixels of a picture pass a test, as a fraction of the picture. */
export async function shareOfPixels(ffmpeg: (args: string[]) => Promise<unknown>, file: string, test: (r: number, g: number, b: number) => boolean, sec?: number): Promise<number> {
  const raw = await rawPixels(ffmpeg, file, sec);
  let hits = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) if (test(raw[i]!, raw[i + 1]!, raw[i + 2]!)) hits++;
  return hits / (raw.length / 3);
}

/**
 * A video made of plain-coloured shots with hard cuts between them, and a white bar that
 * slides across each one so the picture is never quite still. For telling shots apart.
 */
export async function writeShotsVideo(
  ffmpeg: (args: string[]) => Promise<unknown>,
  file: string,
  shots: { colour: [number, number, number]; sec: number }[],
  opts: { width?: number; height?: number; fps?: number } = {},
) {
  const { width = 320, height = 180, fps = 30 } = opts;
  const dir = `${file}.frames`;
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const shot of shots) {
    const frames = Math.round(shot.sec * fps);
    for (let f = 0; f < frames; f++) {
      const x0 = Math.round((f / frames) * (width - 40));
      writePng(`${dir}/f${String(n++).padStart(5, "0")}.png`, width, height, (x, y) => (y >= height / 3 && y < (2 * height) / 3 && x >= x0 && x < x0 + 20 ? [255, 255, 255] : shot.colour));
    }
  }
  await ffmpeg(["-y", "-framerate", String(fps), "-i", `${dir}/f%05d.png`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** The size a PNG file says it has. */
export function pngSize(file: string): { width: number; height: number } {
  const head = fs.readFileSync(file).subarray(0, 24);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}
