import fs from "node:fs";
import path from "node:path";
import { assemble, type AssembleOptions, type AssembleResult } from "./assemble.js";
import { newId, nowIso } from "./ids.js";
import { ffmpeg } from "./media/ffmpeg.js";
import { Lanes } from "./runs/lanes.js";
import { describeTime, UsageLimitError } from "./runs/limits.js";
import { MockStudioRunner } from "./runs/mock.js";
import { agentFor, systemPrompt, taskPrompt } from "./runs/prompts.js";
import { ClaudeCliStudioRunner, type StudioRunner } from "./runs/runner.js";
import { renderSceneClip } from "./scenes/render.js";
import { buildSoundtrack, mixArgs } from "./sound/mix.js";
import type { Studio } from "./studio.js";
import { getChapter, listChapters, syncChapterStatus, updateChapter, type Chapter, type ChapterStatus } from "./store/chapters.js";
import type { Clip, ClipQuality } from "./store/clips.js";
import { approveDocument, latestDocument } from "./store/documents.js";
import { getProject, projectPaths, updateProject, type Project } from "./store/projects.js";
import { appendRunLog, createRun, failInterruptedRuns, getRun, lastSessionFor, listRuns, updateRun, type AgentRun, type RunKind } from "./store/runs.js";
import { addReview, approveScene, currentVersion, getScene, getVersion, listScenes, reviseScene, sceneLabel, setSceneStatus, updateVersion, versionPaths, type Scene } from "./store/scenes.js";
import { approveShared, listShared } from "./store/shared.js";
import { ensureVoice, getVoiceTrack } from "./voice.js";

export interface StageStatus {
  stage: Project["stage"];
  /** What this stage is for, in a sentence. */
  about: string;
  /** Runs working on this stage right now. */
  running: number;
  /** What still has to happen before you can approve the stage. Empty means it is ready for you. */
  waitingOn: string[];
}

/** Work is on hold because Claude's usage limit was reached. It continues by itself. */
export interface UsagePause {
  since: string;
  /** When the studio tries again. */
  until: string;
  /** True when Claude said when the limit lifts. False when the studio is simply trying again after a wait. */
  known: boolean;
  /** "limit" is the plan's usage limit; "busy" is a short overload on Claude's side. */
  cause: "limit" | "busy";
  /** Runs waiting for it. */
  waiting: number;
}

const CONTINUE = `You were stopped part-way through this task by a usage limit, and can now carry on. Everything you saved through the studio tools, and every file you wrote, is still there: look at what exists first, and do not redo finished work.

The task was:

`;

const ABOUT: Record<Project["stage"], string> = {
  outline: "The outline: what the video explains, and its chapters.",
  bible: "The bible: the voice, the look, and the things that recur.",
  foundation: "Shared components: recurring things, built once before any scene.",
  chapters: "The scene list: every scene's narration and what it shows.",
  scenes: "The scenes: each one built, rendered and reviewed on its own.",
  assembly: "The video: every approved scene joined together.",
  done: "The video is finished.",
};

/**
 * Starts and follows the work: Claude runs, renders and assembly, each in a lane that
 * limits how much happens at once. One Orchestrator lives in the GUI server or the CLI.
 */
export class Orchestrator {
  readonly lanes: Lanes<"agents" | "renders" | "light">;
  readonly runner: StudioRunner;
  private readonly aborts = new Map<string, AbortController>();
  private readonly background = new Set<Promise<unknown>>();
  private pause?: { since: number; until: number; known: boolean; cause: "limit" | "busy"; wait: Promise<void>; open: () => void; timer?: ReturnType<typeof setTimeout> };
  /** Pauses in a row with no run finishing in between: each one waits longer. */
  private limitStreak = 0;
  private waitingRuns = 0;
  private stopped = false;
  /** Waited on top of the time Claude names, because two clocks never quite agree. */
  limitMarginMs = 20_000;

