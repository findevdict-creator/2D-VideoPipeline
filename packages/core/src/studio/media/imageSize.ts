import fs from "node:fs";

/**
 * Width and height of image formats the bundled ffprobe cannot read: WebP and SVG.
 * Returns undefined when the file is neither or its header is unusual.
 */
export function imageSize(file: string): { width: number; height: number } | undefined {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(4096);
  const read = fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  const buf = head.subarray(0, read);

  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const kind = buf.toString("ascii", 12, 16);
    if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return undefined;
  }

  const text = buf.toString("utf8");
  const svg = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (svg) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(svg)?.[1];
    const px = (value?: string) => (value && /^[\d.]+(px)?$/.test(value.trim()) ? parseFloat(value) : undefined);
    const box = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
    const width = px(attr("width")) ?? box?.[2];
    const height = px(attr("height")) ?? box?.[3];
    if (width && height) return { width: Math.round(width), height: Math.round(height) };
  }
  return undefined;
}
