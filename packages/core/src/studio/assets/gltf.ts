import fs from "node:fs";

/**
 * Reads a glTF model (.glb, or .gltf with its data inside) without loading it into a 3D
 * engine: what parts it has, how heavy it is, which animations it carries, and anything
 * that would stop it from loading in a scene.
 */

export interface ModelPart {
  /** The name given in Blender. Scenes move, hide and recolour parts by this name. */
  name: string;
  /** The part this one is inside, or null for a top-level part. */
  parent: string | null;
  triangles: number;
  /** Where the part's origin is, in the model's own units. */
  position: [number, number, number];
}

export interface ModelAnimation {
  name: string;
  durationSec: number;
  /** The parts it moves. */
  parts: string[];
}

export interface ModelInfo {
  format: "glb" | "gltf";
  generator: string;
  parts: ModelPart[];
  triangles: number;
  materials: string[];
  textureBytes: number;
  animations: ModelAnimation[];
  /** The box the whole model fits in, in its own units. */
  size: [number, number, number];
  center: [number, number, number];
  /** Things worth fixing in Blender. The model still works. */
  warnings: string[];
  /** Things that stop the model from loading. */
  errors: string[];
}

type Mat4 = number[];
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major 4x4 multiply, as glTF stores matrices. */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function compose(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q as [number, number, number, number];
  const [sx, sy, sz] = s as [number, number, number];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ];
}

const transform = (m: Mat4, p: [number, number, number]): [number, number, number] => [
  m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
  m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
  m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
];

/** Names Blender and other tools give a part nobody named. */
const DEFAULT_NAME = /^(cube|sphere|icosphere|cylinder|cone|torus|plane|circle|grid|suzanne|mesh|object|node|empty|group|curve|bezier\w*|nurbs\w*|text)?([._ -]?\d+)*$/i;

const round = (n: number) => Math.round(n * 1000) / 1000;

interface Gltf {
  asset?: { generator?: string; version?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; camera?: number; extensions?: Record<string, unknown> }[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; mode?: number; material?: number }[] }[];
  accessors?: { count: number; min?: number[]; max?: number[] }[];
  materials?: { name?: string }[];
  images?: { uri?: string; bufferView?: number }[];
  bufferViews?: { byteLength: number }[];
  buffers?: { uri?: string; byteLength: number }[];
  animations?: { name?: string; channels: { sampler: number; target: { node?: number } }[]; samplers: { input: number }[] }[];
  cameras?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

