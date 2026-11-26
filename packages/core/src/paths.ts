import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: the folder that holds packages/, python/ and node_modules/. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The Remotion library that scenes import as "@pipeline/lib". */
export const LIB_DIR = path.join(REPO_ROOT, "packages", "lib");
export const LIB_INDEX = path.join(LIB_DIR, "src", "index.ts");
export const LIB_README = path.join(LIB_DIR, "README.md");
export const LIB_EXAMPLE = path.join(LIB_DIR, "examples", "ExampleScene.tsx");
export const LIB_TSCONFIG = path.join(LIB_DIR, "tsconfig.json");

/** Python helpers: Kokoro text-to-speech, and later the Manim helper. */
export const PYTHON_DIR = path.join(REPO_ROOT, "python");
