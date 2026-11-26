import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type RunnerKind = "claude-cli" | "agent-sdk" | "mock";

/**
 * Voiceover settings. Defaults live here; pipeline.config.json overrides them.
 * The voice and pace in a video's brief.json override these for that one video.
 */
export const VoiceConfigSchema = z.object({
  /** "kokoro" makes real audio. "mock" writes silent audio with even word timings, for testing. */
  engine: z.enum(["kokoro", "mock"]).default("kokoro"),
  /** Default Kokoro voice. The Producer uses it unless your request asks for another. */
  voice: z.string().default("af_heart"),
  /** Base speaking speed. 1.0 is Kokoro's normal speed. */
  speed: z.number().min(0.5).max(2).default(1.0),
  /** The brief's pace multiplies the base speed by these values. */
  paceSpeed: z
    .object({ slow: z.number(), normal: z.number(), fast: z.number() })
    .default({ slow: 0.9, normal: 1.0, fast: 1.1 }),
  /**
   * Kokoro language. "auto" picks it from the voice name (af_/am_ are American English,
   * bf_/bm_ British). Also accepts en-us, en-gb, or a Kokoro language code such as "a".
   */
  language: z.string().default("auto"),
  /** Silence added before and after each scene's narration, in seconds. */
  padBeforeSec: z.number().min(0).max(5).default(0.3),
  padAfterSec: z.number().min(0).max(5).default(0.3),
  /** Sample rate of the audio files. Kokoro speaks at 24000; other rates are resampled. */
  sampleRate: z.number().int().min(8000).max(96000).default(24000),
  /** Words to respell so Kokoro says them right, relative to the repo root. */
  pronunciationsFile: z.string().default("pronunciations.json"),
  /** Where word timings come from. Only "kokoro" is available for now. */
  timing: z.enum(["kokoro"]).default("kokoro"),
  /** Python to run Kokoro with. Empty means: the one setup:voice installed, else python3 / python. */
  python: z.string().default(""),
  /** Voices rendered by the `voices` audition command. */
  auditionVoices: z
    .array(z.string())
    .default(["af_heart", "af_bella", "af_nicole", "am_michael", "am_fenrir", "bf_emma", "bm_george"]),
  auditionText: z
    .string()
    .default("Your phone knows where you are to within a few meters. Here is how GPS pulls it off."),
});
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

/** Animation and render settings. */
export const RenderConfigSchema = z.object({
  fps: z.number().int().min(12).max(60).default(30),
  /** The short side of the final video in pixels: 1080 gives 1920x1080 for 16:9, 1080x1920 for 9:16. */
  resolution: z.number().int().min(360).max(2160).default(1080),
  /** The preview is rendered at this fraction of full size. */
  previewScale: z.number().min(0.1).max(1).default(0.5),
  /** Test frames for the Animator and your review are rendered at this fraction of full size. */
  stillScale: z.number().min(0.1).max(1).default(0.5),
  codec: z.enum(["h264", "h265", "vp8", "vp9", "prores"]).default("h264"),
  /** Quality: lower is better and bigger. */
  crf: z.number().int().min(0).max(51).default(18),
  previewCrf: z.number().int().min(0).max(51).default(30),
  /** Frames rendered at once. Empty means Remotion's default (half your CPU threads, up to 8). */
  concurrency: z.number().int().min(1).nullable().default(null),
  /** Path to a Chrome or Chrome Headless Shell. Empty means Remotion downloads its own. */
  browserExecutable: z.string().default(""),
  /**
   * How Chrome draws 3D scenes. Empty tries your graphics card ("angle") and falls back to
   * software drawing ("swangle"), which is slower but works on any machine.
   */
  gl: z.enum(["angle", "swangle", "egl", "vulkan", "angle-egl"]).nullable().default(null),
  /** Length of each scene's entrance transition, in seconds. */
  transitionSec: z.number().min(0).max(2).default(0.4),
  /** Where final videos go, relative to the production folder. */
  outputDir: z.string().default("final"),
  captions: z
    .object({
      enabled: z.boolean().default(true),
      fontSize: z.number().int().min(16).max(160).default(54),
      position: z.enum(["bottom", "top"]).default("bottom"),
      /** Palette key or hex colour for the word being spoken. */
      highlight: z.string().default("accent"),
      /** Words spoken within this many milliseconds share a caption line. */
      combineWithinMs: z.number().int().min(200).max(5000).default(1200),
    })
    .prefault({}),
  music: z
    .object({
      /** An audio file (mp3, wav, m4a), relative to the repo root. Empty means no music. */
      file: z.string().default(""),
      volume: z.number().min(0).max(1).default(0.12),
    })
    .prefault({}),
});
export type RenderConfig = z.infer<typeof RenderConfigSchema>;

export const AnimatorConfigSchema = z.object({
  /** Check-and-fix rounds per scene after the first draft. */
  maxFixRounds: z.number().int().min(0).max(6).default(3),
  /** Test frames rendered per scene for each check. */
  stillsPerScene: z.number().int().min(1).max(8).default(3),
  /** Scenes animated at the same time. More is faster but uses your plan faster. */
  parallelScenes: z.number().int().min(1).max(8).default(1),
});
export type AnimatorConfig = z.infer<typeof AnimatorConfigSchema>;

