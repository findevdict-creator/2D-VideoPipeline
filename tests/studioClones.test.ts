import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer } from "../packages/server/src/server.js";
import { MockSpeechEngine } from "../packages/core/src/voice/engine.js";
import { cloneEngines, cloneId, deleteClone, getClone, listClones, parseCloneId, referenceFile, resolveNarrator, saveClone, setCloneBase, voicesDir } from "../packages/core/src/studio/clones.js";
import { readWav, wavHeader } from "../packages/core/src/studio/media/wav.js";
import { addChapter } from "../packages/core/src/studio/store/chapters.js";
import { createProject, getProject, projectPaths } from "../packages/core/src/studio/store/projects.js";
import { addScene, saveSpec } from "../packages/core/src/studio/store/scenes.js";
import { ensureVoice, voiceSettings } from "../packages/core/src/studio/voice.js";
import { previewVoice, setVoice } from "../packages/core/src/studio/voices.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { REPO, SAMPLE_SPEC, tempStudio } from "./helpers/studio.js";

/** A WAV file of a tone, as the page would send a recording. */
function tone(seconds: number, { rate = 44100, channels = 2, level = 0.4, hz = 180 } = {}): Buffer {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * level * 32767), (i * channels + c) * 2);
  return Buffer.concat([wavHeader(rate, frames, channels), data]);
}

test("a recording is kept as a voice in the workspace, outside the repository, and can be replaced and deleted", async () => {
  const studio = await tempStudio();
  assert.deepEqual(listClones(studio), []);

  const { voice, warnings } = saveClone(studio, { name: "  My  Voice ", wav: tone(12) });
  assert.deepEqual(warnings, []);
  assert.equal(voice.name, "My Voice");
  assert.equal(voice.slug, "my-voice");
  assert.equal(voice.baseVoice, "am_michael");
  assert.equal(voice.clipSec, 12);

  const file = referenceFile(studio, "my-voice");
  assert.ok(file.startsWith(path.join(studio.workspaceDir, "voices")), "the clip is in the workspace");
  assert.ok(path.relative(REPO, file).startsWith(".."), "and not in the repository");
  const kept = readWav(file);
  assert.equal(kept.sampleRate, 24000, "stored at the rate both engines read");
  assert.equal(kept.samples.length, 12 * 24000);
  assert.deepEqual(listClones(studio).map((c) => c.name), ["My Voice"]);

  // The same name again replaces the recording, and the voice keeps its settings.
  setCloneBase(studio, "my-voice", "bf_emma");
  const again = saveClone(studio, { name: "my voice", wav: tone(20, { hz: 240 }) }).voice;
  assert.equal(listClones(studio).length, 1);
  assert.equal(again.baseVoice, "bf_emma");
  assert.equal(again.createdAt, voice.createdAt);
  assert.notEqual(again.clipHash, voice.clipHash);

  deleteClone(studio, "my-voice");
  assert.deepEqual(listClones(studio), []);
  assert.ok(!fs.existsSync(path.join(voicesDir(studio), "my-voice")));
  assert.throws(() => getClone(studio, "my-voice"), /no cloned voice/);
  assert.throws(() => getClone(studio, "../projects"), /no cloned voice/);
  studio.close();
});

test("a recording that cannot make a good voice is refused or warned about", async () => {
  const studio = await tempStudio();
  assert.throws(() => saveClone(studio, { name: "", wav: tone(12) }), /Give the voice a name/);
  assert.throws(() => saveClone(studio, { name: "Me", wav: tone(3) }), /at least 6 seconds/);
  assert.throws(() => saveClone(studio, { name: "Me", wav: tone(120, { rate: 8000, channels: 1 }) }), /under 90 seconds/);
  assert.throws(() => saveClone(studio, { name: "Me", wav: tone(12, { level: 0 }) }), /silent/);
  assert.throws(() => saveClone(studio, { name: "Me", wav: Buffer.from("not audio at all") }), /could not be read/);
  assert.throws(() => saveClone(studio, { name: "Me", wav: tone(12), baseVoice: "zf_001" }), /not an English Kokoro voice/);
  assert.deepEqual(listClones(studio), []);
  assert.deepEqual(fs.readdirSync(voicesDir(studio)), [], "nothing is kept from a refused recording");

  assert.match(saveClone(studio, { name: "Quiet", wav: tone(12, { level: 0.03 }) }).warnings.join(" "), /very quiet/);
  assert.match(saveClone(studio, { name: "Short", wav: tone(7) }).warnings.join(" "), /short/);
  assert.match(saveClone(studio, { name: "Loud", wav: tone(12, { level: 1 }) }).warnings.join(" "), /distorted/);
  studio.close();
});

