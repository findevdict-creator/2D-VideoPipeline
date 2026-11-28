#!/usr/bin/env node
// Adds voice cloning to the Kokoro environment that `npm run setup:voice` made:
// installs the Kanade voice-conversion model that KokoClone pairs with Kokoro, and makes a
// test clip (the first run downloads about 1 GB of models).
//
//   npm run setup:clone

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { existsSync, fail, path, pythonVersion, root, run, speak, venvPython } from "./voice-env.mjs";

const python = venvPython(".venv-voice");
if (!existsSync(python)) fail("Kokoro is not set up yet. Run this first: npm run setup:voice");
const v = pythonVersion(python);
if (!v || v.major !== 3 || v.minor < 10 || v.minor > 12) fail(`The voice environment's Python (${v?.text ?? "it does not start"}) is not 3.10, 3.11 or 3.12. Run: npm run setup:voice`);

// Kanade, MIT licence, at the commit the studio was written against.
const KANADE = "kanade-tokenizer @ https://github.com/frothywater/kanade-tokenizer/archive/961f20bf892c59f391d0b6c5f7b88e70ed919b99.zip";

// Nothing installed here may replace the PyTorch that Kokoro already uses, so every install below is
// held to it. torchaudio is then whichever release goes with that PyTorch: the same number for older
// ones, and for newer ones the latest, since torchaudio stopped following PyTorch's numbers.
const torch = spawnSync(python, ["-c", "import torch; print(torch.__version__)"], { encoding: "utf8" });
if (torch.status !== 0) fail("PyTorch is missing from the voice environment. Run: npm run setup:voice");
const installed = torch.stdout.trim();
const build = installed.split("+")[1];
const keep = path.join(mkdtempSync(path.join(os.tmpdir(), "studio-clone-")), "keep-torch.txt");
writeFileSync(keep, `torch==${installed}\n`);
// A build such as "+cpu" comes from PyTorch's own index, so pip is given that one as well as the usual one.
const held = ["-c", keep, ...(build ? ["--extra-index-url", `https://download.pytorch.org/whl/${build}`] : [])];
if (!run(python, ["-m", "pip", "install", `torchaudio==${installed.split("+")[0]}`, ...held], { optional: true })) {
  console.log("There is no torchaudio with that number, so the newest one that accepts this PyTorch is installed instead.");
  run(python, ["-m", "pip", "install", "torchaudio", ...held]);
}
run(python, ["-m", "pip", "install", "-r", path.join(root, "python", "kokoro", "requirements-clone.txt"), ...held]);
// Kanade's package says Python 3.12, but its code runs on the Python Kokoro already has here. Its own
// requirements were installed above the normal way, so only this one package skips the version check.
run(python, ["-m", "pip", "install", "--no-deps", ...(v.minor < 12 ? ["--ignore-requires-python"] : []), KANADE]);

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
