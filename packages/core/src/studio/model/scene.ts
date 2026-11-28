import { z } from "zod";
import { SOUNDS } from "../sound/builtin.js";

export const SCENE_TYPES = ["remotion-2d", "r3f", "manim", "illustration", "footage"] as const;
export type SceneType = (typeof SCENE_TYPES)[number];

/** Types whose source is a code file the agent writes. The others are data only. */
export const CODE_SCENE_TYPES: SceneType[] = ["remotion-2d", "r3f", "manim"];

export const SCENE_STATUSES = [
  "planned", // in the scene list, no spec yet
  "spec_ready", // spec written and valid
  "in_production", // an agent is writing or fixing it
  "rendered", // clip and stills exist
  "needs_review", // the agent marked it ready for you
  "approved", // you approved this version
  "stale", // approved, but something it depends on changed
  "failed", // checks or renders keep failing
] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, "use a short id such as pin or signalPath");
const unit = z.number().min(0).max(1);

/** When something happens: on a cue phrase, or at a time in seconds from the scene's start. */
const When = z
  .object({ cue: id.optional(), sec: z.number().min(0).optional() })
  .refine((w) => (w.cue === undefined) !== (w.sec === undefined), "give exactly one of cue or sec");

export const CueSchema = z.object({
  id: id.describe("Scene code looks the cue up by this id, for example useCueFrame(\"pin\")"),
  phrase: z.string().min(1).describe("A short phrase copied word for word from this scene's narration"),
  action: z.string().default("").describe("What happens on screen when the phrase is spoken"),
});
export type Cue = z.infer<typeof CueSchema>;

const overlayBase = {
  at: When.optional().describe("When it appears. Leave out to show it from the start"),
  untilSec: z.number().positive().optional().describe("When it disappears. Leave out to keep it to the end"),
  color: z.string().optional().describe("A palette key such as accent, or a hex colour"),
};

/** Things drawn on top of any scene type. Positions are fractions of the frame: 0,0 is top left. */
export const OverlaySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("label"), text: z.string().min(1).max(80), x: unit, y: unit, box: z.boolean().default(true), size: z.number().min(20).max(160).optional(), ...overlayBase }),
  z.object({ kind: z.literal("arrow"), from: z.tuple([unit, unit]), to: z.tuple([unit, unit]), ...overlayBase }),
  z.object({
    kind: z.literal("callout"),
    text: z.string().min(1).max(80),
    x: unit,
    y: unit,
    target: z.tuple([unit, unit]).describe("The point the callout's line points at"),
    ...overlayBase,
  }),
  z.object({ kind: z.literal("text-card"), title: z.string().min(1).max(80), body: z.string().max(200).optional(), ...overlayBase }),
]);
export type Overlay = z.infer<typeof OverlaySchema>;

const VisualSchema = z.object({
  description: z.string().min(5).describe("What the viewer sees, in plain words"),
  layout: z.string().default("").describe("Where things sit on screen"),
  elements: z
    .array(z.object({ id, kind: z.string(), description: z.string() }))
    .default([])
    .describe("The things on screen, for code scenes"),
  onScreenText: z.array(z.string()).default([]),
  camera: z.enum(["static", "slow-zoom-in", "slow-zoom-out", "pan"]).default("static"),
  transitionIn: z.enum(["cut", "fade", "slide", "zoom", "wipe"]).default("fade"),
});

const base = {
  title: z.string().min(1).max(120),
  purpose: z.string().default("").describe("What this scene does for the viewer"),
  narration: z.string().min(3).describe("Exactly what the narrator says. Its recording sets the scene's length"),
  visual: VisualSchema,
  cues: z.array(CueSchema).default([]),
  sfx: z
    .array(
      z
        .object({
          sound: z.enum(SOUNDS).optional().describe("One of the studio's own sounds"),
          assetId: z.string().optional().describe("Or a sound file of the project, by its asset id"),
          at: When.describe("When it is heard: on a cue, so it lands with the picture, or at a time in seconds"),
          volume: z.number().min(0).max(1).default(0.6),
        })
        .refine((s) => (s.sound === undefined) !== (s.assetId === undefined), "give exactly one of sound or assetId"),
    )
    .max(12)
    .default([])
    .describe("Sound effects. Few, and each tied to something that happens on screen"),
  references: z
    .array(z.object({ assetId: z.string(), role: z.enum(["style", "layout", "motion"]), note: z.string().default("") }))
    .default([]),
  uses: z.array(z.object({ name: z.string(), version: z.number().int().positive() })).default([]).describe("Shared assets this scene is built on"),
  overlays: z.array(OverlaySchema).default([]),
  assets: z
    .array(z.string())
    .default([])
    .describe("Ids of project files the scene's code loads: 3D models for <Model>, images for textures. Illustration and footage scenes name their files in their own fields instead"),
};

