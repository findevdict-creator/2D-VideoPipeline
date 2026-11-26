/**
 * The pipeline's Remotion library. Scenes import everything from "@pipeline/lib".
 * See packages/lib/README.md for how to use it.
 */
export { useAsset, useCueFrame, useCues, useScene, useTheme, useVideoData } from "./context";
export { useAppear, useBetween, useCueAppear, useLoop, enter, mix } from "./motion";
export { Arrow, Background, Canvas, Dot, DrawPath, Icon, Label, PulseRings, Ring, Title } from "./primitives";
export { ICON_NAMES } from "./icons";
export { CharacterSheet, defineCharacter } from "./character";
export type { Character, CharacterProps, CharacterSpec, CharacterState } from "./character";
export { Captions } from "./captions";
export { ExplainerVideo, SingleScene } from "./Video";
export { makeRoot } from "./Root";
export type * from "./types";
export { makeSceneRoot, SceneClip } from "./studio/SceneClip";
export { Overlays } from "./studio/Overlays";
export { HandDrawn } from "./studio/HandDrawn";
export { IllustrationScene } from "./studio/IllustrationScene";
export { FootageScene } from "./studio/FootageScene";
