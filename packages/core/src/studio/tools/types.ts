import type { z } from "zod";
import type { Studio } from "../studio.js";
import type { AgentRun, RunKind } from "../store/runs.js";

export interface ToolContext {
  studio: Studio;
  projectId: string;
  /** The run the caller belongs to. Without one, only tools that read are allowed. */
  run?: AgentRun;
  log: (message: string) => void;
}

/** What a tool hands back: data for the agent, and optionally pictures to look at. */
export interface ToolOutput {
  [key: string]: unknown;
  images?: { file: string; caption: string }[];
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** Kinds of run that may call the tool. Left out: any caller, because the tool only reads. */
  writers?: RunKind[];
  handler: (ctx: ToolContext, input: z.infer<S>) => Promise<ToolOutput> | ToolOutput;
}

/** A refusal the agent should read and act on, as opposed to a crash. */
export class ToolRefusal extends Error {}

export const defineTool = <S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> => def;
