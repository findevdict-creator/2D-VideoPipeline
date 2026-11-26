import { createTikTokStyleCaptions, type Caption } from "@remotion/captions";
import type { CaptionPage, FootageData, OverlayData, SceneData, ShotData, VideoData } from "@pipeline/lib/types";
import { unRespell } from "../../render/project.js";
import type { Pronunciations } from "../../voice/text.js";
import type { SceneSpec } from "../model/scene.js";
import type { Studio } from "../studio.js";
import { getAsset } from "../store/assets.js";
import type { Project } from "../store/projects.js";
import type { Scene, SceneVersion } from "../store/scenes.js";
import { cueFrames, framesOf, type VoiceTrack } from "../voice.js";

/** Caption lines for one scene, in frames from the scene's start. */
export function captionPages(studio: Studio, track: VoiceTrack, fps: number, pronunciations: Pronunciations): CaptionPage[] {
  const captions: Caption[] = unRespell(track.words, pronunciations).map((w) => ({
    text: ` ${w.text}`,
    startMs: w.startSec * 1000,
    endMs: w.endSec * 1000,
    timestampMs: ((w.startSec + w.endSec) / 2) * 1000,
    confidence: null,
  }));
  const { pages } = createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: studio.config.render.captions.combineWithinMs });
  return pages.map((page) => ({
    startFrame: Math.round((page.startMs / 1000) * fps),
    endFrame: Math.round(((page.startMs + page.durationMs) / 1000) * fps),
    tokens: page.tokens.map((t) => ({ text: t.text, startFrame: Math.round((t.fromMs / 1000) * fps), endFrame: Math.round((t.toMs / 1000) * fps) })),
  }));
}

/**
 * Build what the Remotion library draws a scene from: the spec, the project's theme,
 * and the voice timings, all in frames. This object is also what the clip's cache key is
 * made from, so it holds nothing that changes between identical renders.
 */
export function buildSceneData(
  studio: Studio,
  project: Project,
  scene: Scene,
  version: SceneVersion,
  track: VoiceTrack,
  pronunciations: Pronunciations,
): VideoData {
  const spec = version.spec;
  const fps = project.fps;
  const rc = studio.config.render;
  const durationInFrames = framesOf(track.durationSec, fps);
  const toFrame = (sec: number) => Math.round(sec * fps);
  const cues = cueFrames(spec.cues, track, fps, pronunciations);
  const when = (at: { cue?: string; sec?: number } | undefined, fallback: number) => {
    if (at?.cue) return cues.find((c) => c.id === at.cue)?.startFrame ?? fallback;
    if (at?.sec !== undefined) return Math.min(durationInFrames - 1, toFrame(at.sec));
    return fallback;
  };

  const overlays: OverlayData[] = spec.overlays.map((o) => {
    const { at, untilSec, ...rest } = o;
    return { ...rest, startFrame: when(at, 0), endFrame: untilSec !== undefined ? Math.min(durationInFrames, toFrame(untilSec)) : null } as OverlayData;
  });

  const sceneData: SceneData = {
    id: scene.id,
    title: spec.title,
    narration: spec.narration,
    layout: spec.visual.layout,
    visualDescription: spec.visual.description,
    elements: spec.visual.elements,
    onScreenText: spec.visual.onScreenText,
    transitionIn: spec.visual.transitionIn,
    camera: spec.visual.camera,
    startFrame: 0,
    durationInFrames,
    speechStartFrame: toFrame(track.speechStartSec),
    speechEndFrame: toFrame(track.speechEndSec),
    audio: null,
    // "pin__2" is the second cue of "pin": scene code reads it as useCueFrame("pin", 1).
    cues: cues.map((c) => ({ elementId: c.id.replace(/__\d+$/, ""), cue: c.phrase, action: c.action, startFrame: c.startFrame, endFrame: c.endFrame, match: c.match })),
    words: track.words.map((w) => ({ text: w.text, startFrame: toFrame(w.startSec), endFrame: toFrame(w.endSec) })),
    kind: spec.type === "illustration" ? "illustration" : spec.type === "footage" ? "footage" : "code",
    overlays,
  };
  if (spec.type === "illustration") sceneData.illustration = illustrationData(studio, spec, durationInFrames, when);
  if (spec.type === "footage") sceneData.footage = footageData(studio, spec, durationInFrames, fps);

  const captionsOn = project.settings.captions && rc.captions.enabled;
  return {
    title: project.title,
    fps,
    width: project.width,
    height: project.height,
    style: project.settings.theme,
    transitionFrames: Math.round(rc.transitionSec * fps),
    captionSafeArea: captionsOn && rc.captions.position === "bottom" ? (rc.captions.fontSize * 2.6 + project.height * 0.05) / project.height : 0,
    scenes: [sceneData],
    captions: {
      enabled: captionsOn,
      fontSize: rc.captions.fontSize,
      position: rc.captions.position,
      highlight: rc.captions.highlight,
      pages: captionsOn ? captionPages(studio, track, fps, pronunciations) : [],
    },
    music: { src: null, volume: 0 },
  };
}

