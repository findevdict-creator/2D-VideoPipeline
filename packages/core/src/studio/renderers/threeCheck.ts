/**
 * Extra source rules for 3D scenes. A 3D scene must draw the same picture for the same
 * frame, on any machine, with no network: so nothing that runs on a clock, nothing
 * random, and nothing that fetches files by itself.
 */

/** drei components that draw from their props alone. Everything else in drei is refused. */
export const DREI_ALLOWED = [
  // shapes
  "Box", "Sphere", "Cylinder", "Cone", "Torus", "TorusKnot", "Plane", "Circle", "Ring", "Capsule", "RoundedBox",
  "Tetrahedron", "Octahedron", "Dodecahedron", "Icosahedron", "Tube", "Extrude", "Lathe", "Shape",
  // lines and outlines
  "Line", "QuadraticBezierLine", "CubicBezierLine", "CatmullRomLine", "Edges", "Outlines", "Wireframe",
  // arranging
  "Center", "Billboard", "Instances", "Instance", "Merged",
  // surfaces and shadows
  "ContactShadows", "GradientTexture", "Grid", "Backdrop", "Decal", "MeshTransmissionMaterial",
];

const FIBER_REFUSED: Record<string, string> = {
  useFrame: "useFrame runs on a clock, so renders differ. Compute positions and rotations from useCurrentFrame() and pass them as props.",
  Canvas: "Use <Scene3D> from \"@pipeline/lib/three\" instead of <Canvas>. It sizes the canvas, renders frame by frame and passes the theme and cues in.",
  useLoader: "Files are loaded through the library: <Model asset=\"...\"> for a 3D model, useAssetTexture(\"...\") for an image.",
};

/** The names a file imports from a module, as written before any "as". Namespace and default imports come back as "*". */
export function importedNames(code: string, module: string): string[] {
  const names: string[] = [];
  const quoted = module.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pattern = new RegExp(`import\\s+(?:type\\s+)?([^;"'\`]*?)\\s+from\\s*["']${quoted}["']`, "g");
  for (const match of code.matchAll(pattern)) {
    const clause = match[1]!;
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1]!.split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
        if (name) names.push(name);
      }
    }
    if (/\*\s*as\s+\w+/.test(clause) || /^\s*\w+\s*(,|$)/.test(clause.replace(/\{[^}]*\}/, ""))) names.push("*");
  }
  return names;
}

export function checkThreeSource(code: string): string[] {
  const problems: string[] = [];
  if (!/<Scene3D[\s>]/.test(code)) {
    problems.push('A 3D scene draws inside <Scene3D camera={...}> from "@pipeline/lib/three". This file has no <Scene3D>.');
  }

  for (const name of importedNames(code, "@react-three/fiber")) {
    if (name === "*") problems.push('Import what you need from "@react-three/fiber" by name, so the checker can see it.');
    else if (FIBER_REFUSED[name]) problems.push(FIBER_REFUSED[name]!);
  }

  const drei = importedNames(code, "@react-three/drei");
  if (drei.includes("*")) problems.push('Import what you need from "@react-three/drei" by name, so the checker can see it.');
  const refused = drei.filter((n) => n !== "*" && !DREI_ALLOWED.includes(n));
  if (refused.length) {
    problems.push(
      `${refused.join(", ")} from "@react-three/drei" ${refused.length > 1 ? "are" : "is"} not available here: drei's helpers that animate by themselves, respond to the mouse, or load files from the internet do not render reliably. Available: ${DREI_ALLOWED.join(", ")}.`,
    );
  }

  if (/\bnew\s+(?:THREE\.)?Clock\b|\.clock\b|\bgetElapsedTime\s*\(|\bgetDelta\s*\(/.test(code)) {
    problems.push("three.js clocks make every render different. Derive time from useCurrentFrame() and the video's fps.");
  }
  if (/\bMathUtils\.(?:randFloat|randFloatSpread|randInt|generateUUID)\s*\(|\bMathUtils\.seededRandom\s*\(\s*\)/.test(code)) {
    problems.push('three.js random helpers make every render different. Use random("some-seed") from "remotion".');
  }
  if (/\b(?:TextureLoader|GLTFLoader|FBXLoader|OBJLoader|FontLoader|RGBELoader|EXRLoader|CubeTextureLoader|FileLoader|ImageLoader)\b/.test(code)) {
    problems.push('Files are loaded through the library, not with three.js loaders: <Model asset="..."> for a 3D model, useAssetTexture("...") for an image.');
  }
  return problems;
}
