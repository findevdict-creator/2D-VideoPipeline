import fs from "node:fs";
import path from "node:path";
import { assemble, type AssembleOptions, type AssembleResult } from "./assemble.js";
import { newId, nowIso } from "./ids.js";
import { ffmpeg } from "./media/ffmpeg.js";
import { Lanes } from "./runs/lanes.js";
import { MockStudioRunner } from "./runs/mock.js";
import { agentFor, systemPrompt, taskPrompt } from "./runs/prompts.js";
import { ClaudeCliStudioRunner, type StudioRunner } from "./runs/runner.js";
import { renderSceneClip } from "./scenes/render.js";
import type { Studio } from "./studio.js";
import { getChapter, listChapters, updateChapter } from "./store/chapters.js";
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

  constructor(
    readonly studio: Studio,
    runner?: StudioRunner,
  ) {
    this.lanes = new Lanes(studio.config.studio.lanes);
    this.runner = runner ?? (studio.config.runner === "mock" ? new MockStudioRunner() : new ClaudeCliStudioRunner(studio.config.claudeBin));
    failInterruptedRuns(studio);
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
    try {
      let result;
      try {
        result = await this.runner.run(studio, { ...request, resumeSessionId: run.payload.resumeFrom });
      } catch (err) {
        // A session from another computer, or one Claude Code has cleaned up, cannot be resumed. Start fresh.
        if (!run.payload.resumeFrom || signal.aborted || !/conversation|session|resume/i.test((err as Error).message)) throw err;
        log("info", "The earlier session could not be continued, so this run starts fresh.");
        result = await this.runner.run(studio, request);
      }
      return updateRun(studio, runId, {
        status: "done",
        resultText: result.text,
        claudeSessionId: result.sessionId ?? run.claudeSessionId,
        costUsd: result.costUsd ?? null,
        durationMs: result.durationMs ?? Date.now() - started,
        finishedAt: nowIso(),
      });
    } catch (err) {
      const message = (err as Error).message;
      log("error", message);
      return updateRun(studio, runId, { status: signal.aborted ? "cancelled" : "failed", error: message, durationMs: Date.now() - started, finishedAt: nowIso() });
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
        const open = scenes.filter((s) => s.status !== "approved");
        if (open.length) waitingOn.push(`${open.length} of ${scenes.length} scenes are not approved yet.`);
        break;
      }
      case "assembly":
        if (!studio.db.get("SELECT 1 FROM renders WHERE project_id = ? AND kind = 'final' AND scope = 'project'", [projectId])) waitingOn.push("The final video has not been rendered yet.");
        break;
    }
    if (active.length && project.stage !== "scenes") waitingOn.unshift(`${active.length} run(s) still working.`);
    return { stage: project.stage, about: ABOUT[project.stage], running: active.length, waitingOn };
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
        const scenes = listScenes(studio, projectId);
        return listChapters(studio, projectId)
          .filter((c) => notes || !scenes.some((s) => s.chapterId === c.id))
          .map((c) => this.startRun({ projectId, kind: "chapter", targetId: c.id, notes }));
      }
      case "scenes":
        this.detach(projectId, this.produce(projectId));
        return [];
      default:
        return [];
    }
  }

  /** Write one chapter's scene list again, with your notes. */
  reviseChapter(chapterId: string, notes: string): AgentRun {
    const chapter = getChapter(this.studio, chapterId);
    return this.startRun({ projectId: chapter.projectId, kind: "chapter", targetId: chapterId, notes });
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
        for (const c of listChapters(studio, projectId)) updateChapter(studio, c.id, { status: "in_production" });
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

  /** Record narration for every scene in one pass, then build each scene that has not been built. */
  async produce(projectId: string) {
    const { studio } = this;
    const scenes = listScenes(studio, projectId);
    await this.lanes.run("light", () => ensureVoice(studio, scenes.map((s) => s.id)));
    const active = new Set(listRuns(studio, projectId, { active: true }).map((r) => r.targetId));
    for (const scene of listScenes(studio, projectId)) {
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

  /** The clip with its narration, for watching in the GUI. Clips themselves stay silent so they can be joined. */
  private async reviewCopy(sceneId: string, clip: Clip) {
    const { studio } = this;
    const version = getVersion(studio, clip.sceneVersionId);
    const project = getProject(studio, getScene(studio, sceneId).projectId);
    const p = projectPaths(studio, project);
    const track = version.voiceTrackId ? getVoiceTrack(studio, version.voiceTrackId) : undefined;
    const out = versionPaths(studio, project, version).review(clip.quality);
    const args = ["-y", "-i", p.abs(clip.path)];
    if (track) args.push("-i", p.abs(track.audioPath), "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "128k", "-ar", "48000");
    await ffmpeg([...args, "-c:v", "copy", "-movflags", "+faststart", out]);
  }

  /** Join the scenes into the video. Scenes whose clips are missing are rendered first. */
  assemble(projectId: string, opts: Omit<AssembleOptions, "onProgress" | "log"> = {}): Promise<AssembleResult> {
    return this.job(projectId, "assemble", opts.chapterId ?? null, (progress) =>
      assemble(this.studio, projectId, { ...opts, onProgress: (done, total) => progress(total ? done / total : 0) }),
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
