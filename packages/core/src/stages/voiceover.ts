import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { SCRIPTWRITER, STORYBOARD_ARTIST } from "../agents/definitions.js";
import { runAgentForFile, validateJsonFile } from "../agents/runAgent.js";
import type { StageContext } from "../context.js";
import { ScriptSchema, VoiceoverSchema, schemaForPrompt, type Voiceover } from "../schemas.js";
import { createSpeechEngine, type SpeechItem } from "../voice/engine.js";
import { applyPronunciations, findCueTiming, kokoroLanguage, loadPronunciations } from "../voice/text.js";
import { files, readJson, validateScript, validateStoryboard, type Brief, type Script, type Storyboard } from "./files.js";
import type { Stage } from "./types.js";

const voicePaths = (ctx: StageContext) => ({
  dir: ctx.production.path("voice"),
  scene: (id: string) => ctx.production.path("voice", `${id}.wav`),
  full: ctx.production.path("voice", "full.wav"),
  json: ctx.production.path("voiceover.json"),
});

/** The voice for this video: the brief's voice and pace, on top of pipeline.config.json. */
export async function voiceSettings(ctx: StageContext) {
  const v = ctx.config.voice;
  const brief = existsSync(files(ctx).brief) ? await readJson<Brief>(files(ctx).brief) : undefined;
  const voice = brief?.voice.kokoroVoice || v.voice;
  const pace = brief?.voice.pace ?? "normal";
  return {
    engine: v.engine,
    voice,
    language: kokoroLanguage(v.language, voice),
    speed: Math.round(v.speed * v.paceSpeed[pace] * 1000) / 1000,
    padBeforeSec: v.padBeforeSec,
    padAfterSec: v.padAfterSec,
    sampleRate: v.sampleRate,
  };
}

/**
 * Speak every scene, reusing audio for scenes whose text and settings have not changed,
 * then time each storyboard cue against the spoken words.
 */
export async function synthesize(ctx: StageContext): Promise<Voiceover> {
  const p = voicePaths(ctx);
  const script = await readJson<Script>(files(ctx).script);
  const board = await readJson<Storyboard>(files(ctx).storyboard);
  const pronunciations = await loadPronunciations(ctx.config);
  const settings = await voiceSettings(ctx);
  const previous = existsSync(p.json) ? await readJsonSafe<Voiceover>(p.json) : undefined;
  await fs.mkdir(p.dir, { recursive: true });

  const planned = script.scenes.map((scene) => {
    const spokenText = applyPronunciations(scene.narration, pronunciations);
    const cacheKey = createHash("sha1").update(JSON.stringify({ spokenText, ...settings })).digest("hex").slice(0, 16);
    const reuse = previous?.scenes.find((s) => s.id === scene.id && s.cacheKey === cacheKey);
    return { scene, spokenText, cacheKey, reuse: reuse && existsSync(p.scene(scene.id)) ? reuse : undefined };
  });

  const toSpeak: SpeechItem[] = planned
    .filter((x) => !x.reuse)
    .map((x) => ({
      id: x.scene.id,
      text: x.spokenText,
      voice: settings.voice,
      lang: settings.language,
      speed: settings.speed,
      padBeforeSec: settings.padBeforeSec,
      padAfterSec: settings.padAfterSec,
      outFile: p.scene(x.scene.id),
    }));
  const reused = planned.length - toSpeak.length;
  ctx.log(
    `▸ Voiceover: ${toSpeak.length} scene(s) to speak with ${settings.voice} at speed ${settings.speed}` +
      (reused ? `, ${reused} unchanged and reused` : "") +
      (settings.engine === "mock" ? " (mock voice: silent audio)" : ""),
  );

  const engine = createSpeechEngine(ctx.config);
  const needFull = toSpeak.length > 0 || !existsSync(p.full);
  const output = await engine.speak(
    {
      sampleRate: settings.sampleRate,
      items: toSpeak,
      concat: needFull ? { files: script.scenes.map((s) => p.scene(s.id)), outFile: p.full } : undefined,
    },
    ctx.log,
  );

  const scenes: Voiceover["scenes"] = planned.map((x) => {
    const spoken = output.items.find((r) => r.id === x.scene.id) ?? x.reuse;
    if (!spoken) throw new Error(`No audio came back for scene ${x.scene.id}`);
    const speech = { startSec: spoken.speechStartSec, endSec: spoken.speechEndSec };
    const animations = board.scenes.find((s) => s.id === x.scene.id)?.animations ?? [];
    return {
      id: x.scene.id,
      audioFile: path.relative(ctx.production.dir, p.scene(x.scene.id)).split(path.sep).join("/"),
      durationSec: spoken.durationSec,
      speechStartSec: spoken.speechStartSec,
      speechEndSec: spoken.speechEndSec,
      spokenText: x.spokenText,
      cacheKey: x.cacheKey,
      words: spoken.words,
      cues: animations.map((a) => ({
        elementId: a.elementId,
        cue: a.cue,
        ...findCueTiming(a.cue, x.spokenText, spoken.words, speech, pronunciations),
      })),
    };
  });

  const voiceover: Voiceover = {
    settings,
    totalDurationSec: Math.round(scenes.reduce((sum, s) => sum + s.durationSec, 0) * 1000) / 1000,
    fullAudioFile: path.relative(ctx.production.dir, p.full).split(path.sep).join("/"),
    scenes,
  };
  await fs.writeFile(p.json, JSON.stringify(voiceover, null, 2) + "\n");
  ctx.log(`✓ Voiceover done: ${voiceover.totalDurationSec.toFixed(1)}s in total`);
  return voiceover;
}

