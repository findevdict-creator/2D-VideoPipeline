import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { loadConfig, type RunnerKind } from "@studio/core/config";
import { importProduction } from "@studio/core/studio/importProduction";
import { Studio } from "@studio/core/studio/studio";
import { listChapters } from "@studio/core/studio/store/chapters";
import { createProject, getProject, listProjects } from "@studio/core/studio/store/projects";
import { listRuns, readRunLog } from "@studio/core/studio/store/runs";
import { Orchestrator } from "@studio/core/studio/workflow";
import { findScene, getScene, listScenes, sceneLabel } from "@studio/core/studio/store/scenes";
import { ensureVoice } from "@studio/core/studio/voice";
import { REFERENCE_ROLES } from "@studio/core/studio/model/asset";
import type { ModelInfo } from "@studio/core/studio/assets/gltf";
import { importAsset, listAssets, listProjectReferences, setProjectReference } from "@studio/core/studio/store/assets";
import { assemble } from "@studio/core/studio/assemble";
import { checkScene, renderSceneClip, renderSceneStills } from "@studio/core/studio/scenes/render";

const HELP = `Scene studio

Usage:
  npm run studio                                     open the studio in your browser (--port, --no-open)
  npm run studio -- new "<description>"              start a project (--minutes or --seconds for its length, --title)
  npm run studio -- status <project>                 where the project stands and what it is waiting on
  npm run studio -- start <project>                  run the current stage's work (--notes to ask for changes)
  npm run studio -- approve <project>                approve the current stage and start the next one
  npm run studio -- approve-chapter <project> <number>   approve one chapter's scene list and build its scenes
  npm run studio -- approve-scene <project> <scene|all>
  npm run studio -- revise <project> <scene> --notes "<what to change>"
  npm run studio -- refresh <project>                render every out-of-date scene again, after a shared part changed
  npm run studio -- projects                         list projects in the workspace
  npm run studio -- import <production-folder>       bring a pipeline production in as a project
  npm run studio -- scenes <project>                 list a project's scenes and their status
  npm run studio -- assets <project>                 list a project's images, clips, sounds and models
  npm run studio -- asset add <project> <file...>    add files to a project (--label, --reference style|layout|motion)
  npm run studio -- check <project> <scene>          report what would stop a scene from rendering
  npm run studio -- stills <project> <scene>         render still frames of a scene for a quick look
  npm run studio -- render <project> [scene...]      render scene clips (all scenes when none is named)
  npm run studio -- assemble <project>               join the scene clips into one video (--chapter <number> for one chapter)

A scene is named by its label, such as 1.3, or by its id.

Options:
  --workspace <folder>                   where studio.db and projects live (default: ~/VideoStudio, or STUDIO_WORKSPACE)
  --runner <claude-cli|mock>             how Claude runs: your Claude Code login, or a stand-in that writes fixed samples
  --model <name>                         model for every agent
  --final                                render or assemble at full quality (default: fast preview)
  --chapter <number>                     assemble one chapter only
  --label <text>                         name for an added asset
  --reference <style|layout|motion>      also mark an added asset as a reference for the whole video
  --note <text>                          what to take from the reference
  --notes <text>                         what should change, for start and revise
  -h, --help
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: "string" },
      runner: { type: "string" },
      model: { type: "string" },
      final: { type: "boolean", default: false },
      chapter: { type: "string" },
      label: { type: "string" },
      minutes: { type: "string" },
      seconds: { type: "string" },
      title: { type: "string" },
      notes: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean", default: false },
      reference: { type: "string" },
      note: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command = "serve", ...rest] = positionals;
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (command === "serve") return serveStudio(values);
  const config = studioConfig(values);
  const studio = new Studio(config, values.workspace);
  try {
    await run(studio, command, rest, { ...values, final: values.final });
  } finally {
    studio.close();
  }
}

async function run(studio: Studio, command: string, rest: string[], flags: { final: boolean; chapter?: string; label?: string; reference?: string; note?: string; minutes?: string; seconds?: string; title?: string; notes?: string }) {
  const log = (message: string) => console.log(message);
  const quality = flags.final ? "final" : "preview";
  if (command === "new") {
    const seconds = flags.seconds ? Number(flags.seconds) : flags.minutes ? Math.round(Number(flags.minutes) * 60) : undefined;
    const project = createProject(studio, { description: required(rest[0], "description"), title: flags.title, targetDurationSec: seconds });
    console.log(`Created project ${project.slug} ("${project.title}", ${project.targetDurationSec}s).\nNext: npm run studio -- start ${project.slug}`);
    return;
  }
  if (command === "status") {
    const project = getProject(studio, required(rest[0], "project"));
    const o = new Orchestrator(studio);
    printStatus(studio, o, project.id);
    o.stop();
    return;
  }
  if (command === "start" || command === "approve" || command === "approve-chapter" || command === "approve-scene" || command === "revise" || command === "refresh") {
    const project = getProject(studio, required(rest[0], "project"));
    const o = new Orchestrator(studio);
    if (command === "start") o.startStage(project.id, flags.notes);
    if (command === "approve") console.log(`Approved. The project is now at: ${o.approveStage(project.id, flags.notes).stage}`);
    if (command === "approve-chapter") {
      const chapter = chapterByNumber(studio, project.id, required(rest[1], "chapter number"));
      o.approveChapter(chapter.id);
      console.log(`Approved the scene list of chapter ${chapter.position}, "${chapter.title}". Building its scenes.`);
    }
    if (command === "approve-scene") {
      const which = required(rest[1], "scene");
      const scenes = which === "all" ? listScenes(studio, project.id).filter((s) => s.status === "needs_review") : [findScene(studio, project.id, which)];
      for (const scene of scenes) console.log(`Approved ${sceneLabel(studio, o.approveScene(scene.id, flags.notes))} ${scene.title}`);
    }
    if (command === "refresh") console.log(`Rendering ${o.rebuildStale(project.id).length} out-of-date scene(s) again.`);
    if (command === "revise") o.reviseScene(findScene(studio, project.id, required(rest[1], "scene")).id, required(flags.notes, "--notes"));
    await follow(studio, o, project.id);
    printStatus(studio, o, project.id);
    o.stop();
    return;
  }
  if (command === "projects") {
    const all = listProjects(studio);
    console.log(`Workspace: ${studio.workspaceDir}`);
    if (!all.length) console.log("No projects yet.");
    for (const p of all) console.log(`${p.slug.padEnd(40)} ${p.stage.padEnd(11)} ${p.title}`);
    return;
  }
  if (command === "import") {
    const result = await importProduction(studio, required(rest[0], "production folder"));
    console.log(
      `Imported "${result.project.title}" as project ${result.project.slug}: ${result.scenes} scenes, ` +
        `${result.withCode} with code, ${result.withVoice} with recorded narration.\nFolder: ${studio.projectDir(result.project.slug)}`,
    );
    return;
  }
  if (command === "scenes") {
    const project = getProject(studio, required(rest[0], "project"));
    for (const chapter of listChapters(studio, project.id)) {
      console.log(`\n${chapter.position}. ${chapter.title}`);
      for (const s of listScenes(studio, project.id, chapter.id)) {
        console.log(`  ${sceneLabel(studio, s).padEnd(6)} ${s.type.padEnd(13)} ${s.status.padEnd(14)} ${s.title}  (${s.id})`);
      }
    }
    return;
  }
  if (command === "assets") {
    const project = getProject(studio, required(rest[0], "project"));
    const refs = new Map(listProjectReferences(studio, project.id).map((r) => [r.assetId, r.role]));
    const all = listAssets(studio, project.id);
    if (!all.length) console.log("No assets yet.");
    for (const a of all) {
      const size = a.width ? `${a.width}x${a.height}` : "";
      const length = a.durationSec ? `${a.durationSec.toFixed(1)}s` : "";
      const ref = refs.has(a.id) ? `${refs.get(a.id)} reference` : "";
      console.log(`${a.id}  ${a.kind.padEnd(11)} ${[size, length].filter(Boolean).join(" ").padEnd(16)} ${a.label}  ${ref}`);
    }
    return;
  }
  if (command === "asset" && rest[0] === "add") {
    const project = getProject(studio, required(rest[1], "project"));
    const files = rest.slice(2);
    if (!files.length) throw new Error("Name at least one file to add.");
    const role = flags.reference;
    if (role && !(REFERENCE_ROLES as readonly string[]).includes(role)) throw new Error(`--reference must be one of: ${REFERENCE_ROLES.join(", ")}`);
    for (const file of files) {
      const asset = await importAsset(studio, project.id, file, { label: files.length === 1 ? flags.label : undefined });
      if (role) setProjectReference(studio, project.id, { assetId: asset.id, role: role as (typeof REFERENCE_ROLES)[number], note: flags.note ?? "" });
      console.log(`${asset.id}  ${asset.kind}  ${asset.label}${role ? `  (${role} reference)` : ""}`);
      const model = asset.meta.model as ModelInfo | undefined;
      if (model) {
        console.log(`  ${model.triangles.toLocaleString("en-US")} triangles, ${model.size.join(" x ")} units`);
        console.log(`  parts: ${model.parts.map((p) => p.name).join(", ") || "none with a name"}`);
        console.log(`  animations: ${model.animations.map((a) => `${a.name} (${a.durationSec}s)`).join(", ") || "none"}`);
        for (const warning of model.warnings) console.log(`  Warning: ${warning}`);
      }
    }
    return;
  }
  if (command === "check") {
    const project = getProject(studio, required(rest[0], "project"));
    const scene = findScene(studio, project.id, required(rest[1], "scene"));
    const problems = await checkScene(studio, scene.id, log);
    console.log(problems.length ? `Problems:\n  - ${problems.join("\n  - ")}` : "No problems found.");
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (command === "stills") {
    const project = getProject(studio, required(rest[0], "project"));
    const scene = findScene(studio, project.id, required(rest[1], "scene"));
    const stills = await renderSceneStills(studio, scene.id, {}, log);
    for (const s of stills) console.log(`frame ${String(s.frame).padStart(5)}  ${studio.projectDir(project.slug)}/${s.file}`);
    return;
  }
  if (command === "render") {
    const project = getProject(studio, required(rest[0], "project"));
    const scenes = rest.length > 1 ? rest.slice(1).map((ref) => findScene(studio, project.id, ref)) : listScenes(studio, project.id);
    await ensureVoice(studio, scenes.filter((s) => s.currentVersionId).map((s) => s.id), log);
    for (const scene of scenes) {
      const label = `${sceneLabel(studio, scene)} ${scene.title}`;
      const started = Date.now();
      const { clip, cached } = await renderSceneClip(studio, scene.id, quality, () => {}, log);
      const how = cached ? "unchanged, kept" : `rendered in ${((Date.now() - started) / 1000).toFixed(1)}s`;
      console.log(`${label}: ${clip.durationFrames} frames, ${how}  (${clip.path})`);
    }
    return;
  }
  if (command === "assemble") {
    const project = getProject(studio, required(rest[0], "project"));
    const chapter = flags.chapter ? chapterByNumber(studio, project.id, flags.chapter) : undefined;
    const result = await assemble(studio, project.id, { quality, chapterId: chapter?.id, log });
    console.log(`${result.rendered} clip(s) rendered, ${result.reused} reused. ${result.render.durationSec.toFixed(1)}s video: ${result.file}`);
    for (const s of result.skipped) console.log(`Left out ${s.label} ${s.title}: ${s.reason}`);
    return;
  }
  console.log(HELP);
  process.exitCode = 1;
}

/** Start the GUI server and keep it running until the terminal is closed. */
/** The studio runs Claude through Claude Code, so a run can be continued later. The API-key runner is for the older pipeline only. */
function studioConfig(values: { runner?: string; model?: string }) {
  const config = loadConfig({ runner: values.runner as RunnerKind | undefined, model: values.model });
  if (config.runner === "agent-sdk") {
    throw new Error('The studio does not use the agent-sdk runner yet. Use "claude-cli" (your Claude Code login) or "mock".');
  }
  return config;
}

async function serveStudio(values: { workspace?: string; runner?: string; model?: string; port?: string; "no-open"?: boolean }) {
  const { startServer } = await import("@studio/server/src/server");
  const config = studioConfig(values);
  const studio = new Studio(config, values.workspace);
  const server = await startServer(studio, { port: values.port ? Number(values.port) : undefined });
  console.log(`Scene Studio is running at ${server.url}\nProjects are kept in ${studio.workspaceDir}\nPress Ctrl+C to stop.`);
  if (config.runner === "mock") console.log("Using the stand-in runner: plans and scenes are fixed samples, and Claude is not called.");
  if (!values["no-open"]) openBrowser(server.url);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
  // Claude runs started from here end with the studio. What they saved stays, and they can be started again.
  server.orchestrator.stop();
  await Promise.race([server.orchestrator.idle(), new Promise((r) => setTimeout(r, 3000))]);
  studio.close();
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    // A missing opener is not worth stopping for: the address is printed above.
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // Same.
  }
}

/** Print what the runs say while they work, until everything has finished. */
async function follow(studio: Studio, o: Orchestrator, projectId: string) {
  const seen = new Map<string, number>();
  let done = false;
  const idle = o.idle().then(() => (done = true));
  const print = () => {
    for (const run of listRuns(studio, projectId, { limit: 50 }).reverse()) {
      const log = readRunLog(studio, run.id, seen.get(run.id) ?? 0);
      seen.set(run.id, log.next);
      const who = run.targetKind === "scene" ? `scene ${sceneLabel(studio, getScene(studio, run.targetId!))}` : run.targetKind;
      for (const line of log.lines) console.log(`[${who}] ${line.kind === "tool" ? "> " : line.kind === "result" ? "  " : ""}${line.text.split("\n")[0]!.slice(0, 200)}`);
    }
  };
  for (const run of listRuns(studio, projectId, { limit: 500 })) if (!["queued", "running"].includes(run.status)) seen.set(run.id, Number.MAX_SAFE_INTEGER);
  while (!done) {
    print();
    await new Promise((r) => setTimeout(r, 700));
  }
  await idle;
  print();
}

function chapterByNumber(studio: Studio, projectId: string, number: string) {
  const chapter = listChapters(studio, projectId).find((c) => String(c.position) === number);
  if (!chapter) throw new Error(`There is no chapter ${number} in this project.`);
  return chapter;
}

const CHAPTER_STATUS: Record<string, string> = {
  planned: "not written yet",
  scripting: "being written",
  script_review: "scene list waiting for your approval",
  in_production: "in production",
  done: "done",
};

function printStatus(studio: Studio, o: Orchestrator, projectId: string) {
  const status = o.stageStatus(projectId);
  console.log(`\nStage: ${status.stage}. ${status.about}`);
  const scenes = listScenes(studio, projectId);
  for (const chapter of listChapters(studio, projectId)) {
    console.log(`Chapter ${chapter.position}: ${chapter.title}  (${CHAPTER_STATUS[chapter.status] ?? chapter.status})`);
    for (const scene of scenes.filter((s) => s.chapterId === chapter.id)) {
      console.log(`  ${sceneLabel(studio, scene).padEnd(6)} ${scene.type.padEnd(13)} ${scene.status.padEnd(14)} ${scene.title}${scene.staleReason ? `  (${scene.staleReason})` : ""}`);
    }
  }
  if (status.waitingOn.length) console.log(`Waiting on:\n  - ${status.waitingOn.join("\n  - ")}`);
  else if (status.stage !== "done") console.log("Ready for you to approve.");
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}. Run with --help for usage.`);
  return value;
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
