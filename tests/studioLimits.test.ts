import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeTime, parseResetTime, parseUsageLimit, UsageLimitError } from "../packages/core/src/studio/runs/limits.js";
import { MockStudioRunner } from "../packages/core/src/studio/runs/mock.js";
import { ClaudeCliStudioRunner, usageLimitFrom } from "../packages/core/src/studio/runs/runner.js";
import { listChapters } from "../packages/core/src/studio/store/chapters.js";
import { createProject, getProject } from "../packages/core/src/studio/store/projects.js";
import { createRun, listRuns, readRunLog } from "../packages/core/src/studio/store/runs.js";
import { listScenes, listVersions } from "../packages/core/src/studio/store/scenes.js";
import type { Studio } from "../packages/core/src/studio/studio.js";
import { Orchestrator } from "../packages/core/src/studio/workflow.js";
import { NoRenderOrchestrator } from "./helpers/orchestrator.js";
import { tempStudio } from "./helpers/studio.js";

const DESCRIPTION = "How noise-cancelling headphones erase sound with more sound.";

async function until(what: string, condition: () => boolean, timeoutMs = 20_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) assert.fail(`Timed out waiting until ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("a usage-limit message is told apart from other failures, and its reset time is read", () => {
  // 14:10 UTC on a Thursday.
  const now = new Date("2026-11-26T14:10:00Z");
  const reset = (text: string) => parseUsageLimit(text, now)?.resetAt?.toISOString();
  assert.equal(reset("Claude AI usage limit reached|1795000000"), new Date(1795000000 * 1000).toISOString());
  assert.equal(reset("You've hit your limit · resets 11:30pm (Europe/Berlin)"), "2026-11-26T22:30:00.000Z");
  assert.equal(reset("5-hour limit reached ∙ resets 3pm (UTC)"), "2026-11-26T15:00:00.000Z");
  assert.equal(reset("5-hour limit reached ∙ resets 2pm (UTC)"), "2026-11-27T14:00:00.000Z", "a time already past today means tomorrow");
  assert.equal(reset("Weekly limit reached ∙ resets Dec 3 at 10am (America/New_York)"), "2026-12-03T15:00:00.000Z");
  assert.equal(reset("Weekly limit reached ∙ resets Jan 2, 9:30am (Asia/Karachi)"), "2027-01-02T04:30:00.000Z");
  assert.equal(reset("Session limit reached. Your limit resets in 2 hours 15 minutes"), "2026-11-26T16:25:00.000Z");
  // A time with no zone is this computer's own time of day.
  const local = parseResetTime("limit reached ∙ resets 3:45pm", now)!;
  assert.deepEqual([local.getHours(), local.getMinutes()], [15, 45]);
  assert.ok(local > now && local.getTime() - now.getTime() <= 24 * 3600_000);

  assert.deepEqual(parseUsageLimit("You've reached your usage limit.", now), { cause: "limit", resetAt: undefined });
  assert.deepEqual(parseUsageLimit('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', now), { cause: "limit", resetAt: undefined });
  assert.deepEqual(parseUsageLimit('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', now), { cause: "busy" });
  assert.equal(parseUsageLimit("scene_check reported problems: the title overlaps the diagram", now), undefined);
  assert.equal(parseUsageLimit("Could not start claude", now), undefined);

  // What Claude Code reports while it runs counts for more than the wording of its last message.
  assert.equal(usageLimitFrom("Something went wrong", { resetsAt: 1795000000 })!.resetAt!.getTime(), 1795000000 * 1000);
  assert.deepEqual(usageLimitFrom("Something went wrong", undefined, "overloaded"), { cause: "busy" });
  assert.equal(usageLimitFrom("Something went wrong", undefined, "invalid_request"), undefined);

  assert.match(describeTime(new Date(now.getTime() + 60_000), now), /^at \d/);
  assert.match(describeTime(new Date(now.getTime() + 3 * 86_400_000), now), /^on \w+day at \d/);
});

/** A stand-in `claude` that hits the usage limit the first time it is called and finishes the second time. */
async function limitedClaude(dir: string) {
  const bin = path.join(dir, "fake-claude.mjs");
  const calls = path.join(dir, "calls.jsonl");
  await fs.writeFile(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";
const stdin = fs.readFileSync(0, "utf8");
const args = process.argv.slice(2);
const calls = ${JSON.stringify(calls)};
const earlier = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(calls, JSON.stringify({ args, stdin }) + "\\n");
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
say({ type: "system", subtype: "init", session_id: "sess-1" });
if (earlier === 0) {
  say({ type: "assistant", session_id: "sess-1", message: { content: [{ type: "tool_use", name: "mcp__studio__scene_get", input: {} }] } });
  say({ type: "rate_limit_event", session_id: "sess-1", rate_limit_info: { status: "rejected", resetsAt: Math.round(Date.now() / 1000) + 3600, rateLimitType: "five_hour" } });
  say({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm", session_id: "sess-1" });
  process.exit(1);
}
say({ type: "result", subtype: "success", is_error: false, result: "Built the scene.", session_id: "sess-1", total_cost_usd: 0.2 });
`,
  );
  await fs.chmod(bin, 0o755);
  return { bin, calls: async () => (await fs.readFile(calls, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; stdin: string }) };
}

