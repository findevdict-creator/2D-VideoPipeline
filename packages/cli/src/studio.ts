import { parseArgs } from "node:util";
import { loadConfig, type RunnerKind } from "@studio/core/config";
import { importProduction } from "@studio/core/studio/importProduction";
import { Studio } from "@studio/core/studio/studio";
import { listChapters } from "@studio/core/studio/store/chapters";
import { getProject, listProjects } from "@studio/core/studio/store/projects";
import { findScene, listScenes, sceneLabel } from "@studio/core/studio/store/scenes";
import { ensureVoice } from "@studio/core/studio/voice";
import { assemble } from "@studio/core/studio/assemble";
import { checkScene, renderSceneClip, renderSceneStills } from "@studio/core/studio/scenes/render";

const HELP = `Scene studio

Usage:
  npm run studio -- projects                         list projects in the workspace
  npm run studio -- import <production-folder>       bring a pipeline production in as a project
  npm run studio -- scenes <project>                 list a project's scenes and their status
  npm run studio -- check <project> <scene>          report what would stop a scene from rendering
  npm run studio -- stills <project> <scene>         render still frames of a scene for a quick look
  npm run studio -- render <project> [scene...]      render scene clips (all scenes when none is named)
  npm run studio -- assemble <project>               join the scene clips into one video

A scene is named by its label, such as 1.3, or by its id.

Options:
  --workspace <folder>                   where studio.db and projects live (default: ~/VideoStudio, or STUDIO_WORKSPACE)
  --runner <claude-cli|agent-sdk|mock>   how agents run
  --model <name>                         model for every agent
  --final                                render or assemble at full quality (default: fast preview)
  --chapter <number>                     assemble one chapter only
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
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return;
  }
  const config = loadConfig({ runner: values.runner as RunnerKind | undefined, model: values.model });
  const studio = new Studio(config, values.workspace);
  try {
    await run(studio, command, rest, { final: values.final, chapter: values.chapter });
  } finally {
    studio.close();
  }
}

async function run(studio: Studio, command: string, rest: string[], flags: { final: boolean; chapter?: string }) {
  const log = (message: string) => console.log(message);
  const quality = flags.final ? "final" : "preview";
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
    const chapter = flags.chapter ? listChapters(studio, project.id).find((c) => String(c.position) === flags.chapter) : undefined;
    if (flags.chapter && !chapter) throw new Error(`There is no chapter ${flags.chapter} in this project.`);
    const result = await assemble(studio, project.id, { quality, chapterId: chapter?.id, log });
    console.log(`${result.rendered} clip(s) rendered, ${result.reused} reused. ${result.render.durationSec.toFixed(1)}s video: ${result.file}`);
    for (const s of result.skipped) console.log(`Left out ${s.label} ${s.title}: ${s.reason}`);
    return;
  }
  console.log(HELP);
  process.exitCode = 1;
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}. Run with --help for usage.`);
  return value;
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
