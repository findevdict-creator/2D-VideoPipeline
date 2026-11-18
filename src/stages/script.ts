import { existsSync } from "node:fs";
import { RESEARCHER, SCRIPTWRITER } from "../agents/definitions.js";
import { runAgentForFile } from "../agents/runAgent.js";
import type { StageContext } from "../context.js";
import { ScriptSchema, schemaForPrompt } from "../schemas.js";
import { directorReviewLoop, formatDirectorNotes } from "./directorReview.js";
import {
  estimateSpokenSeconds,
  files,
  latestDirectorNotes,
  readJson,
  validateResearch,
  validateScript,
  type Brief,
  type Script,
} from "./files.js";
import type { Stage } from "./types.js";

const scriptFormat = () => `script.json must be JSON matching this JSON Schema:
${schemaForPrompt(ScriptSchema)}`;

async function research(ctx: StageContext) {
  const f = files(ctx);
  await runAgentForFile(
    ctx,
    RESEARCHER,
    `Research the facts for this explainer video.
Read the approved brief at ${f.brief} first.
Write your fact sheet in Markdown to ${f.research}.
Cover everything in the brief's mustCover and keyTakeaways. Cite a source URL for every fact.`,
    f.research,
    () => validateResearch(ctx),
  );
}

async function writeScript(ctx: StageContext, changes?: { from: string; notes: string }) {
  const f = files(ctx);
  const task = changes
    ? `Revise the narration script at ${f.script}.
Read ${f.brief}, ${f.research} and the current ${f.script} first.
The ${changes.from} asked for these changes:
${changes.notes}

Apply the changes and write the updated script back to ${f.script}.`
    : `Write the narration script for this explainer video.
Read the approved brief at ${f.brief} and the fact sheet at ${f.research} first.
Write the script to ${f.script}.`;

  await runAgentForFile(ctx, SCRIPTWRITER, `${task}\n\n${scriptFormat()}`, f.script, () => validateScript(ctx));
}

export const scriptStage: Stage = {
  id: "script",
  title: "Research and script",

  outputs: (ctx) => [files(ctx).research, files(ctx).script],

  async produce(ctx, notes) {
    const f = files(ctx);
    if (!existsSync(f.research)) await research(ctx);
    await writeScript(ctx, notes ? { from: "human producer", notes } : undefined);

    await directorReviewLoop(ctx, {
      stage: "script",
      reviewTask: `Review the narration script at ${f.script}.
Read ${f.brief} and ${f.research} first.
Check: does it deliver every key takeaway, in the brief's tone, within 10 percent of the target length?
Is it accurate to the research, easy to follow when heard once, and possible to show as flat 2D animation?`,
      revise: (dn) => writeScript(ctx, { from: "Director", notes: formatDirectorNotes(dn) }),
    });
  },

  async summarize(ctx) {
    const f = files(ctx);
    const brief = await readJson<Brief>(f.brief);
    const script = await readJson<Script>(f.script);
    const total = script.scenes.reduce((sum, s) => sum + estimateSpokenSeconds(s.narration), 0);
    const offTarget = Math.abs(total - brief.targetDurationSec) > brief.targetDurationSec * 0.15;
    const lines = [
      `Title: ${script.title}`,
      `Estimated length: ${total}s spoken (target ${brief.targetDurationSec}s), ${script.scenes.length} scenes` +
        (offTarget ? "  ⚠ more than 15% off target" : ""),
      "",
      ...script.scenes.map(
        (s) => `${s.id}  ${s.title}  (~${estimateSpokenSeconds(s.narration)}s)\n     "${s.narration}"`,
      ),
    ];
    const director = await latestDirectorNotes(ctx, "script");
    if (director) {
      lines.push("", `Director (round ${director.round}): ${director.notes.verdict}. ${director.notes.summary}`);
      if (director.notes.verdict === "revise") lines.push("Open notes:", formatDirectorNotes(director.notes));
    }
    return lines.join("\n");
  },

  async validate(ctx) {
    const [r, s] = await Promise.all([validateResearch(ctx), validateScript(ctx)]);
    return [...(r.ok ? [] : r.errors), ...(s.ok ? [] : s.errors)];
  },
};
