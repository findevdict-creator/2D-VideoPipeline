import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer } from "../packages/server/src/server.js";
import { assemble } from "../packages/core/src/studio/assemble.js";
import { ffmpeg } from "../packages/core/src/studio/media/ffmpeg.js";
import { readWav, wavLayout, writeWav } from "../packages/core/src/studio/media/wav.js";
import { parseSpec } from "../packages/core/src/studio/model/scene.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import { checkSpecAssets } from "../packages/core/src/studio/scenes/validate.js";
import { builtInSound, SOUNDS } from "../packages/core/src/studio/sound/builtin.js";
import { buildSoundtrack, duckingEnvelope, levelAt, MIX_RATE, mixArgs, type Soundtrack } from "../packages/core/src/studio/sound/mix.js";
import { importAsset } from "../packages/core/src/studio/store/assets.js";
import { createProject, getProject, projectPaths, updateProject } from "../packages/core/src/studio/store/projects.js";
import { createRun } from "../packages/core/src/studio/store/runs.js";
import { currentVersion, getScene, listScenes, saveSpec, versionPaths } from "../packages/core/src/studio/store/scenes.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { callTool } from "../packages/core/src/studio/tools/index.js";
import { cueFrames, getVoiceTrack } from "../packages/core/src/studio/voice.js";
import { Orchestrator } from "../packages/core/src/studio/workflow.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { BROWSER, needsBrowser, SAMPLE_SPEC, tempStudio } from "./helpers/studio.js";

const DESCRIPTION = "How noise-cancelling headphones erase sound with more sound.";

/** Plan a video and build its scenes: every scene ends up with a spec, its narration and, from the stand-in runner, sound effects on its cues. */
async function built(studio: Studio, o: Orchestrator, seconds = 60) {
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: seconds });
  o.startStage(project.id);
  await o.idle();
  for (const stage of ["bible", "foundation", "chapters", "scenes"]) {
    assert.equal(o.approveStage(project.id).stage, stage);
    await o.idle();
  }
  return project;
}

/** A steady tone to stand in for music: its loudness is the same everywhere, so any change heard is the studio's doing. */
function writeTone(file: string, seconds: number, hz = 440, level = 0.5) {
  const samples = Int16Array.from({ length: Math.round(seconds * MIX_RATE) }, (_, i) => Math.round(Math.sin((2 * Math.PI * hz * i) / MIX_RATE) * level * 32767));
  writeWav(file, { sampleRate: MIX_RATE, samples });
}

