import { STORYBOARD_ARTIST } from "../agents/definitions.js";
import { runAgentForFile } from "../agents/runAgent.js";
import type { StageContext } from "../context.js";
import { StoryboardSchema, schemaForPrompt } from "../schemas.js";
import { directorReviewLoop, formatDirectorNotes } from "./directorReview.js";
import { files, latestDirectorNotes, readJson, validateStoryboard, type Storyboard } from "./files.js";
import type { Stage } from "./types.js";

async function drawStoryboard(ctx: StageContext, changes?: { from: string; notes: string }) {
  const f = files(ctx);
  const task = changes
    ? `Revise the storyboard at ${f.storyboard}.
Read ${f.brief}, ${f.script} and the current ${f.storyboard} first.
The ${changes.from} asked for these changes:
${changes.notes}

Apply the changes and write the updated storyboard back to ${f.storyboard}.`
    : `Create the storyboard for this explainer video.
Read the approved brief at ${f.brief} and the approved script at ${f.script} first.
Write the storyboard to ${f.storyboard}.`;

  await runAgentForFile(
    ctx,
    STORYBOARD_ARTIST,
    `${task}

storyboard.json must be JSON matching this JSON Schema:
${schemaForPrompt(StoryboardSchema)}`,
    f.storyboard,
    () => validateStoryboard(ctx),
  );
}

export const storyboardStage: Stage = {
  id: "storyboard",
  title: "Storyboard",

  outputs: (ctx) => [files(ctx).storyboard],

  async produce(ctx, notes) {
    const f = files(ctx);
    await drawStoryboard(ctx, notes ? { from: "human producer", notes } : undefined);

    await directorReviewLoop(ctx, {
      stage: "storyboard",
      reviewTask: `Review the storyboard at ${f.storyboard}.
Read ${f.brief} and ${f.script} first.
Check: does each scene make its narration easier to understand? Is the style consistent and readable?
Is each scene simple enough to build as flat 2D vector animation in code, and are the animation cues well chosen?`,
      revise: (dn) => drawStoryboard(ctx, { from: "Director", notes: formatDirectorNotes(dn) }),
    });
  },

  async summarize(ctx) {
    const board = await readJson<Storyboard>(files(ctx).storyboard);
    const p = board.styleGuide.palette;
    const lines = [
      `Style: ${board.styleGuide.visualStyle}. Font: ${board.styleGuide.fontFamily}. Icons: ${board.styleGuide.iconStyle}`,
      `Palette: bg ${p.background}, primary ${p.primary}, secondary ${p.secondary}, accent ${p.accent}, text ${p.text}`,
      "",
      ...board.scenes.map((s) =>
        [
          `${s.id}  ${s.visualDescription}`,
          `     ${s.elements.length} elements, transition ${s.transitionIn}, camera ${s.camera}`,
          ...s.animations.map((a) => `     on "${a.cue}": ${a.elementId} ${a.action}`),
          ...(s.onScreenText.length ? [`     text: ${s.onScreenText.join(" | ")}`] : []),
        ].join("\n"),
      ),
    ];
    const director = await latestDirectorNotes(ctx, "storyboard");
    if (director) {
      lines.push("", `Director (round ${director.round}): ${director.notes.verdict}. ${director.notes.summary}`);
      if (director.notes.verdict === "revise") lines.push("Open notes:", formatDirectorNotes(director.notes));
    }
    return lines.join("\n");
  },

  async validate(ctx) {
    const r = await validateStoryboard(ctx);
    return r.ok ? [] : r.errors;
  },
};
