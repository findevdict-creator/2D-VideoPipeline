import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../packages/core/src/config.js";
import { bitrateFor, encoderFor, forgetEncoder, hardwareEncoder, isEncoderFailure, isSoftwareDevice, nvencQuality, probeEncoder, withEncoderQuality } from "../packages/core/src/studio/renderers/gpu.js";
import { forgetGl, gpuFor2d, withGl } from "../packages/core/src/studio/renderers/remotion.js";
import { execFile } from "node:child_process";
import path from "node:path";
import { needsBrowser, REPO, tempStudio } from "./helpers/studio.js";

test("the graphics card setting defaults to auto and can be set from the environment", () => {
  assert.equal(loadConfig({ rootDir: REPO, runner: "mock" }).render.gpu, "auto");
  process.env.STUDIO_GPU = "off";
  try {
    assert.equal(loadConfig({ rootDir: REPO, runner: "mock" }).render.gpu, "off");
  } finally {
    delete process.env.STUDIO_GPU;
  }
  assert.throws(() => loadConfig({ rootDir: REPO, runner: "mock", render: { gpu: "fast" } as never }));
});

test("each operating system has its hardware encoder", () => {
  assert.equal(hardwareEncoder("win32"), "h264_nvenc");
  assert.equal(hardwareEncoder("linux"), "h264_nvenc");
  assert.equal(hardwareEncoder("darwin"), "h264_videotoolbox");
  assert.equal(hardwareEncoder("freebsd"), undefined);
});

test("the hardware encoder is tried with a real encode, and a failure names the cause", async () => {
  let seen: string[] = [];
  const works = await probeEncoder("h264_nvenc", async (args) => {
    seen = args;
  });
  assert.deepEqual(works, { encoder: "h264_nvenc" });
  assert.equal(seen[seen.indexOf("-c:v") + 1], "h264_nvenc");

  // The test frames are something the bundled ffmpeg can read: the same check passes with the processor's encoder.
  assert.deepEqual(await probeEncoder("libx264"), { encoder: "libx264" });

  const fails = await probeEncoder("h264_nvenc", async () => {
    throw new Error("ffmpeg failed (exit code 1):\n[h264_nvenc @ 0x1] Cannot load nvcuda.dll\n[vost#0:0/h264_nvenc @ 0x2] Error while opening encoder\nConversion failed!");
  });
  assert.equal(fails.encoder, undefined);
  assert.match(fails.reason!, /h264_nvenc did not work on this machine: Cannot load nvcuda\.dll/);

  // This machine has no NVIDIA card, so the real check must say no instead of trusting ffmpeg's list of encoders.
  if (process.platform === "linux") {
    const real = await probeEncoder();
    assert.equal(real.encoder, undefined);
    assert.match(real.reason!, /did not work on this machine/);
    assert.doesNotMatch(real.reason!, /opening input/);
  }
});

test("auto falls back to the processor, on stops with an error, off never checks", async () => {
  const none = async () => ({ reason: "h264_nvenc did not work on this machine: no card" });
  let probes = 0;
  const counted = async () => {
    probes++;
    return { encoder: "h264_nvenc" };
  };
  const lines: string[] = [];
  const log = (m: string) => lines.push(m);

  const auto = await tempStudio();
  forgetEncoder();
  assert.equal(await encoderFor(auto, log, none), undefined);
  assert.match(lines[0]!, /Encoding video on the processor\. h264_nvenc did not work/);

  forgetEncoder();
  assert.equal(await encoderFor(auto, log, counted), "h264_nvenc");
  assert.equal(await encoderFor(auto, log, counted), "h264_nvenc");
  assert.equal(probes, 1, "checked once, not for every clip");
  assert.equal(lines.filter((l) => /on the graphics card \(h264_nvenc\)/.test(l)).length, 1, "said once");

  const on = await tempStudio({ render: { gpu: "on" } as never });
  forgetEncoder();
  await assert.rejects(encoderFor(on, log, none), /render\.gpu is "on" but the graphics card cannot encode video.*no card/s);

  const off = await tempStudio({ render: { gpu: "off" } as never });
  forgetEncoder();
  probes = 0;
  assert.equal(await encoderFor(off, log, counted), undefined);
  assert.equal(probes, 0);

  forgetEncoder();
  for (const s of [auto, on, off]) s.close();
});

test("the hardware encoder is asked for constant quality matched to the CRF", () => {
  const args = ["-r", "30", "-i", "-", "-c:v", "h264_nvenc", "-pix_fmt", "yuv420p", "out.mp4"];
  const out = withEncoderQuality(args, 18);
  assert.deepEqual(out, ["-r", "30", "-i", "-", "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-pix_fmt", "yuv420p", "out.mp4"]);
  assert.deepEqual(withEncoderQuality(out, 18), out, "not added twice");
  const cpu = ["-c:v", "libx264", "-crf", "18", "out.mp4"];
  assert.deepEqual(withEncoderQuality(cpu, 18), cpu);
  assert.equal(nvencQuality(51), 51);
  assert.equal(bitrateFor(1920, 1080, 30, 18), "6221k");
  assert.equal(bitrateFor(1920, 1080, 30, 30), "1555k");
});

