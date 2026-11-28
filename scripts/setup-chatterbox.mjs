#!/usr/bin/env node
// Sets up Chatterbox, the second voice cloning engine, in its own environment (.venv-chatterbox),
// because it pins library versions that differ from Kokoro's. The download is large: PyTorch
// and about 2 GB of models.
//
//   npm run setup:chatterbox
//   npm run setup:chatterbox -- --gpu                       # with an NVIDIA card: much faster narration
//   npm run setup:chatterbox -- --python "C:\Python311\python.exe"

import { mkdirSync, readdirSync } from "node:fs";
import { existsSync, fail, findPython, path, pythonVersion, root, run, speak, venvPython } from "./voice-env.mjs";

const python = venvPython(".venv-chatterbox");
if (existsSync(python) && pythonVersion(python)) {
  console.log(`Using existing environment in ${path.dirname(path.dirname(python))}`);
} else {
  const py = findPython([11, 12, 10], "Chatterbox");
  console.log(`Using Python ${py.version}: ${[py.cmd, ...py.args].join(" ")}`);
  run(py.cmd, [...py.args, "-m", "venv", path.join(root, ".venv-chatterbox")]);
}

run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
const gpu = process.argv.includes("--gpu");
if (gpu || process.platform === "linux") {
  // Chatterbox pins PyTorch 2.6.0. Pick its build first: the NVIDIA one when asked, and on Linux
  // otherwise the CPU one, because the default Linux download carries multi-GB GPU libraries.
  const index = `https://download.pytorch.org/whl/${gpu ? "cu124" : "cpu"}`;
  const ok = run(python, ["-m", "pip", "install", "torch==2.6.0", "torchaudio==2.6.0", "--index-url", index], { optional: true });
  if (!ok && gpu) fail("The NVIDIA build of PyTorch could not be installed. Run it again without --gpu to use the processor instead.");
}
run(python, ["-m", "pip", "install", "-r", path.join(root, "python", "chatterbox", "requirements.txt")]);

console.log("\nDownloading the Chatterbox models and making a test clip (this takes a while the first time)...");
const outDir = path.join(root, "voice-auditions");
mkdirSync(outDir, { recursive: true });
// Any clip of a voice will do as the reference: one that an earlier setup left behind.
const reference = ["clone-test-reference.wav", "setup-test.wav"].map((f) => path.join(outDir, f)).find((f) => existsSync(f)) ?? readdirSync(outDir).filter((f) => f.endsWith(".wav")).map((f) => path.join(outDir, f))[0];
if (!reference) {
  run(python, ["-c", "from chatterbox.tts import ChatterboxTTS; ChatterboxTTS.from_pretrained(device='cpu'); print('Chatterbox loads.')"]);
  console.log("\nDone. Chatterbox is installed. There was no voice clip to test it with, so listen to a sample in the studio.");
} else {
  const outFile = path.join(outDir, "chatterbox-test.wav");
  const ok = speak(python, ["chatterbox", "chatterbox_tts.py"], {
    sampleRate: 24000,
    items: [{ id: "test", text: "Chatterbox is set up and ready for the video studio.", voice: "", lang: "a", speed: 1.0, padBeforeSec: 0, padAfterSec: 0, outFile, clone: { engine: "chatterbox", referenceFile: reference } }],
  });
  if (!ok) fail("Chatterbox is installed but the test clip failed (see the messages above).");
  console.log(`\nDone. Chatterbox works. The test clip should sound like the voice in ${reference}:\n  ${outFile}`);
}
console.log(`Restart the studio, then choose "(Chatterbox)" next to your voice under Plan → Voice.`);