test("a cloned voice is a narrator like any other: chosen per video, sampled, and recorded with its clip", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: "How GPS finds your phone" });
  const before = voiceSettings(studio, project);
  assert.deepEqual(Object.keys(before), ["engine", "voice", "language", "speed", "padBeforeSec", "padAfterSec", "sampleRate"], "a Kokoro voice's settings are unchanged, so its recorded narration still counts");

  saveClone(studio, { name: "My voice", wav: tone(12), baseVoice: "bm_george" });
  assert.deepEqual(parseCloneId("clone.my-voice"), { slug: "my-voice", engine: "kokoclone" });
  assert.deepEqual(parseCloneId("clone.my-voice.chatterbox"), { slug: "my-voice", engine: "chatterbox" });
  assert.equal(parseCloneId("af_heart"), undefined);
  assert.equal(resolveNarrator(studio, "AF_Heart").id, "af_heart");
  assert.throws(() => resolveNarrator(studio, "nobody"), /is not a voice/);
  assert.throws(() => setVoice(studio, project.id, { voice: "clone.someone-else" }), /no cloned voice/);

  const mine = setVoice(studio, project.id, { voice: cloneId("my-voice") });
  assert.equal(mine.settings.voice.kokoroVoice, "clone.my-voice");
  const settings = voiceSettings(studio, mine);
  assert.equal(settings.voice, "clone.my-voice");
  assert.equal(settings.language, "b", "the language is the one of the voice it starts from");
  assert.equal(settings.clone?.base, "bm_george");

  // Narration goes to the engine as the Kokoro voice plus the clip to re-voice it with.
  const chapter = addChapter(studio, project.id, { title: "The idea" });
  const scene = addScene(studio, chapter.id, { title: "Satellites", type: "remotion-2d", narration: SAMPLE_SPEC.narration });
  saveSpec(studio, scene.id, SAMPLE_SPEC, "test");
  const logs: string[] = [];
  const track = (await ensureVoice(studio, [scene.id], (m) => logs.push(m))).get(scene.id)!;
  assert.match(logs.join("\n"), /your voice "My voice" \(Kokoro, re-voiced\)/);
  const item = MockSpeechEngine.last!.items[0]!;
  assert.equal(item.voice, "bm_george");
  assert.deepEqual(item.clone, { engine: "kokoclone", referenceFile: referenceFile(studio, "my-voice") });
  assert.equal((await ensureVoice(studio, [scene.id])).get(scene.id)!.id, track.id, "recorded once");

  // Chatterbox, another starting voice, or a new recording each count as a different voice to record in.
  setVoice(studio, project.id, { voice: "clone.my-voice.chatterbox" });
  const viaChatterbox = (await ensureVoice(studio, [scene.id])).get(scene.id)!;
  assert.notEqual(viaChatterbox.id, track.id);
  assert.equal(MockSpeechEngine.last!.items[0]!.clone?.engine, "chatterbox");
  setVoice(studio, project.id, { voice: "clone.my-voice" });
  assert.equal((await ensureVoice(studio, [scene.id])).get(scene.id)!.id, track.id, "going back records nothing");
  setCloneBase(studio, "my-voice", "am_michael");
  assert.notEqual((await ensureVoice(studio, [scene.id])).get(scene.id)!.id, track.id);
  setCloneBase(studio, "my-voice", "bm_george");
  saveClone(studio, { name: "My voice", wav: tone(15, { hz: 300 }) });
  assert.notEqual((await ensureVoice(studio, [scene.id])).get(scene.id)!.id, track.id);

  // A sample, with the usual line or one of your own.
  const p = projectPaths(studio, project);
  const sample = await previewVoice(studio, project.id, { voice: "clone.my-voice" });
  assert.ok(fs.statSync(p.abs(sample.file)).size > 1000);
  assert.equal((await previewVoice(studio, project.id, { voice: "clone.my-voice" })).file, sample.file);
  const own = await previewVoice(studio, project.id, { voice: "clone.my-voice", text: "Welcome back to the channel." });
  assert.notEqual(own.file, sample.file);
  assert.match(MockSpeechEngine.last!.items[0]!.text, /Welcome back/);
  assert.notEqual((await previewVoice(studio, project.id, { voice: "af_bella", text: "Welcome back to the channel." })).file, (await previewVoice(studio, project.id, { voice: "af_bella" })).file);
  await assert.rejects(previewVoice(studio, project.id, { voice: "af_bella", text: "x".repeat(401) }), /Keep it under 400/);

  // A deleted voice stops the narration with words about what to do, not a crash somewhere else.
  deleteClone(studio, "my-voice");
  assert.equal(getProject(studio, project.id).settings.voice.kokoroVoice, "clone.my-voice");
  await assert.rejects(ensureVoice(studio, [scene.id]), /no cloned voice "my-voice".*Choose another narrator/);
  studio.close();
});

