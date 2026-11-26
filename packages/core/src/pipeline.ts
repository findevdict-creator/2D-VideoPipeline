import type { Approver } from "./approval.js";
import type { StageContext } from "./context.js";
import type { Stage } from "./stages/index.js";

export type PipelineOutcome = "complete" | "paused";

/**
 * Runs the stages in order. Each stage's agents produce files, then you review them.
 * Approved stages are skipped on later runs, so a run can stop at any point
 * (by choice or by an error) and resume where it left off.
 */
export async function runPipeline(ctx: StageContext, stages: Stage[], approver: Approver): Promise<PipelineOutcome> {
  const { production } = ctx;

  for (const stage of stages) {
    const state = production.stage(stage.id);
    if (state.status === "approved") continue;

    if (state.status !== "awaiting_approval") {
      ctx.log(`\n■ ${stage.title}`);
      state.status = "in_progress";
      await production.save();
      await stage.produce(ctx, state.humanNotes.at(-1));
      state.status = "awaiting_approval";
      await production.save();
    }

    for (;;) {
      const decision = await approver.review({
        stageTitle: stage.title,
        revision: state.revision,
        summary: await stage.summarize(ctx),
        files: stage.outputs(ctx),
      });

      if (decision.decision === "approve") {
        state.status = "approved";
        state.approvedAt = new Date().toISOString();
        await production.save();
        ctx.log(`✓ ${stage.title} approved`);
        break;
      }

      if (decision.decision === "quit") {
        ctx.log(`Paused. Resume with: npm run pipeline -- run ${production.id}`);
        return "paused";
      }

      if (decision.decision === "edited") {
        const problems = await stage.validate(ctx);
        if (problems.length) {
          ctx.log(`Your edits have problems:\n  - ${problems.join("\n  - ")}\nFix them, or ask the agents to.`);
        } else if (stage.afterEdit) {
          await stage.afterEdit(ctx);
        }
        continue;
      }

      // Revision requested: keep the old version, then send your notes to the agents.
      await production.archive(stage.id, stage.archiveFiles?.(ctx) ?? stage.outputs(ctx));
      state.revision += 1;
      state.humanNotes.push(decision.notes);
      state.status = "in_progress";
      await production.save();
      ctx.log(`\n■ ${stage.title}, revision ${state.revision}`);
      await stage.produce(ctx, decision.notes);
      state.status = "awaiting_approval";
      await production.save();
    }
  }

  const last = stages.at(-1);
  ctx.log(`\nAll stages approved.${last ? ` Latest output: ${last.outputs(ctx).join(", ")}` : ""}`);
  return "complete";
}
