import { z } from "zod";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a hex colour like #1A2B3C");

export const LOOKS = ["clean", "hand-drawn"] as const;

/** The six colours of a video, and what each is for. */
export const PALETTE_KEYS = ["background", "surface", "primary", "secondary", "accent", "text"] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];
export type Palette = Record<PaletteKey, string>;
export const PALETTE_USE: Record<PaletteKey, string> = {
  background: "Behind everything",
  surface: "Cards and panels",
  primary: "The main colour of what is drawn",
  secondary: "A second colour, for contrast with the main one",
  accent: "Highlights, and the word being spoken",
  text: "Titles and labels",
};

/** Ready-made colour schemes, each with strong contrast between text and background. */
export const PALETTES: { id: string; name: string; palette: Palette }[] = [
  { id: "midnight", name: "Midnight", palette: { background: "#0F172A", surface: "#1E293B", primary: "#38BDF8", secondary: "#A78BFA", accent: "#FBBF24", text: "#F8FAFC" } },
  { id: "paper", name: "Paper", palette: { background: "#FAF7F0", surface: "#FFFFFF", primary: "#2563EB", secondary: "#0F766E", accent: "#DC2626", text: "#1F2937" } },
  { id: "chalkboard", name: "Chalkboard", palette: { background: "#1F3A2E", surface: "#2A4D3D", primary: "#FDE68A", secondary: "#93C5FD", accent: "#FCA5A5", text: "#F7F7F2" } },
  { id: "sunset", name: "Sunset", palette: { background: "#2B1330", surface: "#45203F", primary: "#FF8A5B", secondary: "#F9C74F", accent: "#FF4D8D", text: "#FFF5EC" } },
  { id: "forest", name: "Forest", palette: { background: "#0E2A20", surface: "#173D2F", primary: "#6EE7B7", secondary: "#FCD34D", accent: "#FB923C", text: "#F0FDF4" } },
  { id: "mono", name: "Black and white", palette: { background: "#0A0A0A", surface: "#1C1C1C", primary: "#FFFFFF", secondary: "#A3A3A3", accent: "#FACC15", text: "#FAFAFA" } },
  { id: "pastel", name: "Pastel", palette: { background: "#FDF2F8", surface: "#FFFFFF", primary: "#7C3AED", secondary: "#DB2777", accent: "#0891B2", text: "#312E81" } },
  { id: "blueprint", name: "Blueprint", palette: { background: "#0B3C8C", surface: "#1450B4", primary: "#FFFFFF", secondary: "#9AD1FF", accent: "#FFD166", text: "#F4F9FF" } },
];

/** Fonts offered in the list. Any font installed on the computer that renders can be typed instead. */
export const FONTS = ["Inter", "Arial", "Segoe UI", "Verdana", "Trebuchet MS", "Georgia", "Times New Roman", "Courier New", "Comic Sans MS", "Impact"];

/**
 * How well two colours can be told apart, from 1 (the same) to 21 (black on white), as
 * WCAG defines it. Text needs about 4.5 against what is behind it.
 */
export function contrast(a: string, b: string): number {
  const light = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [light(a), light(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** What is hard to read in a palette, in plain sentences. Empty when it is fine. */
export function paletteWarnings(p: Palette): string[] {
  const out: string[] = [];
  if (contrast(p.text, p.background) < 4.5) out.push("The text colour is hard to read on the background.");
  if (contrast(p.text, p.surface) < 3) out.push("The text colour is hard to read on cards and panels.");
  for (const key of ["primary", "secondary", "accent"] as const) if (contrast(p[key], p.background) < 2) out.push(`The ${key} colour barely stands out from the background.`);
  return out;
}

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
  /** "hand-drawn" gives everything scenes draw a slight wobble that changes a few times a second. Real footage and Manim scenes keep their own look. */
  look: z.enum(LOOKS).default("clean"),
  /** True once the person has chosen the colours or the font themselves. Claude then keeps both and writes the bible around them. */
  locked: z.boolean().default(false),
});
export type Theme = z.infer<typeof ThemeSchema>;

export const ASPECTS = ["16:9", "9:16", "1:1"] as const;
export const MAX_DURATION_SEC = 3600;
/** The shortest video a project can be for. */
export const MIN_DURATION_SEC = 10;

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
  music: z
    .object({
      assetId: z.string().nullable().default(null),
      /** How loud the music is while the narrator speaks. */
      volume: z.number().min(0).max(1).default(0.12),
      /** Lower the music under the voice and bring it back up in pauses. Off: it stays at `volume` throughout. */
      duck: z.boolean().default(true),
      /** How loud the music is where nobody speaks, when `duck` is on. */
      gapVolume: z.number().min(0).max(1).default(0.4),
    })
    .prefault({}),
  /** Sound effects: the ones scenes name in their specs. Switching them off keeps them in the specs and leaves them out of the sound. */
  sfx: z.object({ enabled: z.boolean().default(true), volume: z.number().min(0).max(2).default(1) }).prefault({}),
  /** AI-generated images. Off unless the person allows it for this video, because each image costs money. */
  images: z.object({ enabled: z.boolean().default(false) }).prefault({}),
  /** Which scene types the planner may choose from. Types this machine cannot build are left out when it asks. */
  sceneTypes: z.array(z.string()).default(["remotion-2d", "r3f", "manim", "illustration", "footage"]),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const NewProjectSchema = z.object({
  title: z.string().min(2).max(120).optional(),
  description: z.string().min(10, "Describe the video in at least a sentence"),
  aspect: z.enum(ASPECTS).default("16:9"),
  targetDurationSec: z.number().int().min(MIN_DURATION_SEC, `A video is at least ${MIN_DURATION_SEC} seconds long`).max(MAX_DURATION_SEC, `A video is at most ${MAX_DURATION_SEC / 60} minutes long`).default(180),
  fps: z.number().int().min(12).max(60).optional(),
  settings: ProjectSettingsSchema.partial().optional(),
});
export type NewProject = z.input<typeof NewProjectSchema>;
