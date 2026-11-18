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

const FileConfigSchema = z.object({
  runner: z.enum(["claude-cli", "agent-sdk", "mock"]).optional(),
  model: z.string().optional(),
  productionsDir: z.string().optional(),
  maxDirectorRounds: z.number().int().min(1).max(5).optional(),
  voice: VoiceConfigSchema.partial().optional(),
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
}

export type ConfigOverrides = Partial<Omit<PipelineConfig, "voice">> & { voice?: Partial<VoiceConfig> };

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
