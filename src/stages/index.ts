import { briefStage } from "./brief.js";
import { scriptStage } from "./script.js";
import { storyboardStage } from "./storyboard.js";
import type { Stage } from "./types.js";
import { voiceoverStage } from "./voiceover.js";

/** Pre-production stages, in order. */
export const PREPRODUCTION_STAGES: Stage[] = [briefStage, scriptStage, storyboardStage];

/** Every stage the pipeline runs, in order. Animation and render will be added after voiceover. */
export const PIPELINE_STAGES: Stage[] = [...PREPRODUCTION_STAGES, voiceoverStage];

export type { Stage } from "./types.js";
