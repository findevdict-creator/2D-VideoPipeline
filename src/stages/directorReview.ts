import { DIRECTOR } from "../agents/definitions.js";
import { runAgentForFile } from "../agents/runAgent.js";
import type { StageContext } from "../context.js";
import { DirectorNotesSchema, schemaForPrompt, type DirectorNotes } from "../schemas.js";
import { files, validateDirectorNotes } from "./files.js";

/**
 * The Director reviews a piece of work and either approves it or sends notes
 * back to its author. Runs up to `maxDirectorRounds` reviews, then the work goes
 * to you either way, with any notes still open shown in the summary.
 */
export async function directorReviewLoop(
  ctx: StageContext,
  opts: {
    stage: "script" | "storyboard";
    /** What to review and what to check, without the output instructions. */
    reviewTask: string;
    /** Send the Director's notes back to the author for a revision. */
    revise: (notes: DirectorNotes) => Promise<void>;
  },
): Promise<DirectorNotes | undefined> {
  const max = ctx.config.maxDirectorRounds;
  let last: DirectorNotes | undefined;
  for (let round = 1; round <= max; round++) {
    const file = files(ctx).directorNotes(opts.stage, ctx.production.stage(opts.stage).revision, round);
    const task = `${opts.reviewTask}

This is review round ${round} of ${max}.
Write your review as JSON to ${file}, matching this JSON Schema:
${schemaForPrompt(DirectorNotesSchema)}`;
    last = await runAgentForFile(ctx, DIRECTOR, task, file, () => validateDirectorNotes(file));
    if (last.verdict === "approve") {
      ctx.log(`  Director approved the ${opts.stage}: ${last.summary}`);
      return last;
    }
    ctx.log(`  Director asked for changes (${last.notes.length} notes): ${last.summary}`);
    if (round < max) await opts.revise(last);
  }
  return last;
}

export function formatDirectorNotes(notes: DirectorNotes) {
  return notes.notes
    .map((n) => `- ${n.sceneId ? `[${n.sceneId}] ` : ""}${n.issue}. Suggestion: ${n.suggestion}`)
    .join("\n");
}
