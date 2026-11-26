import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PipelineConfig } from "./config.js";

export const STAGE_IDS = ["brief", "script", "storyboard", "voiceover", "animation", "render"] as const;
export type StageId = (typeof STAGE_IDS)[number];

export type StageStatus = "pending" | "in_progress" | "awaiting_approval" | "approved";

export interface StageState {
  status: StageStatus;
  /** Starts at 1 and goes up each time you ask for a revision. */
  revision: number;
  /** Your revision notes, oldest first. */
  humanNotes: string[];
  approvedAt?: string;
}

export interface ProductionState {
  id: string;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  stages: Record<StageId, StageState>;
  totalCostUsd: number;
  agentRuns: number;
}

/**
 * One video's folder. Every agent reads and writes files here, and you review
 * the same files at each approval.
 *
 *   productions/<id>/
 *     prompt.md            your original prompt
 *     inputs/              your images and reference files (used in later phases)
 *     brief.json           Producer
 *     research.md          Researcher
 *     script.json          Scriptwriter
 *     storyboard.json      Storyboard artist
 *     director-notes/      Director reviews, one file per round
 *     voice/               Kokoro audio: one file per scene, plus full.wav
 *     voiceover.json       real scene lengths, word timings and cue timings
 *     scenes/              Animator: one Remotion component per scene (sNN.tsx)
 *     render/              generated Remotion project, test frames and preview.mp4
 *     final/               the finished video and its subtitles
 *     history/             earlier versions, saved before each revision
 *     logs/                one record per agent run
 *     state.json           which stages are approved
 */
export class Production {
  private constructor(
    readonly dir: string,
    public state: ProductionState,
  ) {}

  get id() {
    return this.state.id;
  }

  path(...parts: string[]) {
    return path.join(this.dir, ...parts);
  }

  static async create(config: PipelineConfig, prompt: string, now = new Date()): Promise<Production> {
    const base = `${now.toISOString().slice(0, 10)}-${slugify(prompt)}`;
    let id = base;
    for (let n = 2; existsSync(path.join(config.productionsDir, id)); n++) id = `${base}-${n}`;

    const dir = path.join(config.productionsDir, id);
    await fs.mkdir(path.join(dir, "inputs"), { recursive: true });
    await fs.mkdir(path.join(dir, "director-notes"), { recursive: true });
    await fs.mkdir(path.join(dir, "logs"), { recursive: true });
    await fs.writeFile(path.join(dir, "prompt.md"), prompt.trim() + "\n");

    const stamp = now.toISOString();
    const fresh = (): StageState => ({ status: "pending", revision: 1, humanNotes: [] });
    const stages = Object.fromEntries(STAGE_IDS.map((id) => [id, fresh()])) as Record<StageId, StageState>;
    const production = new Production(dir, {
      id,
      createdAt: stamp,
      updatedAt: stamp,
      prompt: prompt.trim(),
      stages,
      totalCostUsd: 0,
      agentRuns: 0,
    });
    await production.save();
    return production;
  }

  static async load(config: PipelineConfig, id: string): Promise<Production> {
    const dir = path.join(config.productionsDir, id);
    const file = path.join(dir, "state.json");
    if (!existsSync(file)) throw new Error(`No production called "${id}" in ${config.productionsDir}`);
    const state: ProductionState = JSON.parse(await fs.readFile(file, "utf8"));
    // Productions made before a stage existed get that stage added as pending.
    for (const stage of STAGE_IDS) state.stages[stage] ??= { status: "pending", revision: 1, humanNotes: [] };
    return new Production(dir, state);
  }

  static async list(config: PipelineConfig): Promise<ProductionState[]> {
    if (!existsSync(config.productionsDir)) return [];
    const ids = await fs.readdir(config.productionsDir);
    const states: ProductionState[] = [];
    for (const id of ids.sort()) {
      const file = path.join(config.productionsDir, id, "state.json");
      if (existsSync(file)) states.push(JSON.parse(await fs.readFile(file, "utf8")));
    }
    return states;
  }

  async save() {
    this.state.updatedAt = new Date().toISOString();
    await fs.writeFile(this.path("state.json"), JSON.stringify(this.state, null, 2) + "\n");
  }

  stage(id: StageId) {
    return this.state.stages[id];
  }

  /** Copy the current files of a stage into history/ before they are revised. */
  async archive(stageId: StageId, files: string[]) {
    const dest = this.path("history", stageId, `rev-${this.stage(stageId).revision}`);
    await fs.mkdir(dest, { recursive: true });
    for (const file of files) {
      if (existsSync(file)) await fs.copyFile(file, path.join(dest, path.basename(file)));
    }
  }

  async logAgentRun(entry: { agent: string; prompt: string; result: string; costUsd?: number; durationMs?: number }) {
    this.state.agentRuns += 1;
    this.state.totalCostUsd += entry.costUsd ?? 0;
    const name = `${String(this.state.agentRuns).padStart(3, "0")}-${entry.agent}.json`;
    await fs.writeFile(
      this.path("logs", name),
      JSON.stringify({ at: new Date().toISOString(), ...entry }, null, 2) + "\n",
    );
    await this.save();
  }
}

export function slugify(text: string, maxWords = 6): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join("-");
  return slug || "video";
}
