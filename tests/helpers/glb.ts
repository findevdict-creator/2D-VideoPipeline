import fs from "node:fs";
import path from "node:path";

/**
 * Writes small glTF models for tests and examples, the way Blender exports them:
 * named parts in a hierarchy, a material per part, and an animation.
 */

export interface BoxPart {
  name: string;
  /** Width, height, depth. */
  size: [number, number, number];
  position: [number, number, number];
  color: [number, number, number];
  parent?: string;
  /** Repeat the faces to make the part heavier, for triangle-budget tests. */
  subdivide?: number;
}

export interface PartAnimation {
  name: string;
  part: string;
  /** Translation keyframes: seconds, then where the part is at that moment (in its parent's space). */
  keys: { sec: number; position: [number, number, number] }[];
}

function boxGeometry(size: [number, number, number], subdivide = 1) {
  const [w, h, d] = size.map((v) => v / 2) as [number, number, number];
  const faces: { normal: [number, number, number]; corners: [number, number, number][] }[] = [
    { normal: [0, 0, 1], corners: [[-w, -h, d], [w, -h, d], [w, h, d], [-w, h, d]] },
    { normal: [0, 0, -1], corners: [[w, -h, -d], [-w, -h, -d], [-w, h, -d], [w, h, -d]] },
    { normal: [1, 0, 0], corners: [[w, -h, d], [w, -h, -d], [w, h, -d], [w, h, d]] },
    { normal: [-1, 0, 0], corners: [[-w, -h, -d], [-w, -h, d], [-w, h, d], [-w, h, -d]] },
    { normal: [0, 1, 0], corners: [[-w, h, d], [w, h, d], [w, h, -d], [-w, h, -d]] },
    { normal: [0, -1, 0], corners: [[-w, -h, -d], [w, -h, -d], [w, -h, d], [-w, -h, d]] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i]! - v) * t);
  for (const face of faces) {
    const [a, b, c, e] = face.corners as unknown as [number[], number[], number[], number[]];
    // Each face is a grid of subdivide x subdivide quads.
    for (let i = 0; i < subdivide; i++) {
      for (let j = 0; j < subdivide; j++) {
        const base = positions.length / 3;
        for (const [u, v] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]] as const) {
          const bottom = mix(a, b, u / subdivide);
          const top = mix(e, c, u / subdivide);
          positions.push(...mix(bottom, top, v / subdivide));
          normals.push(...face.normal);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }
  return { positions, normals, indices, min: [-w, -h, -d], max: [w, h, d] };
}

/** Write a .glb made of boxes. Returns the file path. */
export function writeGlb(file: string, parts: BoxPart[], animations: PartAnimation[] = [], opts: { extensionsUsed?: string[]; generator?: string } = {}): string {
  const chunks: Buffer[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  let offset = 0;
  const add = (data: Buffer, view: Record<string, unknown>, accessor: Record<string, unknown>) => {
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...view });
    accessors.push({ bufferView: bufferViews.length - 1, ...accessor });
    chunks.push(padded);
    offset += padded.length;
    return accessors.length - 1;
  };
  const floats = (values: number[]) => Buffer.from(new Float32Array(values).buffer);

  const nodes: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const index = new Map<string, number>();
  parts.forEach((part, i) => {
    const g = boxGeometry(part.size, part.subdivide);
    const position = add(floats(g.positions), { target: 34962 }, { componentType: 5126, count: g.positions.length / 3, type: "VEC3", min: g.min, max: g.max });
    const normal = add(floats(g.normals), { target: 34962 }, { componentType: 5126, count: g.normals.length / 3, type: "VEC3" });
    const indices = add(Buffer.from(new Uint32Array(g.indices).buffer), { target: 34963 }, { componentType: 5125, count: g.indices.length, type: "SCALAR" });
    materials.push({ name: `${part.name}Material`, pbrMetallicRoughness: { baseColorFactor: [...part.color, 1], metallicFactor: 0, roughnessFactor: 0.7 } });
    meshes.push({ name: `${part.name}Mesh`, primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices, material: i }] });
    nodes.push({ name: part.name, mesh: i, translation: part.position });
    index.set(part.name, i);
  });
  parts.forEach((part, i) => {
    if (!part.parent) return;
    const parent = nodes[index.get(part.parent)!]!;
    parent.children = [...((parent.children as number[] | undefined) ?? []), i];
  });
  const roots = parts.map((p, i) => (p.parent ? -1 : i)).filter((i) => i >= 0);

  const gltfAnimations = animations.map((a) => {
    const input = add(floats(a.keys.map((k) => k.sec)), {}, { componentType: 5126, count: a.keys.length, type: "SCALAR", min: [a.keys[0]!.sec], max: [a.keys.at(-1)!.sec] });
    const output = add(floats(a.keys.flatMap((k) => k.position)), {}, { componentType: 5126, count: a.keys.length, type: "VEC3" });
    return { name: a.name, samplers: [{ input, output, interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: index.get(a.part)!, path: "translation" } }] };
  });

  const json: Record<string, unknown> = {
    asset: { version: "2.0", generator: opts.generator ?? "Scene Studio test model" },
    scene: 0,
    scenes: [{ name: "Scene", nodes: roots }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
    ...(gltfAnimations.length ? { animations: gltfAnimations } : {}),
    ...(opts.extensionsUsed ? { extensionsUsed: opts.extensionsUsed, extensionsRequired: opts.extensionsUsed } : {}),
  };
  let jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
  const chunkHeader = (length: number, type: number) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(length, 0);
    h.writeUInt32LE(type, 4);
    return h;
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, chunkHeader(jsonBytes.length, 0x4e4f534a), jsonBytes, chunkHeader(bin.length, 0x004e4942), bin]));
  return file;
}

/**
 * A toy camera: a body, a lens barrel in front, a back that can come off, and a shutter
 * inside that slides up. Colours are far apart so tests can tell the parts apart by pixel.
 */
export const CAMERA_PARTS: BoxPart[] = [
  { name: "Body", size: [2.4, 1.5, 1], position: [0, 0, 0], color: [0.15, 0.15, 0.18] },
  { name: "Lens", size: [0.9, 0.9, 0.8], position: [0, 0, 0.9], color: [0.1, 0.45, 0.9], parent: "Body" },
  { name: "Back", size: [2.4, 1.5, 0.12], position: [0, 0, -0.56], color: [0.85, 0.2, 0.2], parent: "Body" },
  { name: "Shutter", size: [0.8, 0.8, 0.06], position: [0, 0, -0.3], color: [0.95, 0.8, 0.1], parent: "Body" },
  { name: "Button", size: [0.3, 0.14, 0.3], position: [0.8, 0.82, 0], color: [0.9, 0.9, 0.9], parent: "Body" },
];

export const CAMERA_ANIMATIONS: PartAnimation[] = [
  { name: "ShutterOpen", part: "Shutter", keys: [{ sec: 0, position: [0, 0, -0.3] }, { sec: 0.5, position: [0, 0.9, -0.3] }, { sec: 1, position: [0, 0.9, -0.3] }] },
];

export const writeCameraGlb = (file: string) => writeGlb(file, CAMERA_PARTS, CAMERA_ANIMATIONS);
