import { briefStage } from "./brief.js";
import { scriptStage } from "./script.js";
import { storyboardStage } from "./storyboard.js";
import type { Stage } from "./types.js";

/** Pre-production stages, in order. Later phases (voiceover, animation, render) will be added here. */
export const PREPRODUCTION_STAGES: Stage[] = [briefStage, scriptStage, storyboardStage];

export type { Stage } from "./types.js";
