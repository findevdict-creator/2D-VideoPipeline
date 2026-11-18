import { animationStage } from "./animation.js";
import { briefStage } from "./brief.js";
import { renderStage } from "./render.js";
import { scriptStage } from "./script.js";
import { storyboardStage } from "./storyboard.js";
import type { Stage } from "./types.js";
import { voiceoverStage } from "./voiceover.js";

/** Pre-production stages, in order. */
export const PREPRODUCTION_STAGES: Stage[] = [briefStage, scriptStage, storyboardStage];

/** Every stage the pipeline runs, in order. */
export const PIPELINE_STAGES: Stage[] = [...PREPRODUCTION_STAGES, voiceoverStage, animationStage, renderStage];

export type { Stage } from "./types.js";