test("encoder failures and software renderers are told apart from the rest", () => {
  assert.equal(isEncoderFailure("[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory (10)"), true);
  assert.equal(isEncoderFailure("ReferenceError: foo is not defined"), false);
  assert.equal(isSoftwareDevice("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"), true);
  assert.equal(isSoftwareDevice("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)"), false);
  assert.equal(isSoftwareDevice("ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11)"), true);
});

test("2D scenes are drawn with the graphics card on desktops, and without it when that fails", async () => {
  const auto = await tempStudio();
  assert.equal(gpuFor2d(auto.config.render, "win32"), "angle");
  assert.equal(gpuFor2d(auto.config.render, "darwin"), "angle");
  assert.equal(gpuFor2d(auto.config.render, "linux"), undefined);
  assert.equal(gpuFor2d({ ...auto.config.render, gpu: "on" }, "linux"), "angle");
  assert.equal(gpuFor2d({ ...auto.config.render, gpu: "off", gl: "angle" }, "win32"), undefined);
  assert.equal(gpuFor2d({ ...auto.config.render, gl: "vulkan" }, "linux"), "vulkan");

  const on = await tempStudio({ render: { gpu: "on" } as never });
  const lines: string[] = [];
  const log = (m: string) => lines.push(m);

  // The card works: used, and said once.
  forgetGl();
  const used: (string | undefined)[] = [];
  for (let i = 0; i < 2; i++) await withGl(on, false, log, async (o) => void used.push(o.gl));
  assert.deepEqual(used, ["angle", "angle"]);
  assert.equal(lines.filter((l) => /Drawing frames with the graphics card/.test(l)).length, 1);
  // After it has worked, a failing scene fails as itself and is not drawn twice.
  let tries = 0;
  await assert.rejects(
    withGl(on, false, log, async () => {
      tries++;
      throw new Error("Scene threw");
    }),
    /Scene threw/,
  );
  assert.equal(tries, 1);

  // "on" does not fall back.
  forgetGl();
  await assert.rejects(
    withGl(on, false, log, async (o) => {
      if (o.gl) throw new Error("GPU process crashed");
    }),
    /GPU process crashed/,
  );

  // "auto" with a pinned backend that fails: drawn without it, and not tried again.
  const pinned = await tempStudio({ render: { gl: "angle" } as never });
  forgetGl();
  const order: (string | undefined)[] = [];
  const flaky = async (o: { gl?: string }) => {
    order.push(o.gl);
    if (o.gl) throw new Error("GPU process crashed");
    return "drawn";
  };
  assert.equal(await withGl(pinned, false, log, flaky), "drawn");
  assert.equal(await withGl(pinned, false, log, flaky), "drawn");
  assert.deepEqual(order, ["angle", undefined, undefined]);
  assert.ok(lines.some((l) => /did not work on this machine, so frames are drawn without it\. \(GPU process crashed\)/.test(l)));

  // 3D: "off" draws in software, "on" only with the card.
  forgetGl();
  const off = await tempStudio({ render: { gpu: "off" } as never });
  const three: (string | undefined)[] = [];
  await withGl(off, true, log, async (o) => void three.push(o.gl));
  forgetGl();
  await withGl(on, true, log, async (o) => void three.push(o.gl));
  assert.deepEqual(three, ["swangle", "angle"]);

  forgetGl();
  for (const s of [auto, on, off, pinned]) s.close();
});

test("a clip whose hardware encode fails is encoded on the processor instead, and the studio keeps running", needsBrowser, async (t) => {
  // Needs a machine where ffmpeg has NVIDIA's encoder built in but no card to run it: the hardware path is taken and fails.
  if (process.platform !== "linux" || (await probeEncoder()).encoder) return t.skip("this machine has a working hardware encoder");
  // In a process of its own: the dying encoder leaves a stray rejected promise behind, which
  // would end a process that does not absorb it, and which the test runner counts as a failure.
  const out = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", path.join(REPO, "tests", "helpers", "gpuFallback.ts")], { cwd: REPO, timeout: 600_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout),
    );
  });
  const result = JSON.parse(out.trim().split("\n").at(-1)!) as { lines: string[]; codec: string; durationSec: number; next?: string };
  assert.ok(result.lines.some((l) => /Encoding video on the graphics card \(h264_nvenc\)/.test(l)), result.lines.join("\n"));
  assert.ok(result.lines.some((l) => /Encoding on the graphics card failed, so this and later clips are encoded on the processor/.test(l)), result.lines.join("\n"));
  assert.equal(result.codec, "h264");
  assert.ok(result.durationSec > 1);
  assert.equal(result.next, undefined, "the next clip does not try the card again");
});
