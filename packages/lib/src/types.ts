/**
 * The data a video is built from. The pipeline writes it to
 * productions/<id>/render/video-data.json from the storyboard, the voiceover
 * timings and pipeline.config.json. All times are in frames.
 */

export interface Palette {
  background: string;
  surface: string;
  primary: string;
  secondary: string;
  accent: string;
  text: string;
}

export interface StyleGuide {
  visualStyle: string;
  palette: Palette;
  fontFamily: string;
  iconStyle: string;
  /** Studio: "hand-drawn" gives everything a scene draws a slight wobble. Left out means "clean". */
  look?: "clean" | "hand-drawn";
}

export interface CueTiming {
  /** The storyboard element this cue animates. */
  elementId: string;
  /** The narration phrase that triggers it. */
  cue: string;
  /** What should happen, from the storyboard. */
  action: string;
  /** Frame within the scene where the phrase starts and ends being spoken. */
  startFrame: number;
  endFrame: number;
  match: "exact" | "estimated";
}

export interface TimedWord {
  text: string;
  startFrame: number;
  endFrame: number;
}

export interface SceneData {
  id: string;
  title: string;
  narration: string;
  layout: string;
  visualDescription: string;
  elements: { id: string; kind: string; description: string }[];
  onScreenText: string[];
  transitionIn: "cut" | "fade" | "slide" | "zoom" | "wipe";
  camera: "static" | "slow-zoom-in" | "slow-zoom-out" | "pan";
  /** Where this scene starts in the full video. */
  startFrame: number;
  durationInFrames: number;
  /** Frames within the scene where narration starts and ends (after the pause). */
  speechStartFrame: number;
  speechEndFrame: number;
  /** Audio file relative to the public folder, or null. */
  audio: string | null;
  cues: CueTiming[];
  words: TimedWord[];
  /** Studio scenes: "code" is a component an agent wrote; the others are drawn from data. */
  kind?: "code" | "illustration" | "footage";
  /** Labels, arrows, callouts and text cards drawn on top of the scene. */
  overlays?: OverlayData[];
  illustration?: IllustrationData;
  footage?: FootageData;
  /** Studio code scenes: the project files the scene's spec lists under "assets", by asset id. */
  assets?: Record<string, AssetData>;
}

/** A project file a code scene loads: an image, a clip or a 3D model. */
export interface AssetData {
  /** File URL, or a path relative to VideoData.assetBase. */
  src: string;
  kind: string;
  label: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  /** For 3D models: what the file holds, in the model's own units. */
  model?: {
    size: [number, number, number];
    center: [number, number, number];
    parts: string[];
    animations: { name: string; durationSec: number }[];
  };
}

interface OverlayTiming {
  startFrame: number;
  /** Null keeps it to the end of the scene. */
  endFrame: number | null;
  color?: string;
}

/** Positions are fractions of the frame: 0,0 is the top left corner. */
export type OverlayData =
  | (OverlayTiming & { kind: "label"; text: string; x: number; y: number; box: boolean; size?: number })
  | (OverlayTiming & { kind: "arrow"; from: [number, number]; to: [number, number] })
  | (OverlayTiming & { kind: "callout"; text: string; x: number; y: number; target: [number, number] })
  | (OverlayTiming & { kind: "text-card"; title: string; body?: string });

export interface FocusData {
  /** The point of the image the camera centres on, as fractions of the image. */
  x: number;
  y: number;
  /** 1 fills the frame; 2 shows half the image's width. */
  zoom: number;
}

export interface ShotData {
  /** Image URL, or a path relative to VideoData.assetBase. */
  src: string;
  /** The image's size in pixels. */
  width: number;
  height: number;
  startFrame: number;
  endFrame: number;
  fit: "cover" | "contain";
  from: FocusData;
  to: FocusData | null;
}

export interface IllustrationData {
  /** A palette key or CSS colour behind images that do not fill the frame. */
  background: string;
  shots: ShotData[];
}

export interface FootageData {
  /** Video URL, or a path relative to VideoData.assetBase. */
  src: string;
  /** Where in the source the clip starts, in frames at the video's fps. */
  trimBeforeFrames: number;
  /** 1 is normal speed; below 1 is slow motion. */
  playbackRate: number;
  /** How many frames of the scene the source covers at that speed. */
  coveredFrames: number;
  /** What happens after the source runs out. */
  after: "hold" | "loop";
  objectFit: "cover" | "contain";
}

export interface CaptionToken {
  text: string;
  startFrame: number;
  endFrame: number;
}

export interface CaptionPage {
  startFrame: number;
  endFrame: number;
  tokens: CaptionToken[];
}

export interface VideoData {
  title: string;
  fps: number;
  width: number;
  height: number;
  style: StyleGuide;
  /** Length of each scene's entrance transition. */
  transitionFrames: number;
  /** Fraction of the height kept clear at the bottom for captions (0 when captions are off). */
  captionSafeArea: number;
  scenes: SceneData[];
  captions: {
    enabled: boolean;
    fontSize: number;
    position: "bottom" | "top";
    /** A palette key such as "accent", or a hex colour. */
    highlight: string;
    pages: CaptionPage[];
  };
  music: { src: string | null; volume: number };
  /** Studio renders: the URL that asset paths are relative to. */
  assetBase?: string;
  /** Studio exports: a finished scene clip placed in a frame of another shape, with its captions laid out again. */
  reframe?: ReframeData;
}

/** A rectangle in the frame, in pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReframeData {
  /** The scene's clip, without captions. */
  src: string;
  /** Where the whole picture of the clip is drawn. It may reach past the sides of the frame, which crops it. */
  picture: Box;
  /** Where captions go and how large they are. Null when the video has none. */
  captions: (Box & { fontSize: number }) | null;
}
