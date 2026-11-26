import { parseArgs } from "node:util";
import { loadConfig, type RunnerKind } from "@studio/core/config";
import { importProduction } from "@studio/core/studio/importProduction";
import { Studio } from "@studio/core/studio/studio";
import { listChapters } from "@studio/core/studio/store/chapters";
import { getProject, listProjects } from "@studio/core/studio/store/projects";
import { listScenes, sceneLabel } from "@studio/core/studio/store/scenes";

const HELP = `Scene studio

Usage:
  npm run studio -- projects                         list projects in the workspace
  npm run studio -- import <production-folder>       bring a pipeline production in as a project
  npm run studio -- scenes <project>                 list a project's scenes and their status

Options:
  --workspace <folder>                   where studio.db and projects live (default: ~/VideoStudio, or STUDIO_WORKSPACE)
  --runner <claude-cli|agent-sdk|mock>   how agents run
  --model <name>                         model for every agent
  -h, --help
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: "string" },
      runner: { type: "string" },
      model: { type: "string" },
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
    await run(studio, command, rest);
  } finally {
    studio.close();
  }
}

async function run(studio: Studio, command: string, rest: string[]) {
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