  constructor(
    readonly studio: Studio,
    runner?: StudioRunner,
  ) {
    this.lanes = new Lanes(studio.config.studio.lanes);
    this.runner = runner ?? (studio.config.runner === "mock" ? new MockStudioRunner() : new ClaudeCliStudioRunner(studio.config.claudeBin));
    // Another studio process may be at work in this workspace, such as the GUI while a terminal command runs. Its runs are not ours to tidy up.
    if (claimWorkspace(studio)) {
      failInterruptedRuns(studio);
      this.settleInterrupted();
    }
  }

  /** Stop everything this orchestrator started: for closing the studio. What was saved stays. */
  stop() {
    this.stopped = true;
    for (const abort of this.aborts.values()) abort.abort();
    this.endPause();
    releaseWorkspace(this.studio);
  }

  /** After the studio was closed in the middle of work: nothing is left looking as if it were still being worked on. */
  private settleInterrupted() {
    const { studio } = this;
    studio.db.run(
      `UPDATE chapters SET status = CASE WHEN EXISTS (SELECT 1 FROM scenes WHERE scenes.chapter_id = chapters.id) THEN 'script_review' ELSE 'planned' END
       WHERE status = 'scripting'`,
    );
    for (const { id } of studio.db.all<{ id: string }>("SELECT id FROM scenes WHERE status = 'in_production'")) {
      setSceneStatus(studio, id, "failed", "The studio was closed while this scene was being built. Build it again.");
    }
  }

  /** Resolves when everything started so far, and everything that work started in turn, has finished. */
  async idle() {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const settled = work.catch(() => undefined);
    this.background.add(settled);
    void settled.finally(() => this.background.delete(settled));
    return work;
  }

  /** Run something in the background. A failure is shown to the person instead of stopping the studio. */
  private detach(projectId: string, work: Promise<unknown>) {
    void this.track(work).catch((err) => this.studio.emit("notice", { projectId, data: { level: "error", message: (err as Error).message } }));
  }

  // ---------- Runs ----------

  private startRun(input: { projectId: string; kind: RunKind; targetId?: string; notes?: string; task?: "build" | "revise" }, after?: (run: AgentRun) => Promise<void> | void): AgentRun {
    const { studio } = this;
    const busy = listRuns(studio, input.projectId, { active: true }).find((r) => r.targetKind === input.kind && (r.targetId ?? "") === (input.targetId ?? ""));
    if (busy) throw new Error("That is already being worked on. Wait for it to finish, or cancel it first.");
    const task = input.task ?? (input.notes ? "revise" : "build");
    const run = createRun(studio, {
      projectId: input.projectId,
      kind: input.kind,
      targetId: input.targetId,
      agent: agentFor(input.kind),
      task,
      notes: input.notes,
      // A revision continues the conversation that made the thing, so Claude remembers why it is the way it is.
      resumeFrom: task === "revise" ? lastSessionFor(studio, input.kind, input.targetId ?? null, input.projectId) : undefined,
    });
    const abort = new AbortController();
    this.aborts.set(run.id, abort);
    void this.track(
      this.lanes
        .run("agents", () => this.executeRun(run.id, abort.signal))
        .then(async (finished) => {
          this.aborts.delete(run.id);
          await after?.(finished);
        }),
    ).catch((err) => appendRunLog(studio, run, "error", (err as Error).message));
    return run;
  }

