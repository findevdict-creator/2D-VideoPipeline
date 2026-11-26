import type { VideoData } from "@pipeline/lib/types";
import type { SceneType } from "../model/scene.js";
import type { Studio } from "../studio.js";
import type { ClipQuality } from "../store/clips.js";
import type { Project } from "../store/projects.js";
import type { Scene, SceneVersion } from "../store/scenes.js";
import type { VoiceTrack } from "../voice.js";

/** Everything a renderer needs to know about one scene version. */
export interface RenderContext {
  studio: Studio;
  project: Project;
  scene: Scene;
  version: SceneVersion;
  track: VoiceTrack;
  /** The scene as the Remotion library sees it: one scene, timed in frames. */
  data: VideoData;
  /** Full path of the scene's code file, for scene types that have one. */
  sourceFile: string | null;
  /** A scratch folder for this scene's bundles and generated files. */
  workDir: string;
  log: (message: string) => void;
}

export interface QualitySettings {
  quality: ClipQuality;
  scale: number;
  crf: number;
}

export interface ClipResult {
  file: string;
  durationFrames: number;
  width: number;
  height: number;
}

/**
 * One way of turning a scene into a clip. Every scene type has one, and every one
 * produces the same thing: a silent MP4 of exactly the scene's length at the project's
 * size and frame rate, plus still frames for review.
 */
export interface Renderer {
  readonly type: SceneType;
  /** Changes when the renderer would draw the same input differently, so old clips are not reused. */
  readonly revision: string;
  /**
   * Why scenes of this type cannot be built on this machine, or null when they can.
   * Renderers that need nothing extra installed leave it out.
   */
  unavailable?(studio: Studio): string | null;
  /**
   * Problems that would stop a render: rule breaks, type errors, missing files. Does not render.
   * Things worth knowing that do not stop it are added to `notes`.
   */
  check(ctx: RenderContext, notes?: string[]): Promise<string[]>;
  /** Render still frames into `outDir`. Returns their paths, one per frame, in order. */
  stills(ctx: RenderContext, frames: number[], outDir: string, scale: number): Promise<string[]>;
  render(ctx: RenderContext, q: QualitySettings, output: string, onProgress: (progress: number) => void): Promise<ClipResult>;
  /** What, besides the scene data, decides how the clip looks: for example the code's hash. */
  cacheInputs(ctx: RenderContext): Promise<unknown>;
}