/** Scene studio settings: where projects live and how much runs at once. */
export const StudioConfigSchema = z.object({
  /** Folder that holds studio.db and every project. "~" means your home folder. */
  workspace: z.string().default("~/VideoStudio"),
  /** How many of each kind of work run at the same time. */
  lanes: z
    .object({
      /** Claude runs. More is faster but uses your plan faster. */
      agents: z.number().int().min(1).max(8).default(3),
      /** Scene renders. Each one runs a browser, so memory is the limit. */
      renders: z.number().int().min(1).max(8).default(2),
      /** Voice, imports and other short jobs. */
      light: z.number().int().min(1).max(4).default(1),
    })
    .prefault({}),
  /** Check-and-fix rounds a scene agent gets before the scene is marked failed. */
  maxFixRounds: z.number().int().min(0).max(6).default(3),
  /** Models with more triangles than this get a warning when added: they render, but slowly. */
  modelTriangleBudget: z.number().int().min(1000).default(300_000),
  /** Port of the local GUI server. */
  port: z.number().int().min(1024).max(65535).default(4600),
});
export type StudioConfig = z.infer<typeof StudioConfigSchema>;

const FileConfigSchema = z.object({
  studio: z.record(z.string(), z.unknown()).optional(),
  runner: z.enum(["claude-cli", "agent-sdk", "mock"]).optional(),
  model: z.string().optional(),
  productionsDir: z.string().optional(),
  maxDirectorRounds: z.number().int().min(1).max(5).optional(),
  voice: VoiceConfigSchema.partial().optional(),
  render: z.record(z.string(), z.unknown()).optional(),
  animator: AnimatorConfigSchema.partial().optional(),
});

export interface PipelineConfig {
  /** How agents are run. claude-cli uses your Claude Code login; agent-sdk uses ANTHROPIC_API_KEY. */
  runner: RunnerKind;
  /** Model for every agent, for example "opus" (default) or "sonnet". */
  model?: string;
  /** Where production folders are created. */
  productionsDir: string;
  /** How many Director review rounds an agent gets before the work goes to you. */
  maxDirectorRounds: number;
  /** How many times an agent may retry when its file fails validation. */
  maxFixAttempts: number;
  /** Path to the claude executable for the claude-cli runner. */
  claudeBin: string;
  /** The repo root, where pipeline.config.json and pronunciations.json live. */
  rootDir: string;
  voice: VoiceConfig;
  render: RenderConfig;
  animator: AnimatorConfig;
  studio: StudioConfig;
}

export type ConfigOverrides = Partial<Omit<PipelineConfig, "voice" | "render" | "animator" | "studio">> & {
  studio?: Partial<StudioConfig>;
  voice?: Partial<VoiceConfig>;
  render?: Partial<RenderConfig>;
  animator?: Partial<AnimatorConfig>;
};

const RUNNERS: RunnerKind[] = ["claude-cli", "agent-sdk", "mock"];

/**
 * Settings come from, lowest to highest priority: built-in defaults,
 * pipeline.config.json (or the file in PIPELINE_CONFIG), environment variables,
 * then command-line flags.
 */
export function loadConfig(overrides: ConfigOverrides = {}): PipelineConfig {
  const rootDir = path.resolve(overrides.rootDir ?? ".");
  const configFile = path.resolve(rootDir, process.env.PIPELINE_CONFIG ?? "pipeline.config.json");
  const file = readConfigFile(configFile);

  const envRunner = process.env.PIPELINE_RUNNER as RunnerKind | undefined;
  const runner = overrides.runner ?? envRunner ?? file.runner ?? "claude-cli";
  if (!RUNNERS.includes(runner)) {
    throw new Error(`Unknown runner "${runner}". Use one of: ${RUNNERS.join(", ")}`);
  }

  const voice = VoiceConfigSchema.parse({
    ...file.voice,
    // The mock runner also fakes the voice, so the whole flow can be tried without Python.
    ...(runner === "mock" ? { engine: "mock" } : {}),
    ...(process.env.PIPELINE_PYTHON ? { python: process.env.PIPELINE_PYTHON } : {}),
    ...(process.env.PIPELINE_VOICE_ENGINE ? { engine: process.env.PIPELINE_VOICE_ENGINE } : {}),
    ...overrides.voice,
  });

  const render = RenderConfigSchema.parse({
    ...file.render,
    ...(process.env.REMOTION_BROWSER_EXECUTABLE ? { browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE } : {}),
    ...(process.env.REMOTION_GL ? { gl: process.env.REMOTION_GL } : {}),
    ...overrides.render,
  });
  const animator = AnimatorConfigSchema.parse({ ...file.animator, ...overrides.animator });
  const studio = StudioConfigSchema.parse({
    ...file.studio,
    ...(process.env.STUDIO_WORKSPACE ? { workspace: process.env.STUDIO_WORKSPACE } : {}),
    ...(process.env.STUDIO_PORT ? { port: Number(process.env.STUDIO_PORT) } : {}),
    ...overrides.studio,
  });

  return {
    runner,
    // Pinned so a Claude Code default that needs extra usage credits does not stop the run.
    model: overrides.model ?? process.env.PIPELINE_MODEL ?? file.model ?? "opus",
    productionsDir: path.resolve(
      rootDir,
      overrides.productionsDir ?? process.env.PIPELINE_PRODUCTIONS_DIR ?? file.productionsDir ?? "productions",
    ),
    maxDirectorRounds:
      overrides.maxDirectorRounds ?? Number(process.env.PIPELINE_DIRECTOR_ROUNDS ?? file.maxDirectorRounds ?? 2),
    maxFixAttempts: overrides.maxFixAttempts ?? 2,
    claudeBin: overrides.claudeBin ?? process.env.CLAUDE_BIN ?? "claude",
    rootDir,
    voice,
    render,
    animator,
    studio,
  };
}

function readConfigFile(file: string): z.infer<typeof FileConfigSchema> {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = FileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`${file} has invalid settings: ${issues}`);
  }
  return parsed.data;
}