/** How loud a stretch of a track is: the root of the mean square, with full scale as 1. */
function rms(samples: Int16Array, sampleRate: number, fromSec: number, toSec: number) {
  let sum = 0;
  const from = Math.round(fromSec * sampleRate);
  const to = Math.min(samples.length, Math.round(toSec * sampleRate));
  for (let i = from; i < to; i++) sum += (samples[i]! / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** When a track first gets louder than `level` at or after `fromSec`, in seconds. */
function onset(samples: Int16Array, sampleRate: number, fromSec: number, level = 0.02) {
  for (let i = Math.max(0, Math.round(fromSec * sampleRate)); i < samples.length; i++) if (Math.abs(samples[i]!) / 32768 > level) return i / sampleRate;
  return Infinity;
}

/** Where each scene starts and how long it is, the way the assembler lays them out. */
function layoutOf(studio: Studio, projectId: string) {
  let start = 0;
  return listScenes(studio, projectId).map((scene) => {
    const version = currentVersion(studio, scene)!;
    const part = { sceneId: scene.id, versionId: version.id, startFrame: start, frames: version.durationFrames! };
    start += part.frames;
    return part;
  });
}

/** Mix a soundtrack the way the assembler does, to a WAV file, and read it back as one channel. */
async function mixed(sound: Soundtrack, outFile: string) {
  const mix = mixArgs(sound, 0);
  await ffmpeg([...mix.inputs, ...(mix.filter ? ["-filter_complex", mix.filter] : []), "-map", mix.map, "-ar", String(MIX_RATE), "-c:a", "pcm_s16le", outFile]);
  return readWav(outFile);
}

test("the studio's own sounds are short, never clip, hit at once or swell to their moment, and are the same every time", () => {
  for (const name of SOUNDS) {
    const sound = builtInSound(name);
    const seconds = sound.samples.length / sound.sampleRate;
    assert.equal(sound.sampleRate, MIX_RATE);
    assert.ok(seconds >= 0.04 && seconds <= 1.5, `${name} is ${seconds}s long`);
    let peak = 0;
    let peakAt = 0;
    sound.samples.forEach((v, i) => {
      if (Math.abs(v) > peak) {
        peak = Math.abs(v);
        peakAt = i / sound.sampleRate;
      }
    });
    assert.ok(peak > 0.25 && peak <= 1, `${name} peaks at ${peak}`);
    assert.ok(Math.abs(sound.samples.at(-1)!) < 0.01, `${name} ends in silence`);
    if (sound.leadSec === 0) {
      const heard = sound.samples.findIndex((v) => Math.abs(v) > 0.1 * peak) / sound.sampleRate;
      assert.ok(heard < 0.004, `${name} is heard ${heard * 1000} ms after it starts`);
    } else {
      assert.ok(Math.abs(peakAt - sound.leadSec) < 0.08, `${name} is loudest at ${peakAt}s; its moment is at ${sound.leadSec}s`);
    }
    // Made again at another rate, it is the same sound: as long, and as loud.
    const other = builtInSound(name, 24000);
    assert.ok(Math.abs(other.samples.length / 24000 - seconds) < 0.001);
    assert.equal(builtInSound(name), sound, "made once and kept");
  }
});

test("the music's level falls before each stretch of speech and comes back only in pauses long enough for it", () => {
  const levels = { under: 0.1, full: 0.5 };
  // Speech from 1 to 3 s and from 3.5 to 5 s (a breath between), then again from 9 to 10 s, in a 12 s video.
  const env = duckingEnvelope([[1, 3], [3.5, 5], [9, 10]], 12, levels);
  const at = (sec: number) => Math.round(levelAt(env, sec) * 1000) / 1000;
  assert.equal(at(0), 0.5, "full before anyone speaks");
  assert.equal(at(0.69), 0.5);
  assert.ok(at(0.85) < 0.5 && at(0.85) > 0.1, "on its way down");
  assert.equal(at(1), 0.1, "down by the first word");
  assert.equal(at(2), 0.1);
  assert.equal(at(3.25), 0.1, "a breath is not a pause: it stays down");
  assert.equal(at(5.3), 0.1, "it holds for a moment after the last word");
  assert.ok(at(5.8) > 0.1 && at(5.8) < 0.5, "then rises");
  assert.equal(at(6.3), 0.5, "and is back up in the pause");
  assert.equal(at(8.6), 0.5);
  assert.equal(at(9), 0.1, "down again for the next words");
  assert.equal(at(10.3), 0.1);
  assert.equal(at(11.3), 0.5);
  assert.equal(at(12), 0.5);
  // It never leaves the range, and never jumps: no step larger than its fastest slope allows.
  for (let t = 0; t < 12; t += 0.01) {
    assert.ok(at(t) >= 0.1 && at(t) <= 0.5);
    assert.ok(Math.abs(levelAt(env, t + 0.01) - levelAt(env, t)) < 0.02, `a jump at ${t}s`);
  }
  // Speech from the very start, and to the very end: down throughout.
  const whole = duckingEnvelope([[0.1, 4]], 4, levels);
  assert.equal(levelAt(whole, 0), 0.1);
  assert.equal(levelAt(whole, 4), 0.1);
  // Nobody speaks: full throughout.
  assert.deepEqual(duckingEnvelope([], 5, levels).map((p) => p.gain), [0.5, 0.5]);
});

test("a spec's sound effects must be one of the studio's sounds or a short sound file, on a cue that exists", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 60 });
  const base = { ...SAMPLE_SPEC };
  const problems = (sfx: unknown) => {
    const parsed = parseSpec({ ...base, sfx });
    return parsed.ok ? checkSpecAssets(studio, project.id, parsed.spec) : parsed.problems;
  };
  assert.deepEqual(problems([{ sound: "pop", at: { cue: "sat" } }, { sound: "ding", at: { sec: 2 }, volume: 0.3 }]), []);
  assert.match(problems([{ sound: "explosion", at: { cue: "sat" } }]).join(), /sfx\.0\.sound/);
  assert.match(problems([{ at: { cue: "sat" } }]).join(), /exactly one of sound or assetId/);
  assert.match(problems([{ sound: "pop", assetId: "as_x", at: { cue: "sat" } }]).join(), /exactly one of sound or assetId/);
  assert.match(problems([{ sound: "pop", at: { cue: "nowhere" } }]).join(), /no cue with the id "nowhere"/);
  assert.match(problems([{ assetId: "as_missing", at: { sec: 1 } }]).join(), /no asset with the id "as_missing"/);
  // A long file is music, not an effect.
  const long = path.join(studio.workspaceDir, "long.wav");
  writeTone(long, 20);
  const song = await importAsset(studio, project.id, long, { label: "Twenty seconds" });
  assert.match(problems([{ assetId: song.id, at: { sec: 1 } }]).join(), /20s long.*at most 15s/);
  const short = path.join(studio.workspaceDir, "short.wav");
  writeTone(short, 0.3, 900);
  const blip = await importAsset(studio, project.id, short, { label: "Blip" });
  assert.equal(blip.kind, "audio_sfx");
  assert.deepEqual(problems([{ assetId: blip.id, at: { sec: 1 } }]), []);
  studio.close();
});

