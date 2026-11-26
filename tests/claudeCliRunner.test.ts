import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeCliRunner, quoteForCmd } from "../packages/core/src/runners/claudeCli.js";

/** A stand-in `claude` executable that records how it was called. */
async function fakeClaude(dir: string, response: object, exitCode = 0) {
  const bin = path.join(dir, "fake-claude.mjs");
  await fs.writeFile(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";
const stdin = fs.readFileSync(0, "utf8");
const args = process.argv.slice(2);
const promptFile = args[args.indexOf("--append-system-prompt-file") + 1];
const systemPrompt = fs.readFileSync(promptFile, "utf8");
fs.writeFileSync(${JSON.stringify(path.join(dir, "call.json"))}, JSON.stringify({ args, stdin, systemPrompt, cwd: process.cwd() }));
process.stdout.write(${JSON.stringify(JSON.stringify(response))});
process.exit(${exitCode});
`,
  );
  await fs.chmod(bin, 0o755);
  return bin;
}

test("claude-cli runner calls claude -p headlessly with the agent's tools and prompt", async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cli-runner-")));
  const bin = await fakeClaude(dir, { type: "result", subtype: "success", is_error: false, result: "Wrote brief.json", total_cost_usd: 0.04 });

  const result = await new ClaudeCliRunner(bin).run({
    agent: "producer",
    systemPrompt: "You are the Producer.",
    prompt: "Write the brief.",
    cwd: dir,
    tools: ["Read", "Write"],
    expectedOutputs: [],
    model: "sonnet",
  });

  assert.equal(result.text, "Wrote brief.json");
  assert.equal(result.costUsd, 0.04);
  const call = JSON.parse(await fs.readFile(path.join(dir, "call.json"), "utf8"));
  assert.equal(call.stdin, "Write the brief.");
  assert.equal(call.cwd, dir);
  const args: string[] = call.args;
  const flag = (name: string) => args[args.indexOf(name) + 1];
  assert.ok(args.includes("-p"));
  assert.equal(flag("--output-format"), "json");
  assert.equal(flag("--tools"), "Read,Write");
  assert.equal(flag("--allowedTools"), "Read,Write");
  assert.equal(call.systemPrompt, "You are the Producer.");
  assert.equal(flag("--model"), "sonnet");
});

test("claude-cli runner reports the agent's error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runner-"));
  const bin = await fakeClaude(dir, { type: "result", subtype: "success", is_error: true, result: "Not logged in" }, 1);
  await assert.rejects(
    new ClaudeCliRunner(bin).run({ agent: "producer", systemPrompt: "", prompt: "x", cwd: dir, tools: ["Read"], expectedOutputs: [] }),
    /Agent "producer" failed: Not logged in/,
  );
});

test("arguments are quoted for the Windows shell only when needed", () => {
  assert.equal(quoteForCmd("Read,Write"), "Read,Write");
  assert.equal(quoteForCmd("C:\\Users\\M\\AppData\\Local\\Temp\\x\\system-prompt.md"), "C:\\Users\\M\\AppData\\Local\\Temp\\x\\system-prompt.md");
  assert.equal(quoteForCmd("C:\\Users\\Jane Doe\\file.md"), '"C:\\Users\\Jane Doe\\file.md"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
});