test("Claude Code stopping at its usage limit is reported as a limit, with the reset time it gave", { skip: process.platform === "win32" && "the stand-in claude is a shell script" }, async () => {
  const studio = await tempStudio();
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "limited-claude-")));
  const fake = await limitedClaude(dir);
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 60 });
  const run = createRun(studio, { projectId: project.id, kind: "outline", agent: "planner" });
  const runner = new ClaudeCliStudioRunner(fake.bin);
  const request = { run, project, systemPrompt: "You plan videos.", prompt: "Write the outline.", cwd: dir, writesFiles: false, onLog: () => {}, onSession: () => {} };

  const before = Date.now();
  const err = await runner.run(studio, request).then(
    () => assert.fail("the first call should stop at the limit"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof UsageLimitError, String(err));
  assert.equal(err.cause, "limit");
  assert.ok(Math.abs(err.resetAt!.getTime() - (before + 3600_000)) < 5000, "the reset time Claude Code reported is used, not the vaguer one in its message");
  assert.match(err.message, /hit your limit/);

  // Continuing passes the session on, and this time Claude gets through.
  const result = await runner.run(studio, { ...request, resumeSessionId: "sess-1" });
  assert.equal(result.text, "Built the scene.");
  const calls = await fake.calls();
  assert.equal(calls[0]!.args.includes("--resume"), false);
  assert.equal(calls[1]!.args[calls[1]!.args.indexOf("--resume") + 1], "sess-1");
  studio.close();
});

/** Lets a fixed number of tool calls through, then refuses every call until a moment passes: Claude's usage limit, in small. */
class Allowance {
  left: number;
  resetAt = 0;
  pauses = 0;
  constructor(
    private readonly size: number,
    private readonly windowMs: number,
    /** Whether the refusal says when the limit lifts. */
    private readonly saysWhen = true,
  ) {
    this.left = size;
  }
  spend = () => {
    if (this.left <= 0 && Date.now() >= this.resetAt) this.left = this.size;
    if (this.left <= 0) throw new UsageLimitError("Claude stopped at a usage limit: You've hit your limit", this.saysWhen ? new Date(this.resetAt) : undefined);
    if (--this.left === 0) {
      this.resetAt = Date.now() + this.windowMs;
      this.pauses++;
    }
  };
}

function limitedStudio(studio: Studio, allowance: Allowance) {
  const runner = new MockStudioRunner();
  runner.beforeTool = allowance.spend;
  const o = new NoRenderOrchestrator(studio, runner);
  o.limitMarginMs = 0;
  return { runner, o };
}