test("in the mixed sound of a video, effects land within two frames of their cue words and music dips under the narration and returns in the gaps", async () => {
  // Two and a half seconds of silence after each scene's narration, so there are pauses for the music to come back in.
  const studio = await tempStudio({ voice: { padAfterSec: 2.5 } } as never);
  const runner = new MockStudioRunner();
  const o = new NoRenderOrchestrator(studio, runner);
  const project = await built(studio, o);
  const p = projectPaths(studio, project);
  const fps = project.fps;
  const layout = layoutOf(studio, project.id);
  assert.equal(layout.length, 2);
  const work = path.join(studio.workspaceDir, "sound");

  // What the scene builder was offered, and what it chose.
  const run = createRun(studio, { projectId: project.id, kind: "scene", targetId: layout[0]!.sceneId, agent: "scene-builder" });
  const offered = (await callTool({ studio, projectId: project.id, run, log: () => {} }, "scene_get", {})).output.sounds as { builtIn: Record<string, string>; howToUse: string };
  assert.deepEqual(Object.keys(offered.builtIn), [...SOUNDS]);
  assert.match(offered.howToUse, /"sfx", each on a cue/);

  // Where every effect should be: its scene's start plus the frame its cue phrase begins on.
  const expected: { atSec: number; sound: string }[] = [];
  for (const part of layout) {
    const version = currentVersion(studio, getScene(studio, part.sceneId))!;
    const track = getVoiceTrack(studio, version.voiceTrackId!)!;
    assert.ok(version.spec.sfx.length >= 1, "the scene has sound effects");
    const cues = cueFrames(version.spec.cues, track, fps, {});
    for (const sfx of version.spec.sfx) {
      const cue = cues.find((c) => c.id === sfx.at.cue)!;
      // The cue's frame is the frame its phrase starts being spoken in.
      assert.ok(Math.abs(cue.startFrame / fps - cue.startSec) <= 0.5 / fps);
      expected.push({ atSec: (part.startFrame + cue.startFrame) / fps, sound: sfx.sound! });
    }
  }
  assert.ok(expected.length >= 3);

  // Without music: the narration (silent, from the stand-in voice) and the effects.
  const plain = await buildSoundtrack(studio, project, layout, path.join(work, "plain"));
  assert.equal(plain.music, undefined);
  assert.deepEqual(plain.effects.map((e) => [Math.round(e.atSec * 1000), e.label]), expected.map((e) => [Math.round(e.atSec * 1000), e.sound]));
  const total = layout.at(-1)!.startFrame + layout.at(-1)!.frames;
  assert.equal(wavLayout(plain.sfx!).frames, Math.round((total / fps) * MIX_RATE), "the effects track is exactly as long as the video");
  const heard = await mixed(plain, path.join(work, "plain.wav"));
  assert.ok(Math.abs(heard.samples.length / heard.sampleRate - total / fps) < 0.05, "and so is the mix");
  for (const e of expected) {
    // Silence just before the cue, and the sound within two frames after it.
    assert.ok(rms(heard.samples, heard.sampleRate, e.atSec - 0.12, e.atSec - 0.01) < 0.002, `quiet before the ${e.sound} at ${e.atSec}s`);
    const at = onset(heard.samples, heard.sampleRate, e.atSec - 0.1);
    assert.ok(Math.abs(at - e.atSec) <= 2 / fps, `the ${e.sound} for ${e.atSec.toFixed(3)}s is heard at ${at.toFixed(3)}s`);
  }

  // With music: a steady tone, shorter than the video, so it has to repeat.
  const tone = path.join(studio.workspaceDir, "tone.wav");
  writeTone(tone, 3);
  const music = await importAsset(studio, project.id, tone, { label: "Tone" });
  updateProject(studio, project.id, { settings: { music: { assetId: music.id, volume: 0.1, duck: true, gapVolume: 0.4 }, sfx: { enabled: false, volume: 1 } } });
  const scored = await buildSoundtrack(studio, getProject(studio, project.id), layout, path.join(work, "scored"));
  assert.equal(scored.sfx, undefined, "effects are switched off for this one");
  assert.equal(wavLayout(scored.music!).channels, 1, "a one-channel file stays one channel until the mix");
  const song = await mixed(scored, path.join(work, "scored.wav"));
  const full = 0.5 / Math.SQRT2; // how loud the tone is by itself
  const [firstSpeech, secondSpeech] = [scored.speech[0]!, scored.speech.find((s) => s[0] > layout[1]!.startFrame / fps)!];
  const gap: [number, number] = [scored.speech.filter((s) => s[1] <= layout[1]!.startFrame / fps).at(-1)![1], secondSpeech[0]];
  assert.ok(gap[1] - gap[0] > 2.5, `there is a pause of ${gap[1] - gap[0]}s between the scenes`);
  const under = rms(song.samples, song.sampleRate, firstSpeech[0] + 1, firstSpeech[1] - 0.2);
  const between = rms(song.samples, song.sampleRate, gap[0] + 1.3, gap[1] - 0.4);
  const underAgain = rms(song.samples, song.sampleRate, secondSpeech[0] + 0.1, secondSpeech[0] + 1.5);
  assert.ok(Math.abs(under / full - 0.1) < 0.015, `under the voice the music is at ${(under / full).toFixed(3)} of its level`);
  assert.ok(Math.abs(between / full - 0.4) < 0.04, `in the pause it is back at ${(between / full).toFixed(3)}`);
  assert.ok(Math.abs(underAgain / full - 0.1) < 0.015, `and down again at ${(underAgain / full).toFixed(3)} for the next scene`);
  // It repeats without a hole: no stretch of the pause is silent.
  for (let t = gap[0] + 1.3; t < gap[1] - 0.5; t += 0.1) assert.ok(rms(song.samples, song.sampleRate, t, t + 0.1) > 0.25 * full * 0.4, `the music is there at ${t.toFixed(1)}s`);
  // It fades in at the start and out at the end.
  assert.ok(rms(song.samples, song.sampleRate, 0, 0.05) < 0.3 * rms(song.samples, song.sampleRate, 0.7, 0.9) + 0.002);
  const end = total / fps;
  assert.ok(rms(song.samples, song.sampleRate, end - 0.1, end) < 0.2 * between);

  // Ducking off: the same level everywhere.
  updateProject(studio, project.id, { settings: { music: { assetId: music.id, volume: 0.2, duck: false, gapVolume: 0.4 } } });
  const steady = readWav((await buildSoundtrack(studio, getProject(studio, project.id), layout, path.join(work, "steady"))).music!);
  const here = rms(steady.samples, steady.sampleRate, firstSpeech[0] + 1, firstSpeech[1]);
  const there = rms(steady.samples, steady.sampleRate, gap[0] + 1.3, gap[1] - 0.4);
  assert.ok(Math.abs(here / full - 0.2) < 0.02 && Math.abs(there / full - 0.2) < 0.02, `steady at ${here / full} and ${there / full}`);

  // A sound file of the project's own, placed by time.
  const beep = path.join(studio.workspaceDir, "beep.wav");
  writeTone(beep, 0.2, 1500, 0.8);
  const own = await importAsset(studio, project.id, beep, { label: "Beep" });
  const scene = getScene(studio, layout[0]!.sceneId);
  const spec = currentVersion(studio, scene)!.spec;
  const resaved = saveSpec(studio, scene.id, { ...spec, sfx: [{ assetId: own.id, at: { sec: 1 }, volume: 1 }] }, "test", (s) => checkSpecAssets(studio, project.id, s));
  assert.ok(resaved.ok, JSON.stringify(resaved));
  updateProject(studio, project.id, { settings: { music: { assetId: null, volume: 0.1, duck: true, gapVolume: 0.4 }, sfx: { enabled: true, volume: 1 } } });
  const custom = await buildSoundtrack(studio, getProject(studio, project.id), layoutOf(studio, project.id).slice(0, 1), path.join(work, "custom"));
  assert.deepEqual(custom.effects, [{ atSec: 1, label: "Beep" }]);
  const beeped = readWav(custom.sfx!);
  assert.ok(Math.abs(onset(beeped.samples, beeped.sampleRate, 0) - 1) < 0.002);
  assert.ok(Math.abs(rms(beeped.samples, beeped.sampleRate, 1.02, 1.18) - 0.8 / Math.SQRT2) < 0.03, "at the level the file has");
  o.stop();
  studio.close();
});