/** Narration changes go through the Scriptwriter, so the script stays the single source of what is said. */
async function reviseNarration(ctx: StageContext, notes: string) {
  const f = files(ctx);
  await runAgentForFile(
    ctx,
    SCRIPTWRITER,
    `The voiceover for this video has been recorded, and the human producer wants changes to what is said.
Read ${f.brief}, ${f.research} and the current ${f.script} first.
The human producer's notes after listening:
${notes}

Change only the scenes the notes are about. Keep every scene id, and keep all other scenes word for word,
so their audio does not have to be recorded again. Write the updated script back to ${f.script}.

script.json must be JSON matching this JSON Schema:
${schemaForPrompt(ScriptSchema)}`,
    f.script,
    () => validateScript(ctx),
  );
}

/** After narration changes, make sure every storyboard cue is still a phrase the narrator says. */
async function fixStoryboardCues(ctx: StageContext) {
  const check = await validateStoryboard(ctx);
  if (check.ok) return;
  const f = files(ctx);
  ctx.log("  The narration changed, so some storyboard cues no longer match. Asking the Storyboard artist to update them.");
  await runAgentForFile(
    ctx,
    STORYBOARD_ARTIST,
    `The narration in ${f.script} has changed, and the storyboard at ${f.storyboard} no longer matches it:
${check.errors.map((e) => `- ${e}`).join("\n")}

Read both files. Update only what these problems require, usually the animation cues of the changed scenes,
so each cue is again a phrase copied word for word from its scene's narration. Leave everything else as it is.
Write the storyboard back to ${f.storyboard}.`,
    f.storyboard,
    () => validateStoryboard(ctx),
  );
}

export const voiceoverStage: Stage = {
  id: "voiceover",
  title: "Voiceover",

  outputs: (ctx) => [voicePaths(ctx).full, voicePaths(ctx).json],

  archiveFiles: (ctx) => [voicePaths(ctx).json, files(ctx).script, files(ctx).storyboard],

  async produce(ctx, notes) {
    if (notes) {
      await reviseNarration(ctx, notes);
      await fixStoryboardCues(ctx);
    }
    await synthesize(ctx);
  },

  async afterEdit(ctx) {
    await fixStoryboardCues(ctx);
    await synthesize(ctx);
  },

  async summarize(ctx) {
    const vo = await readJson<Voiceover>(voicePaths(ctx).json);
    const script = await readJson<Script>(files(ctx).script);
    const s = vo.settings;
    const lines = [
      `Voice: ${s.voice} (language ${s.language}), speed ${s.speed}, pauses ${s.padBeforeSec}s before and ${s.padAfterSec}s after each scene`,
      `Total length: ${vo.totalDurationSec.toFixed(1)}s`,
      "",
    ];
    const estimated: string[] = [];
    for (const scene of vo.scenes) {
      const est = script.scenes.find((x) => x.id === scene.id)?.estimatedDurationSec;
      const exact = scene.cues.filter((c) => c.match === "exact").length;
      lines.push(
        `${scene.id}  ${scene.durationSec.toFixed(1)}s` +
          (est ? ` (script estimate ${est}s)` : "") +
          `  cues timed: ${exact}/${scene.cues.length}`,
      );
      for (const c of scene.cues.filter((c) => c.match === "estimated")) {
        estimated.push(`${scene.id}: "${c.cue}" placed at about ${c.startSec.toFixed(1)}s`);
      }
    }
    if (estimated.length) {
      lines.push("", "Cues not found in the spoken words, so their timing is estimated:", ...estimated.map((e) => `  ${e}`));
    }
    lines.push(
      "",
      `Listen: ${voicePaths(ctx).full}  (each scene is also in ${voicePaths(ctx).dir})`,
      "To change things, edit then choose [e]: voice or pace for this video in brief.json,",
      "base speed and pauses in pipeline.config.json, respellings in pronunciations.json, wording in script.json.",
      "Or choose [r] and describe wording changes; the Scriptwriter edits only those scenes.",
    );
    return lines.join("\n");
  },

  async validate(ctx) {
    const problems: string[] = [];
    const script = await validateScript(ctx);
    if (!script.ok) problems.push(...script.errors);
    try {
      await loadPronunciations(ctx.config);
      await voiceSettings(ctx);
    } catch (err) {
      problems.push((err as Error).message);
    }
    if (existsSync(voicePaths(ctx).json)) {
      const vo = await validateJsonFile(voicePaths(ctx).json, VoiceoverSchema);
      if (!vo.ok) problems.push(...vo.errors.map((e) => `voiceover.json ${e}`));
    }
    return problems;
  },
};

async function readJsonSafe<T>(file: string): Promise<T | undefined> {
  try {
    return await readJson<T>(file);
  } catch {
    return undefined;
  }
}
