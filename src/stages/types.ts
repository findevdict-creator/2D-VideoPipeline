import type { StageContext } from "../context.js";
import type { StageId } from "../production.js";

export interface Stage {
  id: StageId;
  title: string;
  /** Files you review for this stage, and that are saved to history/ before a revision. */
  outputs(ctx: StageContext): string[];
  /** Run the agents. `notes` are your revision notes, when you asked for changes. */
  produce(ctx: StageContext, notes?: string): Promise<void>;
  /** A short text summary shown at the approval prompt. */
  summarize(ctx: StageContext): Promise<string>;
  /** Re-check the files, for example after you edited them by hand. Returns problems found. */
  validate(ctx: StageContext): Promise<string[]>;
  /** Files saved to history/ before a revision, when they differ from `outputs`. */
  archiveFiles?(ctx: StageContext): string[];
  /** Runs after you edit files by hand and they pass `validate`, for stages that rebuild from them. */
  afterEdit?(ctx: StageContext): Promise<void>;
}