function illustrationData(
  studio: Studio,
  spec: Extract<SceneSpec, { type: "illustration" }>,
  durationInFrames: number,
  when: (at: { cue?: string; sec?: number } | undefined, fallback: number) => number,
) {
  const n = spec.illustration.shots.length;
  // A shot without a time of its own starts at its even share of the scene.
  const starts = spec.illustration.shots.map((s, i) => (i === 0 ? 0 : when(s.at, Math.round((durationInFrames * i) / n))));
  for (let i = 1; i < starts.length; i++) starts[i] = Math.max(starts[i]!, starts[i - 1]! + 1);
  const shots: ShotData[] = spec.illustration.shots.map((s, i) => {
    const asset = getAsset(studio, s.assetId);
    return {
      src: asset.path,
      width: asset.width ?? 1920,
      height: asset.height ?? 1080,
      startFrame: starts[i]!,
      endFrame: starts[i + 1] ?? durationInFrames,
      fit: s.fit,
      from: s.from,
      to: s.to ?? null,
    };
  });
  return { background: spec.illustration.background, shots };
}

/** Fit a clip to the scene: trim what is too long, then slow, hold or loop what is too short. */
export function fitFootage(
  f: { inSec: number; outSec?: number; fit: "trim" | "slow" | "hold" | "loop"; minSpeed: number },
  sourceSec: number | null,
  durationInFrames: number,
  fps: number,
): Pick<FootageData, "trimBeforeFrames" | "playbackRate" | "coveredFrames" | "after"> {
  const end = Math.min(f.outSec ?? Infinity, sourceSec ?? Infinity);
  const available = Number.isFinite(end) ? Math.max(0, end - f.inSec) : Infinity;
  const needed = durationInFrames / fps;
  const trimBeforeFrames = Math.round(f.inSec * fps);
  if (available >= needed) return { trimBeforeFrames, playbackRate: 1, coveredFrames: durationInFrames, after: "hold" };
  const playbackRate = f.fit === "slow" ? Math.min(1, Math.max(f.minSpeed, available / needed)) : 1;
  // Stop one frame short of the source's end, where decoders are least reliable.
  const coveredFrames = Math.max(1, Math.min(durationInFrames, Math.floor((available / playbackRate) * fps) - 1));
  return { trimBeforeFrames, playbackRate: Math.round(playbackRate * 1000) / 1000, coveredFrames, after: f.fit === "loop" ? "loop" : "hold" };
}

function footageData(studio: Studio, spec: Extract<SceneSpec, { type: "footage" }>, durationInFrames: number, fps: number): FootageData {
  const asset = getAsset(studio, spec.footage.assetId);
  return { src: asset.path, objectFit: spec.footage.objectFit, ...fitFootage(spec.footage, asset.durationSec, durationInFrames, fps) };
}
