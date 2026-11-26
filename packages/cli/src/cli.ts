import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ScriptedApprover, TerminalApprover, type Approver } from "@studio/core/approval";
import { loadConfig, type RunnerKind } from "@studio/core/config";
import type { StageContext } from "@studio/core/context";
import { runPipeline } from "@studio/core/pipeline";
import { Production } from "@studio/core/production";
import { createRunner } from "@studio/core/runners/index";
import { REPO_ROOT, renderPaths, writeProject } from "@studio/core/render/project";
import { PIPELINE_STAGES } from "@studio/core/stages/index";
import { auditionVoices } from "@studio/core/voice/audition";

const HELP = `2D explainer video pipeline

Stages: brief, research and script, storyboard, voiceover, animation, final render. You approve each one.

Usage:
  npm run pipeline -- new "<what the video is about>" [options]
  npm run pipeline -- new --file request.md [options]
  npm run pipeline -- run <production-id> [options]     resume a production
  npm run pipeline -- status <production-id>
  npm run pipeline -- list
  npm run pipeline -- studio <production-id>            open the video in Remotion Studio to scrub through it
  npm run pipeline -- voices [--text "..."]             hear each audition voice from pipeline.config.json
  npm run setup:voice                                   install Kokoro for the voiceover (once)

Options:
  --runner <claude-cli|agent-sdk|mock>   how agents run (default: claude-cli, or PIPELINE_RUNNER)
                                         claude-cli  uses your Claude Code login (Pro/Max plan)
                                         agent-sdk   uses ANTHROPIC_API_KEY, billed per use
                                         mock        writes sample files, no AI calls, for testing
  --model <name>                         model for every agent, for example opus or sonnet
  --yes                                  approve every stage automatically
  --file <path>                          read the request from a file
  --text <sentence>                      sentence for the voices command
  -h, --help
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      runner: { type: "string" },
      model: { type: "string" },
      yes: { type: "boolean", default: false },
      file: { type: "string" },
      text: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  const config = loadConfig({ runner: values.runner as RunnerKind | undefined, model: values.model });

  if (command === "voices") {
    const results = await auditionVoices(config, values.text, (m) => console.log(m));
    console.log("\nListen to each file, then set your favourite as voice.voice in pipeline.config.json:");
    for (const r of results) console.log(`  ${r.voice.padEnd(12)} ${r.file}`);
    return;
  }

  if (command === "list") {
    const all = await Production.list(config);
    if (!all.length) console.log("No productions yet.");
    for (const p of all) console.log(`${p.id}  ${stageLine(p.stages)}`);
    return;
  }

  if (command === "status") {
    const production = await Production.load(config, required(rest[0], "production id"));
    const s = production.state;
    console.log(`${s.id}\nPrompt: ${s.prompt}\n${stageLine(s.stages)}`);
    console.log(`Agent runs: ${s.agentRuns}, reported cost: $${s.totalCostUsd.toFixed(2)}\nFolder: ${production.dir}`);
    return;
  }

  if (command === "studio") {
    const production = await Production.load(config, required(rest[0], "production id"));
    const ctx: StageContext = { config, runner: createRunner(config), production, log: (m) => console.log(m) };
    if (!production.state.stages.voiceover || production.stage("voiceover").status !== "approved") {
      throw new Error("Approve the voiceover first: the studio needs its timings.");
    }
    await writeProject(ctx);
    const r = renderPaths(ctx);
    const cli = path.join(REPO_ROOT, "node_modules", "@remotion", "cli", "remotion-cli.js");
    console.log(`Opening Remotion Studio for ${production.id}. Press Ctrl+C here to close it.`);
    // Run from the repo root so remotion.config.ts (which wires up the pipeline library) is used.
    const child = spawn(process.execPath, [cli, "studio", r.entry, "--public-dir", r.publicDir], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    await new Promise((resolve) => child.on("close", resolve));
    return;
  }

  let production: Production;
  if (command === "new") {
    const prompt = values.file ? await fs.readFile(values.file, "utf8") : rest.join(" ");
    if (!prompt.trim()) throw new Error('Give the video request, for example: new "How GPS works"');
    production = await Production.create(config, prompt);
    console.log(`Created production ${production.id}\nFolder: ${production.dir}`);
  } else if (command === "run") {
    production = await Production.load(config, required(rest[0], "production id"));
  } else {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  console.log(`Agents run with: ${config.runner}${config.model ? ` (${config.model})` : ""}`);
  const ctx: StageContext = { config, runner: createRunner(config), production, log: (m) => console.log(m) };
  const approver: Approver = values.yes ? new ScriptedApprover() : new TerminalApprover();
  try {
    await runPipeline(ctx, PIPELINE_STAGES, approver);
  } finally {
    approver.close?.();
  }
}

function stageLine(stages: Record<string, { status: string; revision: number }>) {
  return Object.entries(stages)
    .map(([id, s]) => `${id}: ${s.status}${s.revision > 1 ? ` (rev ${s.revision})` : ""}`)
    .join("  |  ");
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}. Run with --help for usage.`);
  return value;
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  console.error("Approved stages are saved. Fix the problem and resume with: npm run pipeline -- run <production-id>");
  process.exitCode = 1;
});
