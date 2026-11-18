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
}