function readJson(file: string): { json: Gltf; format: "glb" | "gltf" } {
  const bytes = fs.readFileSync(file);
  if (bytes.length >= 20 && bytes.readUInt32LE(0) === 0x46546c67) {
    const version = bytes.readUInt32LE(4);
    if (version !== 2) throw new Error(`This is a glTF version ${version} file. The studio reads version 2; export it again from a current Blender.`);
    const length = bytes.readUInt32LE(12);
    if (bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error("The .glb file is damaged: its first chunk is not the model description.");
    return { json: JSON.parse(bytes.subarray(20, 20 + length).toString("utf8")), format: "glb" };
  }
  try {
    return { json: JSON.parse(bytes.toString("utf8")), format: "gltf" };
  } catch {
    throw new Error("The file is not a glTF model. In Blender, use File > Export > glTF 2.0 and choose the .glb format.");
  }
}

export function inspectModel(file: string, opts: { triangleBudget?: number } = {}): ModelInfo {
  const budget = opts.triangleBudget ?? 300_000;
  const { json, format } = readJson(file);
  const warnings: string[] = [];
  const errors: string[] = [];
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const accessors = json.accessors ?? [];

  const extensions = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);
  if (extensions.has("KHR_draco_mesh_compression") || extensions.has("EXT_meshopt_compression")) {
    errors.push("The model is compressed (Draco or Meshopt), which the studio does not load. In Blender's glTF export, turn off Compression under Data > Mesh, and export again.");
  }
  if (extensions.has("KHR_texture_basisu")) {
    errors.push("The model's textures are in KTX2 format, which the studio does not load. Export with PNG or JPEG textures.");
  }
  const external = [...(json.buffers ?? []), ...(json.images ?? [])].filter((b) => b.uri && !b.uri.startsWith("data:"));
  if (external.length) {
    errors.push(`The model keeps ${external.length} of its files separately (${external.slice(0, 3).map((e) => e.uri).join(", ")}). Export it as a single .glb file instead: in Blender's glTF export, choose Format > glTF Binary (.glb).`);
  }
  if (!meshes.length) errors.push("The model has no meshes, so there is nothing to draw. Check that the objects were selected or visible when you exported.");

  const trianglesOf = (meshIndex: number) =>
    (meshes[meshIndex]?.primitives ?? []).reduce((sum, p) => {
      if (p.mode !== undefined && p.mode !== 4) return sum;
      const count = p.indices !== undefined ? accessors[p.indices]?.count : accessors[p.attributes.POSITION ?? -1]?.count;
      return sum + Math.floor((count ?? 0) / 3);
    }, 0);

  // Walk the scene from its roots, so every part knows its parent and where it ends up.
  const parts: ModelPart[] = [];
  const names = new Map<number, string>();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  let unnamed = 0;
  const seen = new Set<number>();
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter((i) => !nodes.some((n) => n.children?.includes(i)));
  const walk = (index: number, parentMatrix: Mat4, parent: string | null) => {
    const node = nodes[index];
    if (!node || seen.has(index)) return;
    seen.add(index);
    const world = multiply(parentMatrix, node.matrix ?? compose(node.translation, node.rotation, node.scale));
    const name = node.name?.trim() ?? "";
    let own = 0;
    if (node.mesh !== undefined) {
      own = trianglesOf(node.mesh);
      triangles += own;
      for (const primitive of meshes[node.mesh]?.primitives ?? []) {
        const box = accessors[primitive.attributes.POSITION ?? -1];
        if (!box?.min || !box.max) continue;
        for (const x of [box.min[0]!, box.max[0]!]) {
          for (const y of [box.min[1]!, box.max[1]!]) {
            for (const z of [box.min[2]!, box.max[2]!]) {
              const p = transform(world, [x, y, z]);
              for (let i = 0; i < 3; i++) {
                min[i] = Math.min(min[i]!, p[i]!);
                max[i] = Math.max(max[i]!, p[i]!);
              }
            }
          }
        }
      }
    }
    const isCameraOrLight = node.camera !== undefined || node.extensions?.KHR_lights_punctual !== undefined;
    if (name && !isCameraOrLight) {
      if (DEFAULT_NAME.test(name) && node.mesh !== undefined) unnamed++;
      names.set(index, name);
      parts.push({ name, parent, triangles: own, position: [round(world[12]!), round(world[13]!), round(world[14]!)] });
    } else if (!name && node.mesh !== undefined) {
      unnamed++;
    }
    for (const child of node.children ?? []) walk(child, world, name || parent);
  };
  for (const root of roots) walk(root, IDENTITY, null);

  const duplicate = parts.map((p) => p.name).filter((n, i, all) => all.indexOf(n) !== i);
  if (duplicate.length) warnings.push(`${[...new Set(duplicate)].join(", ")}: more than one part has this name, so a scene cannot tell them apart. Give each part its own name.`);
  if (unnamed) {
    warnings.push(
      `${unnamed} part${unnamed > 1 ? "s have" : " has"} no name of ${unnamed > 1 ? "their" : "its"} own (Blender's defaults such as Cube.001). Scenes move, hide and point at parts by name, so name the ones that matter in Blender's outliner and export again.`,
    );
  }
  if (triangles > budget) {
    warnings.push(
      `The model has ${triangles.toLocaleString("en-US")} triangles, over the ${budget.toLocaleString("en-US")} that render comfortably. Scenes with it will render slowly. In Blender, add a Decimate modifier or leave out detail the camera never sees.`,
    );
  }

  const size: [number, number, number] = Number.isFinite(min[0]) ? [round(max[0] - min[0]), round(max[1] - min[1]), round(max[2] - min[2])] : [0, 0, 0];
  const center: [number, number, number] = Number.isFinite(min[0]) ? [round((max[0] + min[0]) / 2), round((max[1] + min[1]) / 2), round((max[2] + min[2]) / 2)] : [0, 0, 0];

  const textureBytes = (json.images ?? []).reduce((sum, image) => sum + (image.bufferView !== undefined ? (json.bufferViews?.[image.bufferView]?.byteLength ?? 0) : 0), 0);
  if (textureBytes > 40 * 1024 * 1024) {
    warnings.push(`The model's textures take ${Math.round(textureBytes / 1024 / 1024)} MB. Scenes will be slow to start. Export with smaller textures; 2048 pixels is plenty for video.`);
  }

  const animations: ModelAnimation[] = (json.animations ?? []).map((a, i) => ({
    name: a.name?.trim() || `Animation ${i + 1}`,
    durationSec: round(Math.max(0, ...a.samplers.map((s) => accessors[s.input]?.max?.[0] ?? 0))),
    parts: [...new Set(a.channels.map((c) => (c.target.node !== undefined ? names.get(c.target.node) : undefined)).filter((n): n is string => Boolean(n)))],
  }));
  const lights = nodes.filter((n) => n.camera !== undefined || n.extensions?.KHR_lights_punctual !== undefined).length;
  if (lights) warnings.push(`The file carries ${lights} camera${lights > 1 ? "s and lights" : " or light"} from Blender. Scenes set up their own, so these are left out.`);

  return {
    format,
    generator: json.asset?.generator ?? "",
    parts,
    triangles,
    materials: (json.materials ?? []).map((m, i) => m.name?.trim() || `Material ${i + 1}`),
    textureBytes,
    animations,
    size,
    center,
    warnings,
    errors,
  };
}
