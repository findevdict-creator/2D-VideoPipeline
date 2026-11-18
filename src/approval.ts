import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

export type Decision =
  | { decision: "approve" }
  | { decision: "revise"; notes: string }
  | { decision: "edited" }
  | { decision: "quit" };

export interface ReviewRequest {
  stageTitle: string;
  revision: number;
  summary: string;
  files: string[];
}

export interface Approver {
  review(request: ReviewRequest): Promise<Decision>;
  close?(): void;
}

/**
 * Reads lines from the terminal one at a time. Buffers lines that arrive early
 * (for example when answers are piped in), which plain readline.question drops.
 */
class LineReader {
  private rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  private queued: string[] = [];
  private waiting: ((line: string | undefined) => void)[] = [];
  private closed = false;

  constructor() {
    this.rl.on("line", (line) => {
      const next = this.waiting.shift();
      if (next) next(line);
      else this.queued.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const w of this.waiting.splice(0)) w(undefined);
    });
  }

  question(prompt: string): Promise<string> {
    stdout.write(prompt);
    if (this.queued.length) return Promise.resolve(this.queued.shift()!);
    if (this.closed) return Promise.reject(new Error("Input ended before the review was answered"));
    return new Promise((resolve, reject) =>
      this.waiting.push((line) => (line === undefined ? reject(new Error("Input ended before the review was answered")) : resolve(line))),
    );
  }

  close() {
    this.rl.close();
  }
}

/** Asks you in the terminal to approve, revise, edit by hand, or stop. */
export class TerminalApprover implements Approver {
  private rl = new LineReader();

  async review(req: ReviewRequest): Promise<Decision> {
    const bar = "─".repeat(72);
    console.log(`\n${bar}\nREVIEW: ${req.stageTitle} (revision ${req.revision})\n${bar}`);
    console.log(req.summary);
    console.log(`\nFiles:\n${req.files.map((f) => `  ${f}`).join("\n")}\n`);

    for (;;) {
      const answer = (
        await this.rl.question("[a]pprove  [r]equest changes  [e]dit the files yourself  [q]uit and resume later > ")
      )
        .trim()
        .toLowerCase();
      if (answer === "a" || answer === "approve") return { decision: "approve" };
      if (answer === "q" || answer === "quit") return { decision: "quit" };
      if (answer === "e" || answer === "edit") {
        await this.rl.question("Edit the files above, save them, then press Enter here > ");
        return { decision: "edited" };
      }
      if (answer === "r" || answer === "revise") {
        console.log("Describe the changes you want. Finish with an empty line.");
        const lines: string[] = [];
        for (;;) {
          const line = await this.rl.question("> ");
          if (!line.trim()) break;
          lines.push(line);
        }
        if (lines.length) return { decision: "revise", notes: lines.join("\n") };
        console.log("No notes entered.");
      }
    }
  }

  close() {
    this.rl.close();
  }
}

/** Returns scripted decisions in order, then approves. For tests and --yes runs. */
export class ScriptedApprover implements Approver {
  readonly seen: ReviewRequest[] = [];
  constructor(private readonly decisions: Decision[] = []) {}

  async review(req: ReviewRequest): Promise<Decision> {
    this.seen.push(req);
    return this.decisions.shift() ?? { decision: "approve" };
  }
}
