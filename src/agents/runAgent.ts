import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { StageContext } from "../context.js";
import type { AgentDefinition } from "./definitions.js";

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * Runs an agent whose job is to write one file, then validates that file.
 * If the file is missing or invalid, the agent is sent the errors and asked to fix it.
 */
export async function runAgentForFile<T>(
  ctx: StageContext,
  agent: AgentDefinition,
  task: string,
  outputFile: string,
  validate: () => Promise<Validation<T>>,
): Promise<T> {
  let prompt = task;
  for (let attempt = 0; ; attempt++) {
    const before = await mtime(outputFile);
    await runAgent(ctx, agent, prompt, [outputFile]);
    const after = await mtime(outputFile);

    const result: Validation<T> =
      after === undefined || after === before
        ? { ok: false, errors: [`You did not write ${outputFile}. Write the file at exactly that path.`] }
        : await validate();
    if (result.ok) return result.value;

    if (attempt >= ctx.config.maxFixAttempts) {
      throw new Error(
        `${agent.title} could not produce a valid ${path.basename(outputFile)}:\n  - ${result.errors.join("\n  - ")}`,
      );
    }
    ctx.log(`  ${agent.title}'s ${path.basename(outputFile)} has problems, asking for a fix (${result.errors.length})`);
    prompt = `${task}

Your previous attempt at ${outputFile} has these problems:
${result.errors.map((e) => `- ${e}`).join("\n")}

Fix the file so it resolves every problem above. Keep everything else that was good.`;
  }
}

export async function runAgent(ctx: StageContext, agent: AgentDefinition, prompt: string, expectedOutputs: string[]) {
  ctx.log(`▸ ${agent.title} is working...`);
  const started = Date.now();
  const result = await ctx.runner.run({
    agent: agent.name,
    systemPrompt: agent.systemPrompt,
    prompt,
    cwd: ctx.production.dir,
    tools: agent.tools,
    expectedOutputs,
    model: ctx.config.model,
  });
  await ctx.production.logAgentRun({
    agent: agent.name,
    prompt,
    result: result.text,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  });
  const secs = Math.round((Date.now() - started) / 1000);
  const cost = result.costUsd ? `, ~$${result.costUsd.toFixed(2)}` : "";
  ctx.log(`✓ ${agent.title} done (${secs}s${cost})${result.text ? `: ${oneLine(result.text)}` : ""}`);
  return result;
}

/** Parse a JSON file and check it against a schema, plus optional cross-file checks. */
export async function validateJsonFile<S extends z.ZodType>(
  file: string,
  schema: S,
  extraChecks?: (value: z.infer<S>) => string[] | Promise<string[]>,
): Promise<Validation<z.infer<S>>> {
  if (!existsSync(file)) return { ok: false, errors: [`${file} does not exist`] };
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    return { ok: false, errors: [`${path.basename(file)} is not valid JSON: ${(err as Error).message}`] };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const extra = extraChecks ? await extraChecks(parsed.data) : [];
  return extra.length ? { ok: false, errors: extra } : { ok: true, value: parsed.data };
}

async function mtime(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

function oneLine(text: string, max = 140) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
