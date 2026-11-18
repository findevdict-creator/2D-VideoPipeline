import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { PRODUCER } from "../agents/definitions.js";
import { runAgentForFile } from "../agents/runAgent.js";
import type { StageContext } from "../context.js";
import { BriefSchema, schemaForPrompt } from "../schemas.js";
import { files, readJson, validateBrief, type Brief } from "./files.js";
import type { Stage } from "./types.js";

export const briefStage: Stage = {
  id: "brief",
  title: "Brief",

  outputs: (ctx) => [files(ctx).brief],

  async produce(ctx, notes) {
    const f = files(ctx);
    const inputs = existsSync(f.inputs) ? await fs.readdir(f.inputs) : [];
    const inputsLine = inputs.length
      ? `The client also supplied these files in ${f.inputs}: ${inputs.join(", ")}. Note in visualStyleHints how they could be used.`
      : "The client supplied no extra files.";

    const task = notes
      ? `Revise the creative brief at ${f.brief}.
The client's original request is in ${f.prompt}. Read both files first.
The human producer asked for these changes:
${notes}

Apply the changes and write the updated brief back to ${f.brief}.`
      : `Write the creative brief for a new explainer video.
The client's request is in ${f.prompt}. Read it first.
${inputsLine}

Write the brief to ${f.brief}.`;

    await runAgentForFile(
      ctx,
      PRODUCER,
      `${task}

The default Kokoro voice is ${ctx.config.voice.voice} at normal pace.

The brief must be JSON matching this JSON Schema:
${schemaForPrompt(BriefSchema)}`,
      f.brief,
      () => validateBrief(ctx),
    );
  },

  async summarize(ctx) {
    const b = await readJson<Brief>(files(ctx).brief);
    return [
      `Title: ${b.title}`,
      `Topic: ${b.topic}`,
      `Audience: ${b.audience}`,
      `Goal: ${b.goal}`,
      `Tone: ${b.tone}`,
      `Length: ${b.targetDurationSec}s, ${b.aspectRatio}. Voice: ${b.voice.kokoroVoice} (${b.voice.pace})`,
      `Key takeaways:\n${b.keyTakeaways.map((t) => `  - ${t}`).join("\n")}`,
      `Must cover: ${b.mustCover.join("; ")}`,
      `Out of scope: ${b.outOfScope.join("; ") || "none"}`,
      `Visual style: ${b.visualStyleHints}`,
    ].join("\n");
  },

  async validate(ctx) {
    const r = await validateBrief(ctx);
    return r.ok ? [] : r.errors;
  },
};