test("the sound settings are changed from the page, one group at a time", async () => {
  const studio = await tempStudio();
  const o = new NoRenderOrchestrator(studio, new MockStudioRunner());
  const server = await startServer(studio, { port: 0, orchestrator: o });
  const patch = async (slug: string, settings: unknown) => {
    const res = await fetch(`${server.url}/api/projects/${slug}`, { method: "PATCH", headers: { "x-studio": "1", "content-type": "application/json" }, body: JSON.stringify({ settings }) });
    return { status: res.status, data: (await res.json()) as any };
  };
  try {
    const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 60 });
    assert.deepEqual(project.settings.music, { assetId: null, volume: 0.12, duck: true, gapVolume: 0.4 });
    assert.deepEqual(project.settings.sfx, { enabled: true, volume: 1 });
    assert.equal((await patch(project.slug, { music: { volume: 0.2 } })).status, 200);
    assert.equal((await patch(project.slug, { sfx: { enabled: false } })).status, 200);
    assert.equal((await patch(project.slug, { music: { gapVolume: 7 } })).status, 400);
    const now = getProject(studio, project.id).settings;
    assert.deepEqual(now.music, { assetId: null, volume: 0.2, duck: true, gapVolume: 0.4 });
    assert.deepEqual(now.sfx, { enabled: false, volume: 1 });
    assert.deepEqual(now.theme, project.settings.theme);
  } finally {
    await server.close();
    o.stop();
    studio.close();
  }
});