test("the page can save, list, adjust and delete a voice over the API", async () => {
  const studio = await tempStudio();
  const server = await startServer(studio, { port: 0, orchestrator: new NoRenderOrchestrator(studio) });
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const raw = body instanceof Uint8Array;
    const res = await fetch(server.url + url, { method, headers: { "x-studio": "1", ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : raw ? Buffer.from(body) : JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as any };
  };
  try {
    const project = createProject(studio, { description: "How GPS finds your phone" });
    const empty = (await call("GET", `/api/projects/${project.slug}`)).data.voices;
    assert.deepEqual(empty.clones, []);
    assert.deepEqual(empty.engines, { kokoclone: true, chatterbox: true }, "the stand-in voice needs nothing installed");

    const refused = await call("POST", "/api/voices", tone(2), { "x-voice-name": encodeURIComponent("Mine"), "content-type": "audio/wav" });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /at least 6 seconds/);

    const saved = await call("POST", "/api/voices", tone(12), { "x-voice-name": encodeURIComponent("Ma voix"), "x-base-voice": "bf_emma", "content-type": "audio/wav" });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.id, "clone.ma-voix");

    const listed = (await call("GET", `/api/projects/${project.slug}`)).data.voices.clones;
    assert.equal(listed.length, 1);
    assert.deepEqual([listed[0].id, listed[0].chatterboxId, listed[0].name, listed[0].baseVoice], ["clone.ma-voix", "clone.ma-voix.chatterbox", "Ma voix", "bf_emma"]);

    assert.equal((await call("POST", `/api/projects/${project.slug}/voice`, { voice: "clone.ma-voix" })).status, 200);
    const sample = await call("POST", `/api/projects/${project.slug}/voice/preview`, { voice: "clone.ma-voix.chatterbox", text: "A line of my own." });
    assert.equal(sample.status, 200, JSON.stringify(sample.data));
    assert.equal((await fetch(server.url + sample.data.url)).status, 200);

    assert.equal((await call("PATCH", "/api/voices/ma-voix", { baseVoice: "am_adam" })).data.voice.baseVoice, "am_adam");
    assert.equal((await call("PATCH", "/api/voices/ma-voix", { baseVoice: "robot" })).status, 400);
    assert.equal((await call("DELETE", "/api/voices/ma-voix")).status, 200);
    assert.equal((await call("DELETE", "/api/voices/ma-voix")).status, 400);
    assert.deepEqual((await call("GET", `/api/projects/${project.slug}`)).data.voices.clones, []);
  } finally {
    await server.close();
    studio.close();
  }
});

test("a cloning engine counts as installed only when its environment is there", async () => {
  const studio = await tempStudio({ voice: { engine: "kokoro" } });
  const root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "studio-root-"));
  (studio.config as { rootDir: string }).rootDir = root;
  const here = cloneEngines(studio);
  const bin = (name: string) => (process.platform === "win32" ? path.join(root, name, "Scripts", "python.exe") : path.join(root, name, "bin", "python"));
  const site = process.platform === "win32" ? path.join(root, ".venv-voice", "Lib", "site-packages") : path.join(root, ".venv-voice", "lib", "python3.12", "site-packages");
  fs.mkdirSync(path.join(site, "kanade_tokenizer"), { recursive: true });
  fs.mkdirSync(path.dirname(bin(".venv-chatterbox")), { recursive: true });
  fs.writeFileSync(bin(".venv-chatterbox"), "");
  assert.deepEqual(cloneEngines(studio), { kokoclone: true, chatterbox: true });
  fs.rmSync(root, { recursive: true, force: true });
  assert.deepEqual(cloneEngines(studio), here, "and not when it is gone");
  studio.close();
});
