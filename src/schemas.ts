import { z } from "zod";

/**
 * File formats that the pre-production agents write into the production folder.
 * These are the contracts between stages: each agent reads the earlier files and
 * writes its own, and the pipeline validates every file before you review it.
 */

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a hex colour like #1A2B3C");
const sceneId = z.string().regex(/^s\d{2}$/, "scene ids look like s01, s02, ...");

export const BriefSchema = z.object({
  title: z.string().min(3).describe("Working title of the video"),
  topic: z.string().min(3).describe("The subject in one sentence"),
  audience: z.string().describe("Who the video is for and what they already know"),
  goal: z.string().describe("What the viewer should understand after watching"),
  tone: z.string().describe("For example: friendly and curious, calm and precise"),
  targetDurationSec: z.number().int().min(30).max(600),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  keyTakeaways: z.array(z.string()).min(2).max(6),
  mustCover: z.array(z.string()).describe("Points the video has to include"),
  outOfScope: z.array(z.string()).describe("Things to leave out to keep it focused"),
  visualStyleHints: z.string().describe("Look and feel for the animation"),
  voice: z.object({
    kokoroVoice: z.string().describe("Kokoro voice id, for example af_heart or am_michael"),
    pace: z.enum(["slow", "normal", "fast"]),
  }),
});
export type Brief = z.infer<typeof BriefSchema>;

export const ScriptSchema = z.object({
  title: z.string(),
  scenes: z
    .array(
      z.object({
        id: sceneId,
        title: z.string(),
        purpose: z.string().describe("What this scene does for the viewer"),
        narration: z.string().min(10).describe("Exactly what the narrator says, written to be spoken"),
        estimatedDurationSec: z.number().positive(),
        sources: z.array(z.string()).describe("URLs from research.md backing the facts in this scene"),
      }),
    )
    .min(2),
});
export type Script = z.infer<typeof ScriptSchema>;

export const DirectorNotesSchema = z.object({
  verdict: z.enum(["approve", "revise"]),
  summary: z.string(),
  notes: z.array(
    z.object({
      sceneId: z.string().optional(),
      issue: z.string(),
      suggestion: z.string(),
    }),
  ),
});
export type DirectorNotes = z.infer<typeof DirectorNotesSchema>;

export const StoryboardSchema = z.object({
  styleGuide: z.object({
    visualStyle: z.string(),
    palette: z.object({
      background: hexColor,
      surface: hexColor,
      primary: hexColor,
      secondary: hexColor,
      accent: hexColor,
      text: hexColor,
    }),
    fontFamily: z.string(),
    iconStyle: z.string(),
  }),
  scenes: z
    .array(
      z.object({
        id: sceneId.describe("Must match a scene id in script.json"),
        layout: z.string().describe("Where things sit on screen"),
        visualDescription: z.string().describe("What the viewer sees, in plain words"),
        elements: z
          .array(
            z.object({
              id: z.string(),
              kind: z.enum(["diagram", "icon", "text", "shape", "arrow", "chart", "map", "label", "image"]),
              description: z.string(),
            }),
          )
          .min(1),
        animations: z.array(
          z.object({
            elementId: z.string(),
            action: z.string().describe("For example: draws in, pulses, moves along path"),
            cue: z.string().describe("A short phrase copied word for word from this scene's narration"),
          }),
        ),
        onScreenText: z.array(z.string()),
        transitionIn: z.enum(["cut", "fade", "slide", "zoom", "wipe"]),
        camera: z.enum(["static", "slow-zoom-in", "slow-zoom-out", "pan"]),
      }),
    )
    .min(2),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

/** JSON Schema text for embedding in agent prompts, so prompts and validation never drift. */
export function schemaForPrompt(schema: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(schema), null, 2);
}
