#!/usr/bin/env node
// Sets up Manim for scenes of type "manim":
// finds Python 3.11 or later, creates .venv-manim/, installs Manim, and draws a test scene.
//
//   npm run setup:manim
//   npm run setup:manim -- --python "C:\Python312\python.exe"
//
// Equations are typeset with LaTeX when it is installed. Without it they are shown as
// plain text, and everything else works.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const venv = path.join(root, ".venv-manim");
const venvPython = windows ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
const manimDir = path.join(root, "python", "manim");

function fail(message) {
  console.error(`\nSetup failed: ${message}`);
  process.exit(1);
}

function run(cmd, args, onFail) {
  console.log(`> ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root });
  if (r.status !== 0) fail(onFail ?? `Command failed: ${cmd} ${args.join(" ")}`);
}

function pythonVersion(cmd, args) {
  const r = spawnSync(cmd, [...args, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return undefined;
  const [major, minor] = r.stdout.trim().split(".").map(Number);
  return { major, minor, text: r.stdout.trim() };
}

function findPython() {
  const flag = process.argv.indexOf("--python");
  const candidates =
    flag > 0
      ? [[process.argv[flag + 1], []]]
      : windows
        ? [["py", ["-3.12"]], ["py", ["-3.13"]], ["py", ["-3.11"]], ["python", []], ["python3", []]]
        : [["python3.12", []], ["python3.13", []], ["python3.11", []], ["python3", []], ["python", []]];
  const tried = [];
  for (const [cmd, args] of candidates) {
    const v = pythonVersion(cmd, args);
    if (!v) continue;
    tried.push(`${[cmd, ...args].join(" ")} (${v.text})`);
    if (v.major === 3 && v.minor >= 11) return { cmd, args, version: v.text };
  }
  fail(
    `Manim needs Python 3.11 or later. ` +
      (tried.length ? `Found only: ${tried.join(", ")}. ` : "No Python found. ") +
      `Install Python 3.12 from https://www.python.org/downloads/ and run this again, or pass --python <path-to-python>.`,
  );
}

if (existsSync(venvPython) && pythonVersion(venvPython, [])) {
  console.log(`Using existing environment in ${venv}`);
} else {
  const py = findPython();
  console.log(`Using Python ${py.version}: ${[py.cmd, ...py.args].join(" ")}`);
  run(py.cmd, [...py.args, "-m", "venv", venv]);
}

run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
run(
  venvPython,
  ["-m", "pip", "install", "-r", path.join(manimDir, "requirements.txt")],
  process.platform === "linux"
    ? "Manim could not be installed (see the messages above). On Linux its text drawing is built from source and needs a compiler and Pango's development files. Install them and run this again, for example:\n" +
        "  sudo apt install build-essential python3-dev pkg-config libcairo2-dev libpango1.0-dev"
    : process.platform === "darwin"
      ? "Manim could not be installed (see the messages above). If the error mentions cairo or pango, install them and run this again: brew install cairo pango pkg-config"
      : "Manim could not be installed (see the messages above).",
);

console.log("\nDrawing a test scene...");
const work = mkdtempSync(path.join(os.tmpdir(), "manim-setup-"));
const output = path.join(venv, "setup-test.mp4");
const dataFile = path.join(work, "data.json");
writeFileSync(
  dataFile,
  JSON.stringify({
    fps: 30,
    width: 1920,
    height: 1080,
    durationSec: 8,
    captionSafeArea: 0,
    style: {
      palette: { background: "#0F172A", surface: "#1E293B", primary: "#38BDF8", secondary: "#A78BFA", accent: "#FBBF24", text: "#F8FAFC" },
      fontFamily: "Inter",
    },
    cues: [
      { id: "triangle", startSec: 0.4, endSec: 1 },
      { id: "squares", startSec: 2.4, endSec: 3 },
      { id: "area", startSec: 5, endSec: 5.5 },
    ],
  }),
);
const job = { mode: "render", source: path.join(manimDir, "example_scene.py"), data: dataFile, mediaDir: path.join(work, "media"), output, width: 960, height: 540 };
const test = spawnSync(venvPython, [path.join(manimDir, "studio_manim.py")], { input: JSON.stringify(job), encoding: "utf8", cwd: work, stdio: ["pipe", "pipe", "inherit"] });
const line = (test.stdout ?? "").split(/\r?\n/).reverse().find((l) => l.startsWith("STUDIO_RESULT "));
let result;
try {
  result = JSON.parse(line.slice("STUDIO_RESULT ".length));
} catch {
  result = undefined;
}
rmSync(work, { recursive: true, force: true });
if (!result?.ok) {
  fail(`Manim is installed but the test scene failed:\n${(result?.problems ?? [test.stdout?.slice(-600) ?? "no output"]).join("\n")}`);
}

console.log(`\nDone. Manim works. Watch the test scene: ${output}`);
for (const warning of result.warnings ?? []) console.log(`Note: ${warning}`);
if (!result.latex) {
  console.log(
    "\nLaTeX is not installed, so equations are shown as plain text (a² + b² = c² instead of typeset maths).\n" +
      "To have them typeset, install LaTeX and start the studio again:\n" +
      (windows
        ? "  MiKTeX: https://miktex.org/download"
        : process.platform === "darwin"
          ? "  brew install --cask mactex-no-gui"
          : "  sudo apt install texlive texlive-latex-extra dvisvgm"),
  );
}
