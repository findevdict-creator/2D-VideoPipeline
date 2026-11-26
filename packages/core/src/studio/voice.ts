import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSpeechEngine, type SpeechItem } from "../voice/engine.js";
import { applyPronunciations, findCueTiming, kokoroLanguage, loadPronunciations, type Pronunciations, type TimedWord } from "../voice/text.js";
import { newId, nowIso } from "./ids.js";
import type { Cue } from "./model/scene.js";
import type { Studio } from "./studio.js";
import { fromRow } from "./store/mapping.js";
import { getProject, projectPaths, type Project } from "./store/projects.js";
import { currentVersion, getScene, sceneNarration, updateVersion, type Scene } from "./store/scenes.js";

export interface VoiceTrack {
  id: string;
  sceneId: string;
  textHash: string;
  settingsHash: string;
  spokenText: string;
  /** Relative to the project folder. */
  audioPath: string;
  durationSec: number;
  speechStartSec: number;
  speechEndSec: number;
  words: TimedWord[];
  createdAt: string;
}

export interface CueFrames {
  id: string;
  phrase: string;
  action: string;
  startFrame: number;
  endFrame: number;
  startSec: number;
  match: "exact" | "estimated";
}

const sha = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** The voice for a project: its own voice and pace on top of pipeline.config.json. */
export function voiceSettings(studio: Studio, project: Project) {
  const v = studio.config.voice;
  const voice = project.settings.voice.kokoroVoice || v.voice;
  return {
    engine: v.engine,
    voice,
    language: kokoroLanguage(v.language, voice),
    speed: Math.round(v.speed * v.paceSpeed[project.settings.voice.pace] * 1000) / 1000,
    padBeforeSec: v.padBeforeSec,
    padAfterSec: v.padAfterSec,
    sampleRate: v.sampleRate,
  };
}

export function getVoiceTrack(studio: Studio, id: string): VoiceTrack | undefined {
  return fromRow<VoiceTrack>(studio.db.get("SELECT * FROM voice_tracks WHERE id = ?", [id]));
}

/**
 * Record the narration of these scenes, reusing audio whose text and voice settings have
 * not changed. All missing scenes are spoken in one Kokoro run, because loading the model
 * is the slow part. Each scene's current version is pointed at its track.
 */
export async function ensureVoice(studio: Studio, sceneIds: string[], log: (m: string) => void = () => {}): Promise<Map<string, VoiceTrack>> {
  const out = new Map<string, VoiceTrack>();
  if (!sceneIds.length) return out;
  const scenes = sceneIds.map((id) => getScene(studio, id));
  const project = getProject(studio, scenes[0]!.projectId);
  const p = projectPaths(studio, project);
  const settings = voiceSettings(studio, project);
  const settingsHash = sha(settings);
  const pronunciations = await loadPronunciations(studio.config);

  const missing: { scene: Scene; spokenText: string; textHash: string; file: string }[] = [];
  for (const scene of scenes) {
    const spokenText = applyPronunciations(sceneNarration(studio, scene), pronunciations);
    const textHash = sha(spokenText);
    const found = fromRow<VoiceTrack>(
      studio.db.get("SELECT * FROM voice_tracks WHERE scene_id = ? AND text_hash = ? AND settings_hash = ?", [scene.id, textHash, settingsHash]),
    );
    if (found && fs.existsSync(p.abs(found.audioPath))) out.set(scene.id, found);
    else missing.push({ scene, spokenText, textHash, file: path.join(p.voice(scene.id), `${textHash}-${settingsHash}.wav`) });
  }

  if (missing.length) {
    log(`Recording narration for ${missing.length} scene(s) with ${settings.voice}${settings.engine === "mock" ? " (mock voice: silent audio)" : ""}`);
    const items: SpeechItem[] = missing.map((m) => ({
      id: m.scene.id,
      text: m.spokenText,
      voice: settings.voice,
      lang: settings.language,
      speed: settings.speed,
      padBeforeSec: settings.padBeforeSec,
      padAfterSec: settings.padAfterSec,
      outFile: m.file,
    }));
    for (const m of missing) fs.mkdirSync(path.dirname(m.file), { recursive: true });
    const result = await createSpeechEngine(studio.config).speak({ sampleRate: settings.sampleRate, items }, log);
    for (const m of missing) {
      const spoken = result.items.find((r) => r.id === m.scene.id);
      if (!spoken) throw new Error(`No audio came back for scene ${m.scene.id}`);
      const id = newId("vt");
      studio.db.run(
        `INSERT INTO voice_tracks (id, scene_id, text_hash, settings_hash, spoken_text, audio_path, duration_sec, speech_start_sec, speech_end_sec, words_json, created_at)
         VALUES (:id, :scene, :text, :settings, :spoken, :path, :dur, :start, :end, :words, :stamp)
         ON CONFLICT (scene_id, text_hash, settings_hash) DO UPDATE SET audio_path = excluded.audio_path, duration_sec = excluded.duration_sec,
           speech_start_sec = excluded.speech_start_sec, speech_end_sec = excluded.speech_end_sec, words_json = excluded.words_json`,
        {
          id,
          scene: m.scene.id,
          text: m.textHash,
          settings: settingsHash,
          spoken: m.spokenText,
          path: p.rel(m.file),
          dur: spoken.durationSec,
          start: spoken.speechStartSec,
          end: spoken.speechEndSec,
          words: JSON.stringify(spoken.words),
          stamp: nowIso(),
        },
      );
      out.set(
        m.scene.id,
        fromRow<VoiceTrack>(studio.db.get("SELECT * FROM voice_tracks WHERE scene_id = ? AND text_hash = ? AND settings_hash = ?", [m.scene.id, m.textHash, settingsHash]))!,
      );
    }
  }

  for (const scene of scenes) {
    const track = out.get(scene.id)!;
    const version = currentVersion(studio, getScene(studio, scene.id));
    const frames = framesOf(track.durationSec, project.fps);
    if (version && (version.voiceTrackId !== track.id || version.durationFrames !== frames)) {
      updateVersion(studio, version.id, { voiceTrackId: track.id, durationFrames: frames });
    }
  }
  if (missing.length) studio.emit("voice.changed", { projectId: project.id });
  return out;
}

export const framesOf = (seconds: number, fps: number) => Math.max(1, Math.round(seconds * fps));

/** When each cue phrase is spoken, in frames from the scene's start. */
export function cueFrames(cues: Cue[], track: VoiceTrack, fps: number, pronunciations: Pronunciations): CueFrames[] {
  const speech = { startSec: track.speechStartSec, endSec: track.speechEndSec };
  return cues.map((cue) => {
    const t = findCueTiming(cue.phrase, track.spokenText, track.words, speech, pronunciations);
    return {
      id: cue.id,
      phrase: cue.phrase,
      action: cue.action,
      startFrame: Math.round(t.startSec * fps),
      endFrame: Math.round(t.endSec * fps),
      startSec: t.startSec,
      match: t.match,
    };
  });
}
