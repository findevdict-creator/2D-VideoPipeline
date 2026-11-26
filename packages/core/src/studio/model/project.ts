import { z } from "zod";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a hex colour like #1A2B3C");

/** The look every scene shares. Scenes read it through useTheme(). */
export const ThemeSchema = z.object({
  visualStyle: z.string().default("Clean flat vector explainer with soft shapes and clear labels"),
  palette: z
    .object({
      background: hexColor,
      surface: hexColor,
      primary: hexColor,
      secondary: hexColor,
      accent: hexColor,
      text: hexColor,
    })
    .default({
      background: "#0F172A",
      surface: "#1E293B",
      primary: "#38BDF8",
      secondary: "#A78BFA",
      accent: "#FBBF24",
      text: "#F8FAFC",
    }),
  fontFamily: z.string().default("Inter"),
  iconStyle: z.string().default("Rounded line icons, 2px stroke"),
});
export type Theme = z.infer<typeof ThemeSchema>;

export const ASPECTS = ["16:9", "9:16", "1:1"] as const;
export const MAX_DURATION_SEC = 3600;

export const PROJECT_STAGES = ["outline", "bible", "foundation", "chapters", "scenes", "assembly", "done"] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

/** Per-project settings. Defaults come from pipeline.config.json when the project is created. */
export const ProjectSettingsSchema = z.object({
  voice: z
    .object({
      kokoroVoice: z.string().default("af_heart"),
      pace: z.enum(["slow", "normal", "fast"]).default("normal"),
    })
    .prefault({}),
  theme: ThemeSchema.prefault({}),
  tone: z.string().default("Friendly, curious and clear"),
  audience: z.string().default("Curious general viewers"),
  captions: z.boolean().default(true),
  music: z.object({ assetId: z.string().nullable().default(null), volume: z.number().min(0).max(1).default(0.12) }).prefault({}),
  /** Which scene types the planner may choose from. */
  sceneTypes: z.array(z.string()).default(["remotion-2d", "illustration", "footage"]),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const NewProjectSchema = z.object({
  title: z.string().min(2).max(120).optional(),
  description: z.string().min(10, "Describe the video in at least a sentence"),
  aspect: z.enum(ASPECTS).default("16:9"),
  targetDurationSec: z.number().int().min(10).max(MAX_DURATION_SEC).default(180),
  fps: z.number().int().min(12).max(60).optional(),
  settings: ProjectSettingsSchema.partial().optional(),
});
export type NewProject = z.input<typeof NewProjectSchema>;
