import React, { createContext, useContext } from "react";
import type { AssetData, CueTiming, Palette, SceneData, VideoData } from "./types";

const VideoContext = createContext<VideoData | null>(null);
const SceneContext = createContext<SceneData | null>(null);

export const VideoProvider: React.FC<{ data: VideoData; children: React.ReactNode }> = ({ data, children }) => (
  <VideoContext.Provider value={data}>{children}</VideoContext.Provider>
);

export const SceneProvider: React.FC<{ scene: SceneData; children: React.ReactNode }> = ({ scene, children }) => (
  <SceneContext.Provider value={scene}>{children}</SceneContext.Provider>
);

export function useVideoData(): VideoData {
  const data = useContext(VideoContext);
  if (!data) throw new Error("useVideoData must be used inside the pipeline's video");
  return data;
}

/** This scene's storyboard, narration and timings. */
export function useScene(): SceneData {
  const scene = useContext(SceneContext);
  if (!scene) throw new Error("useScene must be used inside a scene");
  return scene;
}

/** The video's style guide: palette, font, and helpers. */
export function useTheme() {
  const { style, width, height, captionSafeArea } = useVideoData();
  const fontFamily = `${JSON.stringify(style.fontFamily)}, Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  /** A palette key ("primary") or any CSS colour. */
  const color = (c: keyof Palette | string) => (c in style.palette ? style.palette[c as keyof Palette] : c);
  /** The area that is safe to draw in: 5% margins, and room for captions at the bottom. */
  const safe = {
    left: Math.round(width * 0.05),
    right: Math.round(width * 0.95),
    top: Math.round(height * 0.06),
    bottom: Math.round(height * (1 - Math.max(0.06, captionSafeArea))),
  };
  return { ...style, fontFamily, color, width, height, safe };
}

/** Every cue for an element in this scene, in order. */
export function useCues(elementId: string): CueTiming[] {
  return useScene().cues.filter((c) => c.elementId === elementId);
}

/**
 * The frame (within this scene) where the narrator starts saying the cue phrase
 * for an element. `which` picks the 2nd, 3rd... cue when an element has several.
 */
export function useCueFrame(elementId: string, which = 0): number {
  const scene = useScene();
  const cues = scene.cues.filter((c) => c.elementId === elementId);
  const cue = cues[which];
  if (!cue) {
    const known = [...new Set(scene.cues.map((c) => c.elementId))].join(", ") || "none";
    throw new Error(
      `Scene ${scene.id} has no cue #${which} for element "${elementId}". Elements with cues: ${known}`,
    );
  }
  return cue.startFrame;
}

/**
 * One of the project's files, by its asset id, with the URL to load it from.
 * The scene's spec must list the id under "assets".
 */
export function useAsset(assetId: string): AssetData & { url: string } {
  const scene = useScene();
  const { assetBase } = useVideoData();
  const asset = scene.assets?.[assetId];
  if (!asset) {
    const listed = Object.keys(scene.assets ?? {}).join(", ") || "none";
    throw new Error(`Asset "${assetId}" is not listed under "assets" in this scene's spec. Listed: ${listed}. Add its id to the spec with scene_save_spec.`);
  }
  const url = /^(https?:|data:|blob:)/.test(asset.src) || !assetBase ? asset.src : `${assetBase.replace(/\/$/, "")}/${asset.src.replace(/^\//, "")}`;
  return { ...asset, url };
}
