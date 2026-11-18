#!/usr/bin/env node
// Sets up Kokoro text-to-speech for the voiceover stage:
// finds Python 3.10-3.12, creates .venv-voice/, installs Kokoro, and makes a test clip
// (the first run downloads the Kokoro model, about 330 MB).
//
//   npm run setup:voice
//   npm run setup:voice -- --python "C:\Python312\python.exe"

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const venv = path.join(root, ".venv-voice");
const venvPython = windows ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");

function run(cmd, args, opts = {}) {
  console.log(`> ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) fail(`Command failed: ${cmd} ${args.join(" ")}`);
}

function fail(message) {
  console.error(`\nSetup failed: ${message}`);
  process.exit(1);
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
        ? [["py", ["-3.12"]], ["py", ["-3.11"]], ["py", ["-3.10"]], ["python", []], ["python3", []]]
        : [["python3.12", []], ["python3.11", []], ["python3.10", []], ["python3", []], ["python", []]];
  const tried = [];
  for (const [cmd, args] of candidates) {
    const v = pythonVersion(cmd, args);
    if (!v) continue;
    tried.push(`${[cmd, ...args].join(" ")} (${v.text})`);
    if (v.major === 3 && v.minor >= 10 && v.minor <= 12) return { cmd, args, version: v.text };
  }
  fail(
    `Kokoro needs Python 3.10, 3.11 or 3.12. ` +
      (tried.length ? `Found only: ${tried.join(", ")}. ` : "No Python found. ") +
      `Install Python 3.12 from https://www.python.org/downloads/ and run this again, ` +
      `or pass --python <path-to-python>.`,
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
if (process.platform === "linux") {
  // On Linux the default PyTorch download includes multi-GB GPU libraries. Kokoro runs fine on CPU,
  // so try the CPU-only build first, and fall back to the default one if that index is unreachable.
  const args = ["-m", "pip", "install", "torch", "--index-url", "https://download.pytorch.org/whl/cpu"];
  console.log(`> ${venvPython} ${args.join(" ")}`);
  const cpu = spawnSync(venvPython, args, { stdio: "inherit", cwd: root });
  if (cpu.status !== 0) console.log("CPU-only PyTorch was not available; installing the default build instead.");
}
run(venvPython, ["-m", "pip", "install", "-r", path.join(root, "voice", "requirements.txt")]);

console.log("\nMaking a test clip (the first run downloads the Kokoro model)...");
const outDir = path.join(root, "voice-auditions");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "setup-test.wav");
const job = {
  sampleRate: 24000,
  items: [
    {
      id: "test",
      text: "Kokoro is set up and ready for the video pipeline.",
      voice: "af_heart",
      lang: "a",
      speed: 1.0,
      padBeforeSec: 0,
      padAfterSec: 0,
      outFile,
    },
  ],
};
const test = spawnSync(venvPython, [path.join(root, "voice", "kokoro_tts.py")], {
  input: JSON.stringify(job),
  encoding: "utf8",
  stdio: ["pipe", "pipe", "inherit"],
});
if (test.status !== 0) {
  fail(
    "Kokoro is installed but the test clip failed (see the messages above). " +
      (windows
        ? "On Windows, installing espeak-ng often fixes this: https://github.com/espeak-ng/espeak-ng/releases (the .msi installer)."
        : "If the error mentions espeak, install espeak-ng (for example: sudo apt install espeak-ng)."),
  );
}

console.log(`\nDone. Kokoro works. Listen to the test clip: ${outFile}`);
console.log(`Try other voices with: npm run pipeline -- voices`);