test("a 20-minute video completes across several usage-limit pauses without losing work", async () => {
  const studio = await tempStudio();
  const allowance = new Allowance(70, 150);
  const { runner, o } = limitedStudio(studio, allowance);
  runner.scenesPerChapter = 4;
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 1200 });

  o.startStage(project.id);
  await o.idle();
  let sawPause = false;
  for (const stage of ["bible", "foundation", "chapters", "scenes"]) {
    assert.equal(o.approveStage(project.id).stage, stage);
    // Look in on the studio while it works: a pause is announced with the time it ends, and runs wait instead of failing.
    const watch = setInterval(() => {
      const pause = o.usagePause();
      if (!pause) return;
      sawPause = true;
      assert.equal(pause.known, true);
      assert.equal(pause.until, new Date(allowance.resetAt).toISOString());
      assert.equal(listRuns(studio, project.id).filter((r) => r.status === "failed").length, 0);
    }, 20);
    await o.idle();
    clearInterval(watch);
  }

  assert.ok(allowance.pauses >= 4, `the limit was hit ${allowance.pauses} times`);
  assert.ok(sawPause);
  assert.equal(o.usagePause(), null);
  assert.equal(listChapters(studio, project.id).length, 10);
  const scenes = listScenes(studio, project.id);
  assert.equal(scenes.length, 40);
  const runs = listRuns(studio, project.id, { limit: 500 });
  assert.deepEqual([...new Set(runs.map((r) => r.status))], ["done"], "no run failed or was thrown away");
  for (const scene of scenes) {
    assert.equal(scene.status, "needs_review", scene.staleReason ?? "");
    assert.equal(listVersions(studio, scene.id).length, 1, "a run that was interrupted carried on with the version it had started");
    assert.equal(runs.filter((r) => r.targetId === scene.id).length, 1, "one run per scene, however often it had to wait");
  }
  // A run that waited says so in its log, and continued the session it had.
  const waited = runs.filter((r) => readRunLog(studio, r.id).lines.some((l) => /usage limit was reached/.test(l.text)));
  assert.ok(waited.length >= 4);
  const calls = runner.calls.filter((c) => c.runId === waited[0]!.id).map((c) => c.tool);
  assert.ok(calls.filter((t) => t === "project_get").length >= 2, "it started over from what was saved");
  assert.match(readRunLog(studio, waited[0]!.id).lines.map((l) => l.text).join("\n"), /waits and carries on by itself at \d[\s\S]*Carrying on\./);

  for (const scene of scenes) o.approveScene(scene.id);
  assert.equal(o.approveStage(project.id).stage, "assembly");
  studio.close();
});

test("with no reset time the studio tries again after a wait that grows, and a person can cut the wait short or cancel", async () => {
  const studio = await tempStudio();
  // About 60 ms for the first wait, twice that for the second.
  studio.config.studio.usageLimit.retryMinutes = 0.001;
  const allowance = new Allowance(6, 100, false);
  allowance.left = 2;
  const { o } = limitedStudio(studio, allowance);
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 60 });

  // The outline needs three tool calls and only two are left: the run has to wait for the limit to lift.
  const [run] = o.startStage(project.id);
  await until("the run is waiting", () => o.usagePause()?.waiting === 1);
  const first = o.usagePause()!;
  assert.equal(first.known, false);
  assert.equal(first.cause, "limit");
  const firstWait = new Date(first.until).getTime() - new Date(first.since).getTime();
  assert.ok(firstWait >= 55 && firstWait <= 65, `first wait ${firstWait} ms`);
  assert.equal(listRuns(studio, project.id)[0]!.status, "queued", "a waiting run shows as waiting, not as failed");
  assert.match(o.stageStatus(project.id).waitingOn.join(" "), /still working/);

  // The first retry comes too early for the limit, so the next wait is twice as long.
  await until("the second pause", () => (o.usagePause()?.since ?? first.since) !== first.since);
  const second = o.usagePause()!;
  const secondWait = new Date(second.until).getTime() - new Date(second.since).getTime();
  assert.ok(secondWait >= 115 && secondWait <= 125, `second wait ${secondWait} ms`);
  await o.idle();
  assert.equal(listRuns(studio, project.id)[0]!.status, "done");
  assert.equal(getProject(studio, project.id).stage, "outline");
  assert.equal(o.usagePause(), null);
  assert.equal(listRuns(studio, project.id).length, 1);
  assert.equal(run!.id, listRuns(studio, project.id)[0]!.id);

  // "Try now": the wait is an hour, the person does not want to sit it out.
  studio.config.studio.usageLimit.retryMinutes = 60;
  allowance.left = 1;
  o.approveStage(project.id);
  await until("the bible run is waiting", () => o.usagePause()?.waiting === 1);
  assert.ok(new Date(o.usagePause()!.until).getTime() - Date.now() > 3000_000);
  await new Promise((r) => setTimeout(r, 110));
  o.resumeNow();
  await o.idle();
  assert.equal(listRuns(studio, project.id)[0]!.status, "done");

  // Cancelling a waiting run ends it there and then.
  allowance.left = 1;
  o.approveStage(project.id);
  await until("the foundation run is waiting", () => o.usagePause()?.waiting === 1);
  o.cancel(listRuns(studio, project.id)[0]!.id);
  await o.idle();
  assert.equal(listRuns(studio, project.id)[0]!.status, "cancelled");
  o.stop();
  assert.equal(o.usagePause(), null);
  studio.close();
});

