#!/usr/bin/env node
// Adds voice cloning to the Kokoro environment that `npm run setup:voice` made:
// installs the Kanade voice-conversion model that KokoClone pairs with Kokoro, and makes a
// test clip (the first run downloads about 1 GB of models).
//
//   npm run setup:clone

import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { existsSync, fail, path, pythonVersion, root, run, speak, venvPython } from "./voice-env.mjs";

const python = venvPython(".venv-voice");
if (!existsSync(python)) fail("Kokoro is not set up yet. Run this first: npm run setup:voice");
const v = pythonVersion(python);
if (!v || v.major !== 3 || v.minor !== 12) {
  fail(
    `Voice cloning needs Python 3.12, and the voice environment was made with Python ${v?.text ?? "that does not start"}. ` +
      `Delete the .venv-voice folder, install Python 3.12 from https://www.python.org/downloads/, then run: npm run setup:voice   and after it: npm run setup:clone`,
  );
}

// torchaudio has to be the build that matches the PyTorch Kokoro already uses, or pip replaces PyTorch.
const torch = spawnSync(python, ["-c", "import torch; print(torch.__version__)"], { encoding: "utf8" });
if (torch.status !== 0) fail("PyTorch is missing from the voice environment. Run: npm run setup:voice");
const [version, build] = torch.stdout.trim().split("+");
const index = build ? ["--index-url", `https://download.pytorch.org/whl/${build}`] : [];
if (!run(python, ["-m", "pip", "install", `torchaudio==${version}`, ...index], { optional: true })) {
  run(python, ["-m", "pip", "install", `torchaudio==${version}`]);
}
run(python, ["-m", "pip", "install", "-r", path.join(root, "python", "kokoro", "requirements-clone.txt")]);

console.log("\nMaking a test clip (the first run downloads the voice cloning models)...");
const outDir = path.join(root, "voice-auditions");
mkdirSync(outDir, { recursive: true });
const reference = path.join(outDir, "clone-test-reference.wav");
const outFile = path.join(outDir, "clone-test.wav");
const item = { lang: "a", speed: 1.0, padBeforeSec: 0, padAfterSec: 0 };
const ok =
  // One Kokoro voice stands in for yours: George's voice is the clip, and Heart's speech is re-voiced as him.
  speak(python, ["kokoro", "kokoro_tts.py"], {
    sampleRate: 24000,
    items: [{ ...item, id: "reference", voice: "bm_george", lang: "b", text: "This is a reference recording. It only needs to be long enough to carry the sound of one voice, so here are a few more words to fill it out.", outFile: reference }],
  }) &&
  speak(python, ["kokoro", "kokoro_tts.py"], {
    sampleRate: 24000,
    items: [{ ...item, id: "test", voice: "af_heart", text: "Voice cloning is set up and ready for the video studio.", outFile, clone: { engine: "kokoclone", referenceFile: reference } }],
  });
if (!ok) fail("Voice cloning is installed but the test clip failed (see the messages above).");

console.log(`\nDone. Voice cloning works. The test clip should sound like the British man in ${reference}, not like the woman who spoke it:\n  ${outFile}`);
console.log(`Restart the studio, then open a project: Plan → Voice → Clone my voice.`);