/** A point of interest in an image and how far the camera is zoomed in on it. */
const Focus = z.object({
  x: unit.default(0.5),
  y: unit.default(0.5),
  zoom: z.number().min(1).max(8).default(1).describe("1 shows as much of the image as fills the frame"),
});

export const IllustrationSchema = z.object({
  background: z.string().default("background").describe("Colour behind images that do not fill the frame"),
  shots: z
    .array(
      z.object({
        assetId: z.string(),
        at: When.optional().describe("When this image takes over. The first shot starts the scene"),
        fit: z.enum(["cover", "contain"]).default("cover"),
        from: Focus.prefault({}),
        to: Focus.optional().describe("Where the camera ends up by the end of the shot. Leave out for a still camera"),
      }),
    )
    .min(1),
});

export const FootageSchema = z.object({
  assetId: z.string(),
  inSec: z.number().min(0).default(0),
  outSec: z.number().positive().optional().describe("Leave out to use the clip to its end"),
  /** What to do when the clip is shorter than the narration. Longer clips are always trimmed. */
  fit: z.enum(["trim", "slow", "hold", "loop"]).default("slow"),
  minSpeed: z.number().min(0.25).max(1).default(0.7).describe("The slowest the clip may be played"),
  objectFit: z.enum(["cover", "contain"]).default("cover"),
});

export const SceneSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("remotion-2d"), ...base }),
  z.object({ type: z.literal("r3f"), ...base }),
  z.object({ type: z.literal("manim"), ...base }),
  z.object({ type: z.literal("illustration"), ...base, illustration: IllustrationSchema }),
  z.object({ type: z.literal("footage"), ...base, footage: FootageSchema }),
]);
export type SceneSpec = z.infer<typeof SceneSpecSchema>;
export type SceneSpecInput = z.input<typeof SceneSpecSchema>;

/** The first idea of a scene, from the scene list: enough to plan with, not enough to build. */
export const ScenePlanSchema = z.object({
  title: z.string().min(1).max(120),
  type: z.enum(SCENE_TYPES),
  purpose: z.string().default(""),
  narration: z.string().min(3),
  visualIdea: z.string().default("").describe("One or two sentences on what the viewer sees"),
  /** The pages of the project's documents this scene's facts come from, when it has any. */
  sources: z
    .array(z.object({ assetId: z.string(), page: z.number().int().min(1), note: z.string().max(200).optional().describe("What was taken from the page, such as the figure quoted") }))
    .max(6)
    .optional()
    .describe("Where this scene's facts come from: pages of the documents project_get lists"),
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;
export type ScenePlanInput = z.input<typeof ScenePlanSchema>;

const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();

/** Checks a schema cannot express. Asset checks need the database and live in scenes/validate.ts. */
export function checkSpec(spec: SceneSpec): string[] {
  const problems: string[] = [];
  const narration = normalise(spec.narration);
  const seen = new Set<string>();
  for (const cue of spec.cues) {
    if (seen.has(cue.id)) problems.push(`cues: the id "${cue.id}" is used twice`);
    seen.add(cue.id);
    if (!narration.includes(normalise(cue.phrase))) {
      problems.push(`cues.${cue.id}: "${cue.phrase}" is not a word-for-word phrase from the narration`);
    }
  }
  const whens: { where: string; at?: { cue?: string; sec?: number } }[] = [
    ...spec.overlays.map((o, i) => ({ where: `overlays.${i}`, at: o.at })),
    ...spec.sfx.map((s, i) => ({ where: `sfx.${i}`, at: s.at })),
    ...(spec.type === "illustration" ? spec.illustration.shots.map((s, i) => ({ where: `illustration.shots.${i}`, at: s.at })) : []),
  ];
  for (const w of whens) {
    if (w.at?.cue && !seen.has(w.at.cue)) problems.push(`${w.where}: there is no cue with the id "${w.at.cue}"`);
  }
  if (spec.type === "footage" && spec.footage.outSec !== undefined && spec.footage.outSec <= spec.footage.inSec) {
    problems.push("footage: outSec must be after inSec");
  }
  return problems;
}

/** Parse and check a spec. Returns the spec with defaults filled in, or the problems. */
export function parseSpec(raw: unknown): { ok: true; spec: SceneSpec } | { ok: false; problems: string[] } {
  const parsed = SceneSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const problems = checkSpec(parsed.data);
  return problems.length ? { ok: false, problems } : { ok: true, spec: parsed.data };
}