test("a limit that never lifts fails the run after a set number of tries, with the reason", async () => {
  const studio = await tempStudio();
  studio.config.studio.usageLimit.retryMinutes = 0.0002;
  studio.config.studio.usageLimit.maxTries = 3;
  const runner = new MockStudioRunner();
  let tries = 0;
  runner.beforeTool = () => {
    tries++;
    throw new UsageLimitError("Claude stopped at a usage limit: out of extra usage");
  };
  const o = new NoRenderOrchestrator(studio, runner);
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 60 });
  o.startStage(project.id);
  await o.idle();
  const run = listRuns(studio, project.id)[0]!;
  assert.equal(tries, 3);
  assert.equal(run.status, "failed");
  assert.match(run.error!, /out of extra usage[\s\S]*still in place after 3 tries/);
  studio.close();
});

test("a second studio process in the same workspace leaves the first one's work alone", async () => {
  const studio = await tempStudio();
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 60 });
  const mine = createRun(studio, { projectId: project.id, kind: "outline", agent: "planner" });
  const owner = path.join(studio.workspaceDir, "studio.owner");

  // Some other live process runs this workspace: its queued run is not ours to fail.
  await fs.writeFile(owner, String(process.ppid));
  new Orchestrator(studio, new MockStudioRunner());
  assert.equal(listRuns(studio, project.id)[0]!.status, "queued");
  assert.equal(await fs.readFile(owner, "utf8"), String(process.ppid));

  // The process that ran it is gone: the next studio takes over and marks what was cut off.
  await fs.writeFile(owner, "2147483646");
  const o = new Orchestrator(studio, new MockStudioRunner());
  assert.equal(listRuns(studio, project.id)[0]!.status, "failed");
  assert.match(listRuns(studio, project.id)[0]!.error!, /studio was closed/);
  assert.equal(mine.id, listRuns(studio, project.id)[0]!.id);
  assert.equal(await fs.readFile(owner, "utf8"), String(process.pid));
  o.stop();
  await assert.rejects(fs.readFile(owner, "utf8"));
  studio.close();
});

test("changing a shared component marks exactly its dependent scenes stale, and one action rebuilds them", async () => {
  const { importAsset } = await import("../packages/core/src/studio/store/assets.js");
  const { saveShared, readShared } = await import("../packages/core/src/studio/store/shared.js");
  const { clipCacheKey, qualitySettings, sceneContext } = await import("../packages/core/src/studio/scenes/render.js");
  const { writeTestCard } = await import("./helpers/media.js");
  const studio = await tempStudio();
  const runner = new MockStudioRunner();
  const o = new NoRenderOrchestrator(studio, runner);
  const project = createProject(studio, { description: DESCRIPTION, targetDurationSec: 120 });
  // With a picture in the project, the first chapter gets a scene that shows it and draws no shared component.
  const card = path.join(studio.workspaceDir, "card.png");
  writeTestCard(card);
  await importAsset(studio, project.id, card, { label: "Headphone cutaway" });
  o.startStage(project.id);
  await o.idle();
  for (const stage of ["bible", "foundation", "chapters", "scenes"]) {
    assert.equal(o.approveStage(project.id).stage, stage);
    await o.idle();
  }
  const scenes = listScenes(studio, project.id);
  assert.deepEqual(scenes.map((s) => s.type), ["remotion-2d", "remotion-2d", "illustration", "remotion-2d", "remotion-2d"]);
  const picture = scenes[2]!;
  const users = scenes.filter((s) => s.id !== picture.id);
  // Two of the scenes that use the badge, and the one that does not, are already approved.
  for (const scene of [scenes[0]!, scenes[1]!, picture]) o.approveScene(scene.id);
  const key = async (sceneId: string) => clipCacheKey(await sceneContext(studio, sceneId), qualitySettings(studio, "preview"));
  const before = await Promise.all(scenes.map((s) => key(s.id)));

  // A component no scene uses changes nothing. The badge changes every scene drawn with it, approved or not, and no other.
  saveShared(studio, project.id, { name: "EarCup", code: "export const EarCup = () => null;\n", createdBy: "test" });
  saveShared(studio, project.id, { name: "EarCup", code: "export const EarCup = () => <g />;\n", createdBy: "test" });
  assert.equal(listScenes(studio, project.id).filter((s) => s.status === "stale").length, 0);
  const changed = saveShared(studio, project.id, { name: "TopicBadge", code: readShared(studio, project.id, "TopicBadge")! + "\n// thicker border\n", createdBy: "test" });
  assert.deepEqual([...changed.staleScenes].sort(), users.map((s) => s.id).sort());
  assert.deepEqual(listScenes(studio, project.id).map((s) => s.status), ["stale", "stale", "approved", "stale", "stale"]);
  assert.deepEqual(listChapters(studio, project.id).map((c) => c.status), ["in_production", "in_production"]);
  // Their clips no longer match what would be drawn; the untouched scene's clip still does.
  const after = await Promise.all(scenes.map((s) => key(s.id)));
  assert.deepEqual(after.map((k, i) => k !== before[i]), [true, true, false, true, true]);
  assert.throws(() => o.approveStage(project.id), /4 of 5 scenes are not approved/);

  // One action renders exactly those again, two at a time, without any Claude run, and puts them up for review.
  const runsBefore = listRuns(studio, project.id).length;
  o.rendered.length = 0;
  assert.deepEqual(o.rebuildStale(project.id).sort(), users.map((s) => s.id).sort());
  assert.deepEqual(o.rebuildStale(project.id), [], "asking twice does not render twice");
  await o.idle();
  assert.deepEqual([...o.rendered].sort(), users.map((s) => s.id).sort());
  assert.deepEqual(listScenes(studio, project.id).map((s) => s.status), ["needs_review", "needs_review", "approved", "needs_review", "needs_review"]);
  assert.equal(listRuns(studio, project.id).length, runsBefore);
  assert.ok(scenes.every((s) => listVersions(studio, s.id).length === 1));
  for (const scene of users) o.approveScene(scene.id);
  assert.equal(o.approveStage(project.id).stage, "assembly");
  studio.close();
});