test("with real rendering: a scene's review copy carries its sound effects, and the finished video its music under the voice", needsBrowser, async () => {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER }, voice: { padAfterSec: 2.5 } } as never);
  const runner = new MockStudioRunner();
  runner.stills = false;
  const o = new Orchestrator(studio, runner);
  const project = await built(studio, o);
  const p = projectPaths(studio, project);
  const fps = project.fps;
  const scenes = listScenes(studio, project.id);
  assert.deepEqual(scenes.map((s) => s.status), ["needs_review", "needs_review"]);
  const audioOf = async (file: string) => {
    const wav = `${file}.audio.wav`;
    await ffmpeg(["-i", file, "-vn", "-ac", "1", "-ar", String(MIX_RATE), "-c:a", "pcm_s16le", wav]);
    return readWav(wav);
  };

  // The review copy of a scene: its pop is where its first cue is.
  const first = currentVersion(studio, scenes[0]!)!;
  const cues = cueFrames(first.spec.cues, getVoiceTrack(studio, first.voiceTrackId!)!, fps, {});
  const review = await audioOf(versionPaths(studio, project, first).review("preview"));
  for (const sfx of first.spec.sfx) {
    const atSec = cues.find((c) => c.id === sfx.at.cue)!.startFrame / fps;
    const at = onset(review.samples, review.sampleRate, Math.max(0, atSec - 0.1), 0.01);
    assert.ok(Math.abs(at - atSec) <= 2 / fps, `in the review copy the ${sfx.sound} for ${atSec.toFixed(3)}s is heard at ${at.toFixed(3)}s`);
  }

  // The whole video, with music.
  const tone = path.join(studio.workspaceDir, "tone.wav");
  writeTone(tone, 3);
  const music = await importAsset(studio, project.id, tone, { label: "Tone" });
  updateProject(studio, project.id, { settings: { music: { assetId: music.id, volume: 0.1, duck: true, gapVolume: 0.4 }, sfx: { enabled: false, volume: 1 } } });
  const result = await assemble(studio, project.id);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.rendered, 0, "the clips were made already: sound is added when they are joined");
  const video = await audioOf(result.file);
  const starts = result.render.sceneVersions.map((s) => s.startFrame / fps);
  const firstTrack = getVoiceTrack(studio, first.voiceTrackId!)!;
  const full = 0.5 / Math.SQRT2;
  const under = rms(video.samples, video.sampleRate, firstTrack.speechStartSec + 1, firstTrack.speechEndSec - 0.3);
  const between = rms(video.samples, video.sampleRate, firstTrack.speechEndSec + 1.3, starts[1]! - 0.1);
  assert.ok(Math.abs(under / full - 0.1) < 0.03, `under the voice the music is at ${(under / full).toFixed(3)}`);
  assert.ok(Math.abs(between / full - 0.4) < 0.08, `between the scenes it is at ${(between / full).toFixed(3)}`);
  assert.ok(fs.existsSync(p.abs(result.render.path)));
  o.stop();
  studio.close();
});