  private async executeRun(runId: string, signal: AbortSignal): Promise<AgentRun> {
    const { studio } = this;
    // A run that comes up while a usage limit is in force waits its turn here instead of running into the limit itself.
    await this.clearToRun(signal);
    if (signal.aborted) return updateRun(studio, runId, { status: "cancelled", finishedAt: nowIso() });
    let run = updateRun(studio, runId, { status: "running", startedAt: nowIso() });
    const project = getProject(studio, run.projectId);
    const p = projectPaths(studio, project);
    const log = (kind: Parameters<typeof appendRunLog>[2], text: string) => appendRunLog(studio, run, kind, text);

    let target: { label?: string; title?: string } = {};
    // The folder stays the same for every run on one target, which is what lets a session be resumed.
    let cwd = path.join(p.work, "agents", run.targetKind);
    if (run.targetKind === "scene") {
      const scene = getScene(studio, run.targetId!);
      target = { label: sceneLabel(studio, scene), title: scene.title };
      cwd = p.sceneDir(scene.id);
      const version = currentVersion(studio, scene);
      // Cleared so that a hand-over at the end is known to come from this run.
      if (version) updateVersion(studio, version.id, { summary: null });
    } else if (run.targetKind === "chapter") {
      const chapter = getChapter(studio, run.targetId!);
      target = { label: String(chapter.position), title: chapter.title };
      cwd = path.join(p.work, "agents", `chapter-${chapter.id}`);
    }
    fs.mkdirSync(cwd, { recursive: true });

    const request = {
      run,
      project,
      systemPrompt: systemPrompt(run.targetKind),
      prompt: taskPrompt(project, run, target),
      cwd,
      writesFiles: run.targetKind === "scene",
      model: studio.config.model,
      onLog: log,
      onSession: (sessionId: string) => {
        run = updateRun(studio, runId, { claudeSessionId: sessionId });
      },
      signal,
    };
    log("info", `${run.agent} started${run.payload.notes ? ` on your notes: ${run.payload.notes}` : ""}`);
    const started = Date.now();
    const once = async (attempt: typeof request & { resumeSessionId?: string }) => {
      try {
        return await this.runner.run(studio, attempt);
      } catch (err) {
        // A session from another computer, or one Claude Code has cleaned up, cannot be resumed. Start fresh.
        if (!attempt.resumeSessionId || signal.aborted || err instanceof UsageLimitError || !/conversation|session|resume/i.test((err as Error).message)) throw err;
        log("info", "The earlier session could not be continued, so this run starts fresh.");
        return await this.runner.run(studio, request);
      }
    };
    try {
      let attempt: typeof request & { resumeSessionId?: string } = { ...request, resumeSessionId: run.payload.resumeFrom };
      for (let tries = 1; ; tries++) {
        try {
          const result = await once(attempt);
          this.limitStreak = 0;
          return updateRun(studio, runId, {
            status: "done",
            resultText: result.text,
            claudeSessionId: result.sessionId ?? run.claudeSessionId,
            costUsd: result.costUsd ?? null,
            durationMs: result.durationMs ?? Date.now() - started,
            finishedAt: nowIso(),
          });
        } catch (err) {
          if (!(err instanceof UsageLimitError) || signal.aborted) throw err;
          if (tries >= studio.config.studio.usageLimit.maxTries) throw new Error(`${err.message}\nThe limit was still in place after ${tries} tries, so this run stopped. Start it again later.`);
          // Not a failure: the run keeps its place, waits for the limit to lift and continues the same session.
          const pause = this.pauseFor(err);
          log("info", `${err.cause === "busy" ? "Claude is overloaded right now" : "Claude's usage limit was reached"}. This run waits and carries on by itself ${describeTime(new Date(pause.until))}. Nothing it saved is lost.`);
          run = updateRun(studio, runId, { status: "queued" });
          await this.clearToRun(signal);
          if (signal.aborted) throw new Error("Cancelled");
          run = updateRun(studio, runId, { status: "running" });
          log("info", "Carrying on.");
          const session = run.claudeSessionId ?? run.payload.resumeFrom;
          attempt = session ? { ...request, prompt: CONTINUE + request.prompt, resumeSessionId: session } : { ...request };
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      log("error", message);
      return updateRun(studio, runId, { status: signal.aborted ? "cancelled" : "failed", error: message, durationMs: Date.now() - started, finishedAt: nowIso() });
    }
  }

  // ---------- Usage limits ----------

  /** The pause in force, if work is on hold for a usage limit. */
  usagePause(): UsagePause | null {
    const p = this.pause;
    return p ? { since: new Date(p.since).toISOString(), until: new Date(p.until).toISOString(), known: p.known, cause: p.cause, waiting: this.waitingRuns } : null;
  }

  /** Do not wait any longer: let the waiting runs try now. If the limit is still there, they pause again. */
  resumeNow() {
    this.endPause();
  }

  /** Put everything that needs Claude on hold until the limit lifts. Runs that hit the same limit share one pause. */
  private pauseFor(err: UsageLimitError) {
    const now = Date.now();
    const known = Boolean(err.resetAt && err.resetAt.getTime() > now);
    const retry = this.studio.config.studio.usageLimit.retryMinutes;
    const base = err.cause === "busy" ? Math.min(2, retry) : retry;
    const until = known ? err.resetAt!.getTime() + this.limitMarginMs : now + Math.min(base * 2 ** this.limitStreak, Math.max(60, base)) * 60_000;
    if (this.pause) {
      // A stated reset time beats a guess, and the later of two stated times is the one to wait for.
      if (known && (!this.pause.known || until > this.pause.until)) {
        this.pause.until = until;
        this.pause.known = true;
        this.pause.cause = err.cause;
        this.watchPause();
      }
      return this.pause;
    }
    this.limitStreak++;
    let open!: () => void;
    const wait = new Promise<void>((resolve) => (open = resolve));
    this.pause = { since: now, until, known, cause: err.cause, wait, open };
    // Every project waits on the same limit, so every open page hears about it.
    this.studio.emit("usage.paused", { data: { until: new Date(until).toISOString(), known, cause: err.cause } });
    this.watchPause();
    return this.pause;
  }

  /** Looks at the clock every so often, not once, so a computer that slept through the reset still wakes the work up. */
  private watchPause() {
    const p = this.pause;
    if (!p) return;
    clearTimeout(p.timer);
    const left = p.until - Date.now();
    if (left <= 0) return this.endPause();
    p.timer = setTimeout(() => this.watchPause(), Math.min(left, 30_000));
  }

  private endPause() {
    const p = this.pause;
    if (!p) return;
    clearTimeout(p.timer);
    this.pause = undefined;
    p.open();
    if (!this.stopped) this.studio.emit("usage.resumed", {});
  }

  /** Resolves when no usage limit is holding work back, or when the run is cancelled. */
  private async clearToRun(signal: AbortSignal) {
    while (this.pause && !signal.aborted) {
      let cancel!: () => void;
      const cancelled = new Promise<void>((resolve) => (cancel = resolve));
      signal.addEventListener("abort", cancel, { once: true });
      this.waitingRuns++;
      try {
        await Promise.race([this.pause.wait, cancelled]);
      } finally {
        this.waitingRuns--;
        signal.removeEventListener("abort", cancel);
      }
    }
  }

  /** Stop a run. Whatever it had already saved stays. */
  cancel(runId: string) {
    const abort = this.aborts.get(runId);
    if (abort) abort.abort();
    else if (["queued", "running"].includes(getRun(this.studio, runId).status)) {
      updateRun(this.studio, runId, { status: "cancelled", error: "Cancelled", finishedAt: nowIso() });
    }
  }

  // ---------- Stages ----------

  stageStatus(projectId: string): StageStatus {
    const { studio } = this;
    const project = getProject(studio, projectId);
    const active = listRuns(studio, projectId, { active: true });
    const waitingOn: string[] = [];
    const scenes = listScenes(studio, projectId);
    switch (project.stage) {
      case "outline":
        if (!latestDocument(studio, projectId, "outline")) waitingOn.push("The outline has not been written yet.");
        if (!listChapters(studio, projectId).length) waitingOn.push("There are no chapters yet.");
        break;
      case "bible":
        if (!latestDocument(studio, projectId, "bible")) waitingOn.push("The bible has not been written yet.");
        break;
      case "foundation":
        for (const s of listShared(studio, projectId)) if (!s.currentVersion) waitingOn.push(`${s.name} has not been built yet.`);
        break;
      case "chapters":
        for (const c of listChapters(studio, projectId)) {
          if (!scenes.some((s) => s.chapterId === c.id)) waitingOn.push(`Chapter ${c.position}, "${c.title}", has no scenes yet.`);
        }
        break;
      case "scenes": {
        for (const c of listChapters(studio, projectId)) {
          if (c.status === "scripting") waitingOn.push(`The scene list of chapter ${c.position}, "${c.title}", is being rewritten.`);
          if (c.status === "script_review") waitingOn.push(`The scene list of chapter ${c.position}, "${c.title}", is waiting for your approval.`);
        }
        const open = scenes.filter((s) => s.status !== "approved");
        if (open.length) waitingOn.push(`${open.length} of ${scenes.length} scenes are not approved yet.`);
        break;
      }
      case "assembly":
        if (!studio.db.get("SELECT 1 FROM renders WHERE project_id = ? AND kind = 'final' AND scope = 'project'", [projectId])) waitingOn.push("The final video has not been rendered yet.");
        break;
    }
    // Scenes of an approved chapter are built while later chapters are still being written, so scene runs never hold a stage back.
    const planning = active.filter((r) => r.targetKind !== "scene");
    if (planning.length && project.stage !== "scenes") waitingOn.unshift(`${planning.length} run(s) still working.`);
    // While scene lists are being written, the scenes of chapters already approved are built alongside; those runs belong to the next stage.
    const running = project.stage === "chapters" ? planning.length : active.length;
    return { stage: project.stage, about: ABOUT[project.stage], running, waitingOn };
  }

  /** Start, or start again, the work of the project's current stage. `notes` asks for changes to what exists. */
  startStage(projectId: string, notes?: string): AgentRun[] {
    const { studio } = this;
    const project = getProject(studio, projectId);
    const review = (kind: "outline" | "bible") => {
      const doc = latestDocument(studio, projectId, kind);
      if (notes && doc) addReview(studio, { projectId, targetKind: "document", targetId: doc.id, targetVersion: doc.version, decision: "revise", notes });
    };
    switch (project.stage) {
      case "outline":
        review("outline");
        return [this.startRun({ projectId, kind: "outline", notes })];
      case "bible":
        review("bible");
        return [this.startRun({ projectId, kind: "bible", notes })];
      case "foundation":
        return listShared(studio, projectId).length ? [this.startRun({ projectId, kind: "foundation", notes })] : [];
      case "chapters": {
        // With notes: every scene list not yet approved is written again. Without: carry on with the next unwritten chapter.
        if (notes) {
          return listChapters(studio, projectId)
            .filter((c) => c.status === "planned" || c.status === "script_review")
            .map((c) => this.scriptChapter(c.id, notes));
        }
        const run = this.scriptNextChapter(projectId);
        return run ? [run] : [];
      }
      case "scenes":
        this.detach(projectId, this.produce(projectId));
        return [];
      default:
        return [];
    }
  }

  // ---------- Chapters ----------

  /**
   * Write the scene list of the first chapter that has none. Chapters are written one after
   * another, so each can read what the ones before it said, and so the first is ready for
   * review while the rest are still to come.
   */
  private scriptNextChapter(projectId: string): AgentRun | undefined {
    const { studio } = this;
    if (getProject(studio, projectId).stage !== "chapters") return undefined;
    if (listRuns(studio, projectId, { active: true }).some((r) => r.targetKind === "chapter" && r.task === "build")) return undefined;
    const scenes = listScenes(studio, projectId);
    const next = listChapters(studio, projectId).find((c) => !scenes.some((s) => s.chapterId === c.id));
    return next ? this.scriptChapter(next.id) : undefined;
  }

  private scriptChapter(chapterId: string, notes?: string): AgentRun {
    const { studio } = this;
    const chapter = getChapter(studio, chapterId);
    const building = listRuns(studio, chapter.projectId, { active: true }).filter((r) => r.targetKind === "scene" && getScene(studio, r.targetId!).chapterId === chapterId);
    if (building.length) throw new Error("Scenes of this chapter are being built right now. Wait for them to finish, or cancel them, before changing its scene list.");
    const before = chapter.status;
    const run = this.startRun({ projectId: chapter.projectId, kind: "chapter", targetId: chapterId, notes }, (finished) => this.afterChapterRun(finished, before));
    updateChapter(studio, chapterId, { status: "scripting" });
    return run;
  }

  private afterChapterRun(run: AgentRun, before: ChapterStatus) {
    const { studio } = this;
    const chapterId = run.targetId!;
    const written = listScenes(studio, run.projectId, chapterId).length > 0;
    const wasApproved = before === "in_production" || before === "done";
    // A list that was written or changed is looked at again before anything is built from it. A run that failed leaves the chapter as it was.
    const status: ChapterStatus = !written ? "planned" : run.status !== "done" && wasApproved ? before : "script_review";
    updateChapter(studio, chapterId, { status });
    syncChapterStatus(studio, chapterId);
    if (run.status === "done" && written) this.scriptNextChapter(run.projectId);
  }

  /** Write one chapter's scene list again, with your notes. An approved list goes back up for your approval. */
  reviseChapter(chapterId: string, notes: string): AgentRun {
    return this.scriptChapter(chapterId, notes);
  }

  /**
   * Approve one chapter's scene list. Its narration is recorded and its scenes are built
   * straight away, while later chapters are still being written.
   */
  approveChapter(chapterId: string): Chapter {
    const { studio } = this;
    const chapter = getChapter(studio, chapterId);
    const project = getProject(studio, chapter.projectId);
    if (project.stage !== "chapters" && project.stage !== "scenes") throw new Error("Scene lists are approved after the outline, the bible and the shared components.");
    if (chapter.status === "in_production" || chapter.status === "done") throw new Error("This chapter's scene list is already approved.");
    if (listRuns(studio, project.id, { active: true }).some((r) => r.targetKind === "chapter" && r.targetId === chapterId)) throw new Error("This chapter's scene list is still being written.");
    if (!listScenes(studio, project.id, chapterId).length) throw new Error("This chapter has no scenes yet.");
    updateChapter(studio, chapterId, { status: "in_production" });
    // With the last scene list approved, planning is over.
    if (project.stage === "chapters" && listChapters(studio, project.id).every((c) => c.status === "in_production" || c.status === "done")) {
      updateProject(studio, project.id, { stage: "scenes" });
    }
    this.detach(project.id, this.produce(project.id, chapterId));
    return syncChapterStatus(studio, chapterId);
  }

  /** Build the scenes of an approved chapter that are not built yet, or that failed. */
  buildChapter(chapterId: string) {
    const chapter = getChapter(this.studio, chapterId);
    if (chapter.status !== "in_production" && chapter.status !== "done") throw new Error("Approve this chapter's scene list first.");
    this.detach(chapter.projectId, this.produce(chapter.projectId, chapterId));
  }

  /** Join one chapter's scenes into a video to watch, using each scene as it stands now. */
  previewChapter(chapterId: string): Promise<AssembleResult> {
    return this.assemble(getChapter(this.studio, chapterId).projectId, { chapterId, quality: "preview" });
  }

  /** Approve the current stage and start the next one. Only people call this. */
  approveStage(projectId: string, notes = ""): Project {
    const { studio } = this;
    const status = this.stageStatus(projectId);
    if (status.waitingOn.length) throw new Error(`This stage is not ready to approve:\n  - ${status.waitingOn.join("\n  - ")}`);
    const next = (stage: Project["stage"]) => updateProject(studio, projectId, { stage });
    switch (status.stage) {
      case "outline":
        approveDocument(studio, latestDocument(studio, projectId, "outline")!.id, notes);
        next("bible");
        break;
      case "bible":
        approveDocument(studio, latestDocument(studio, projectId, "bible")!.id, notes);
        // With nothing to build, the foundation stage would only be a button to press.
        next(listShared(studio, projectId).length ? "foundation" : "chapters");
        break;
      case "foundation":
        for (const s of listShared(studio, projectId)) approveShared(studio, projectId, s.name, notes);
        next("chapters");
        break;
      case "chapters":
        // Approves every scene list that has not been approved chapter by chapter.
        for (const c of listChapters(studio, projectId)) {
          if (c.status !== "in_production" && c.status !== "done") updateChapter(studio, c.id, { status: "in_production" });
        }
        next("scenes");
        break;
      case "scenes":
        for (const c of listChapters(studio, projectId)) updateChapter(studio, c.id, { status: "done" });
        next("assembly");
        break;
      case "assembly":
        next("done");
        break;
      case "done":
        throw new Error("The video is already finished.");
    }
    this.startStage(projectId);
    return getProject(studio, projectId);
  }

  // ---------- Scenes ----------

  /**
   * Record narration in one pass, then build each scene that has not been built: for one
   * chapter, or for every chapter whose scene list is approved.
   */
  async produce(projectId: string, chapterId?: string) {
    const { studio } = this;
    const ready = () => {
      const unapproved = new Set(listChapters(studio, projectId).filter((c) => c.status === "scripting" || c.status === "script_review").map((c) => c.id));
      return listScenes(studio, projectId, chapterId).filter((s) => !unapproved.has(s.chapterId));
    };
    await this.lanes.run("light", () => ensureVoice(studio, ready().map((s) => s.id)));
    const active = new Set(listRuns(studio, projectId, { active: true }).map((r) => r.targetId));
    for (const scene of ready()) {
      if (active.has(scene.id)) continue;
      if (scene.status === "planned" || scene.status === "spec_ready" || scene.status === "failed") this.buildScene(scene.id);
    }
  }

  /** Have an agent build a scene, then render it for review. With `notes`, it changes the scene it built before. */
  buildScene(sceneId: string, notes?: string): AgentRun {
    const { studio } = this;
    const scene = getScene(studio, sceneId);
    const run = this.startRun({ projectId: scene.projectId, kind: "scene", targetId: sceneId, notes }, (finished) => this.afterSceneRun(finished));
    setSceneStatus(studio, sceneId, "in_production");
    return run;
  }

  private async afterSceneRun(run: AgentRun) {
    const { studio } = this;
    const sceneId = run.targetId!;
    const version = currentVersion(studio, getScene(studio, sceneId));
    if (run.status === "cancelled") return setSceneStatus(studio, sceneId, "failed", "The run was cancelled.");
    if (run.status !== "done") return setSceneStatus(studio, sceneId, "failed", run.error ?? "The run failed.");
    if (!version?.summary) {
      const problems = version?.checkProblems.length ? ` Its last check reported: ${version.checkProblems.slice(0, 3).join("; ")}` : "";
      return setSceneStatus(studio, sceneId, "failed", `The agent finished without handing the scene over.${problems}`);
    }
    try {
      await this.renderScene(sceneId);
    } catch {
      // renderScene has already marked the scene failed.
    }
  }

  /** Ask for changes to a scene: a new version is started and the agent that built it continues with your notes. */
  reviseScene(sceneId: string, notes: string): AgentRun {
    if (!notes.trim()) throw new Error("Say what should change.");
    reviseScene(this.studio, sceneId, notes.trim());
    return this.buildScene(sceneId, notes.trim());
  }

  approveScene(sceneId: string, notes = ""): Scene {
    return approveScene(this.studio, sceneId, notes);
  }

  /**
   * Render a scene's clip and the review copy with narration, and put the scene up for
   * review. Also what brings a stale scene up to date after a shared component changed.
   */
  async renderScene(sceneId: string, quality: ClipQuality = "preview"): Promise<Clip> {
    const { studio } = this;
    const scene = getScene(studio, sceneId);
    return this.job(scene.projectId, "clip", sceneId, async (progress) => {
      try {
        const { clip } = await renderSceneClip(studio, sceneId, quality, progress);
        await this.reviewCopy(sceneId, clip);
        if (getScene(studio, sceneId).status !== "approved") setSceneStatus(studio, sceneId, "needs_review");
        return clip;
      } catch (err) {
        setSceneStatus(studio, sceneId, "failed", `Rendering failed: ${(err as Error).message.split("\n")[0]}`);
        throw err;
      }
    });
  }

  /**
   * Bring every out-of-date scene up to date in one go. Each is rendered again with the
   * shared components as they are now, and goes back up for your review. No agent runs.
   */
  rebuildStale(projectId: string): string[] {
    const { studio } = this;
    const stale = listScenes(studio, projectId).filter((s) => s.status === "stale");
    for (const scene of stale) {
      // Marked first, so asking twice does not render twice.
      setSceneStatus(studio, scene.id, "in_production");
      void this.track(this.renderScene(scene.id)).catch(() => undefined); // renderScene marks the scene failed, with the reason.
    }
    return stale.map((s) => s.id);
  }

  /** The clip with its narration and its sound effects, for watching in the GUI. Clips themselves stay silent so they can be joined. */
  private async reviewCopy(sceneId: string, clip: Clip) {
    const { studio } = this;
    const version = getVersion(studio, clip.sceneVersionId);
    const project = getProject(studio, getScene(studio, sceneId).projectId);
    const p = projectPaths(studio, project);
    const out = versionPaths(studio, project, version).review(clip.quality);
    const args = ["-y", "-i", p.abs(clip.path)];
    const work = path.join(p.work, sceneId, `review-sound-${clip.quality}`);
    try {
      if (version.voiceTrackId && getVoiceTrack(studio, version.voiceTrackId)) {
        // The scene by itself, without the video's music: what is reviewed here is the scene.
        const quiet = { ...project, settings: { ...project.settings, music: { ...project.settings.music, assetId: null } } };
        const mix = mixArgs(await buildSoundtrack(studio, quiet, [{ versionId: version.id, startFrame: 0, frames: clip.durationFrames }], work), 1);
        args.push(...mix.inputs);
        if (mix.filter) args.push("-filter_complex", mix.filter);
        args.push("-map", "0:v", "-map", mix.map, "-c:a", "aac", "-b:a", "128k", "-ar", "48000");
      }
      await ffmpeg([...args, "-c:v", "copy", "-movflags", "+faststart", out]);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /** Join the scenes into the video. Scenes whose clips are missing are rendered first. */
  assemble(projectId: string, opts: Omit<AssembleOptions, "onProgress" | "log"> = {}): Promise<AssembleResult> {
    return this.job(projectId, "assemble", opts.chapterId ?? null, (progress) =>
      assemble(this.studio, projectId, { ...opts, concurrency: this.studio.config.studio.lanes.renders, onProgress: (done, total) => progress(total ? done / total : 0) }),
    );
  }

  /** Run something in the render lane, with a row in the jobs table so the GUI can show it. */
  private job<T>(projectId: string, kind: string, targetId: string | null, work: (progress: (p: number) => void) => Promise<T>): Promise<T> {
    const { studio } = this;
    const id = newId("job");
    studio.db.run("INSERT INTO jobs (id, project_id, kind, target_id, queued_at) VALUES (?, ?, ?, ?, ?)", [id, projectId, kind, targetId, nowIso()]);
    const changed = (status: string) => studio.emit("job.changed", { projectId, targetId: id, data: { kind, target: targetId, status } });
    changed("queued");
    return this.track(
      this.lanes.run("renders", async () => {
        studio.db.run("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", [nowIso(), id]);
        changed("running");
        let last = 0;
        try {
          const result = await work((p) => {
            // Progress arrives every frame; the database only needs it a few times a second.
            if (Date.now() - last < 400) return;
            last = Date.now();
            studio.db.run("UPDATE jobs SET progress = ? WHERE id = ?", [p, id]);
            studio.emit("job.progress", { projectId, targetId: id, data: { kind, target: targetId, progress: p } });
          });
          studio.db.run("UPDATE jobs SET status = 'done', progress = 1, finished_at = ? WHERE id = ?", [nowIso(), id]);
          changed("done");
          return result;
        } catch (err) {
          studio.db.run("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", [(err as Error).message, nowIso(), id]);
          changed("failed");
          throw err;
        }
      }),
    );
  }
}

// ---------- One studio at work per workspace ----------

const ownerFile = (studio: Studio) => path.join(studio.workspaceDir, "studio.owner");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // No permission to signal it still means it exists.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Note that this process runs the workspace's work. False when another live process already
 * does: then this one is a visitor, and must not treat that process's runs as abandoned.
 */
function claimWorkspace(studio: Studio): boolean {
  const file = ownerFile(studio);
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    if (pid && pid !== process.pid && alive(pid)) return false;
  } catch {
    // No owner yet.
  }
  try {
    fs.writeFileSync(file, String(process.pid));
  } catch {
    // A workspace that cannot be written to will say so soon enough.
  }
  return true;
}

function releaseWorkspace(studio: Studio) {
  const file = ownerFile(studio);
  try {
    if (Number(fs.readFileSync(file, "utf8").trim()) === process.pid) fs.rmSync(file);
  } catch {
    // Already gone.
  }
}