test("the page is told about a usage pause, can end it, and rebuilds stale scenes in one request", async () => {
  const { startServer } = await import("../packages/server/src/server.js");
  const { saveShared, readShared } = await import("../packages/core/src/studio/store/shared.js");
  const studio = await tempStudio();
  studio.config.studio.usageLimit.retryMinutes = 60;
  const allowance = new Allowance(1000, 50, false);
  const { o } = limitedStudio(studio, allowance);
  const server = await startServer(studio, { port: 0, orchestrator: o });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(server.url + url, { method, headers: { "x-studio": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(res.status, 200, `${method} ${url}`);
    return (await res.json()) as any;
  };
  try {
    allowance.left = 1;
    const { slug } = await call("POST", "/api/projects", { description: DESCRIPTION, targetDurationSec: 120, aspect: "16:9" });
    const at = `/api/projects/${slug}`;
    await until("the outline run is waiting", () => o.usagePause()?.waiting === 1);
    let snap = await call("GET", at);
    assert.equal(snap.usage.known, false);
    assert.equal(snap.usage.waiting, 1);
    assert.ok(new Date(snap.usage.until).getTime() - Date.now() > 3000_000);
    assert.equal(snap.runs[0].status, "queued");
    assert.ok(studio.eventsAfter(0).some((e) => e.kind === "usage.paused" && e.projectId === null));

    await new Promise((r) => setTimeout(r, 60));
    await call("POST", "/api/usage/resume", {});
    await o.idle();
    snap = await call("GET", at);
    assert.equal(snap.usage, null);
    assert.equal(snap.runs[0].status, "done");
    assert.ok(studio.eventsAfter(0).some((e) => e.kind === "usage.resumed"));

    for (let i = 0; i < 4; i++) {
      await call("POST", `${at}/stage/approve`, {});
      await o.idle();
    }
    const project = getProject(studio, slug);
    saveShared(studio, project.id, { name: "TopicBadge", code: readShared(studio, project.id, "TopicBadge")! + "\n// changed\n", createdBy: "test" });
    snap = await call("GET", at);
    assert.deepEqual(snap.scenes.map((s: any) => [s.status, s.reason]), Array(4).fill(["stale", "TopicBadge changed to version 2"]));
    assert.deepEqual(await call("POST", `${at}/stale/rebuild`, {}), { scenes: 4 });
    await o.idle();
    assert.ok((await call("GET", at)).scenes.every((s: any) => s.status === "needs_review"));
  } finally {
    await server.close();
    o.stop();
    studio.close();
  }
});
