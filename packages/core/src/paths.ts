import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: the folder that holds packages/, python/ and node_modules/. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The Remotion library that scenes import as "@pipeline/lib". */
export const LIB_DIR = path.join(REPO_ROOT, "packages", "lib");
export const LIB_INDEX = path.join(LIB_DIR, "src", "index.ts");
/** The 3D half of the library, imported as "@pipeline/lib/three". */
export const LIB_THREE = path.join(LIB_DIR, "src", "three", "index.ts");
export const LIB_README = path.join(LIB_DIR, "README.md");
/** How to lay out a scene so it looks designed: read by every run that draws. */
export const DESIGN_GUIDE = path.join(LIB_DIR, "guides", "scene-design.md");
/** How to design a thumbnail that gets clicked: read by thumbnail runs. */
export const THUMBNAIL_GUIDE = path.join(LIB_DIR, "guides", "thumbnail-design.md");
export const LIB_README_3D = path.join(LIB_DIR, "README-3D.md");
export const LIB_EXAMPLE_3D = path.join(LIB_DIR, "examples", "ExampleScene3D.tsx");
export const LIB_EXAMPLE = path.join(LIB_DIR, "examples", "ExampleScene.tsx");
export const LIB_TSCONFIG = path.join(LIB_DIR, "tsconfig.json");

/** Python helpers: Kokoro text-to-speech, and what Manim scenes build on. */
export const PYTHON_DIR = path.join(REPO_ROOT, "python");
export const MANIM_DIR = path.join(PYTHON_DIR, "manim");
export const MANIM_README = path.join(MANIM_DIR, "README.md");
export const MANIM_EXAMPLE = path.join(MANIM_DIR, "example_scene.py");
