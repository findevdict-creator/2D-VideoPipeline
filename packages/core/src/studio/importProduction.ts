import fs from "node:fs";
import path from "node:path";
import type { Brief, Script, Storyboard, Voiceover } from "../schemas.js";
import { BriefSchema, ScriptSchema, StoryboardSchema, VoiceoverSchema } from "../schemas.js";
import { applyPronunciations, loadPronunciations } from "../voice/text.js";
import { createHash } from "node:crypto";
import { newId, nowIso } from "./ids.js";
import type { SceneSpecInput } from "./model/scene.js";
import type { Studio } from "./studio.js";
import { addChapter } from "./store/chapters.js";
import { createProject, projectPaths, updateProject, type Project } from "./store/projects.js";
import { addScene, hashText, saveSpec, updateVersion, versionPaths } from "./store/scenes.js";
import { framesOf, voiceSettings } from "./voice.js";

const sha = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);

function readJson<T>(file: string, schema: { parse(raw: unknown): T }): T {
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
  return schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * Bring a production made by the stage pipeline into the studio as a project with one
 * chapter. Needs at least brief.json, script.json and storyboard.json. Scene code and
 * recorded narration come along when they exist.
 */
export async function importProduction(studio: Studio, productionDir: string): Promise<{ project: Project; scenes: number; withCode: number; withVoice: number }> {
  const dir = path.resolve(productionDir);
  const brief: Brief = readJson(path.join(dir, "brief.json"), BriefSchema);
  const script: Script = readJson(path.join(dir, "script.json"), ScriptSchema);
  const board: Storyboard = readJson(path.join(dir, "storyboard.json"), StoryboardSchema);
  const promptFile = path.join(dir, "prompt.md");
  const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8").trim() : brief.topic;

  let project = createProject(studio, {
    title: brief.title,
    description: prompt.length >= 10 ? prompt : `${brief.title}: ${brief.topic}`,
    aspect: brief.aspectRatio,
    targetDurationSec: Math.max(10, brief.targetDurationSec),
    settings: {
      voice: { kokoroVoice: brief.voice.kokoroVoice, pace: brief.voice.pace },
      theme: board.styleGuide,
      tone: brief.tone,
      audience: brief.audience,
    },
  });
  project = updateProject(studio, project.id, { stage: "scenes" });
  const p = projectPaths(studio, project);
  const chapter = addChapter(studio, project.id, { title: brief.title, goal: brief.goal, targetDurationSec: brief.targetDurationSec });

  const voiceFile = path.join(dir, "voiceover.json");
  const voiceover: Voiceover | undefined = fs.existsSync(voiceFile) ? readJson(voiceFile, VoiceoverSchema) : undefined;
  const settings = voiceSettings(studio, project);
  // Recorded audio is only reused when it was made with the settings the studio would use now.
  const sameVoice = !!voiceover && Object.entries(settings).every(([k, value]) => (voiceover.settings as Record<string, unknown>)[k] === value);
  const pronunciations = await loadPronunciations(studio.config);

  let withCode = 0;
  let withVoice = 0;
  for (const s of script.scenes) {
    const sb = board.scenes.find((b) => b.id === s.id);
    if (!sb) throw new Error(`Scene ${s.id} is in script.json but not in storyboard.json`);
    const scene = addScene(studio, chapter.id, { title: s.title, type: "remotion-2d", purpose: s.purpose, narration: s.narration, visualIdea: sb.visualDescription });

    // The pipeline let one element have several cues. Cue ids must be unique here, so later
    // cues become pin__2, pin__3; scene code still reads them as useCueFrame("pin", 1).
    const seen = new Map<string, number>();
    const spec: SceneSpecInput = {
      type: "remotion-2d",
      title: s.title,
      purpose: s.purpose,
      narration: s.narration,
      visual: {
        description: sb.visualDescription,
        layout: sb.layout,
        elements: sb.elements.map((e) => ({ ...e, id: safeId(e.id) })),
        onScreenText: sb.onScreenText,
        camera: sb.camera,
        transitionIn: sb.transitionIn,
      },
      cues: sb.animations.map((a) => {
        const n = (seen.get(a.elementId) ?? 0) + 1;
        seen.set(a.elementId, n);
        return { id: n === 1 ? safeId(a.elementId) : `${safeId(a.elementId)}__${n}`, phrase: a.cue, action: a.action };
      }),
    };
    const saved = saveSpec(studio, scene.id, spec, "import");
    if (!saved.ok) throw new Error(`Scene ${s.id} could not be imported:\n  - ${saved.problems.join("\n  - ")}`);
    const paths = versionPaths(studio, project, saved.version);

    const code = path.join(dir, "scenes", `${s.id}.tsx`);
    if (fs.existsSync(code) && paths.source) {
      fs.copyFileSync(code, paths.source);
      updateVersion(studio, saved.version.id, { sourceHash: hashText(fs.readFileSync(code, "utf8")) });
      withCode++;
    }

    const vo = voiceover?.scenes.find((v) => v.id === s.id);
    const audio = vo ? path.join(dir, ...vo.audioFile.split("/")) : undefined;
    const spokenText = applyPronunciations(s.narration, pronunciations);
    if (sameVoice && vo && audio && fs.existsSync(audio) && vo.spokenText === spokenText) {
      const textHash = sha(spokenText);
      const settingsHash = sha(settings);
      const target = path.join(p.voice(scene.id), `${textHash}-${settingsHash}.wav`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(audio, target);
      const id = newId("vt");
      studio.db.run(
        `INSERT INTO voice_tracks (id, scene_id, text_hash, settings_hash, spoken_text, audio_path, duration_sec, speech_start_sec, speech_end_sec, words_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, scene.id, textHash, settingsHash, spokenText, p.rel(target), vo.durationSec, vo.speechStartSec, vo.speechEndSec, JSON.stringify(vo.words), nowIso()],
      );
      updateVersion(studio, saved.version.id, { voiceTrackId: id, durationFrames: framesOf(vo.durationSec, project.fps) });
      withVoice++;
    }
  }
  return { project, scenes: script.scenes.length, withCode, withVoice };
}

function safeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^[^a-zA-Z]+/, "");
  return (cleaned || "item").slice(0, 40);
}
