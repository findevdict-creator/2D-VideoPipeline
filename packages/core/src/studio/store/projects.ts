import fs from "node:fs";
import path from "node:path";
import { slugify } from "../../production.js";
import { dimensions } from "../../render/project.js";
import { newId, nowIso } from "../ids.js";
import { NewProjectSchema, ProjectSettingsSchema, type NewProject, type ProjectSettings, type ProjectStage } from "../model/project.js";
import type { Studio } from "../studio.js";
import { fromRow, fromRows } from "./mapping.js";

export interface Project {
  id: string;
  slug: string;
  title: string;
  description: string;
  aspect: "16:9" | "9:16" | "1:1";
  width: number;
  height: number;
  fps: number;
  targetDurationSec: number;
  stage: ProjectStage;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
}

/** Where a project's files live. Database rows store paths relative to `dir`, with forward slashes. */
export function projectPaths(studio: Studio, project: Pick<Project, "slug">) {
  const dir = studio.projectDir(project.slug);
  const at = (...parts: string[]) => path.join(dir, ...parts);
  return {
    dir,
    at,
    /** Turn a stored relative path into a full one. */
    abs: (relative: string) => path.join(dir, ...relative.split("/")),
    rel: (absolute: string) => path.relative(dir, absolute).split(path.sep).join("/"),
    assets: at("assets"),
    shared: at("shared"),
    sharedComponents: at("shared", "components"),
    docs: at("docs"),
    voice: (sceneId: string) => at("voice", sceneId),
    sceneDir: (sceneId: string) => at("scenes", sceneId),
    versionDir: (sceneId: string, version: number) => at("scenes", sceneId, `v${version}`),
    renders: at("renders"),
    exports: at("exports"),
    runs: at("runs"),
    work: at(".work"),
  };
}

export function createProject(studio: Studio, input: NewProject): Project {
  const data = NewProjectSchema.parse(input);
  const title = data.title ?? titleFrom(data.description);
  const base = slugify(title, 6);
  let slug = base;
  for (let n = 2; studio.db.get("SELECT 1 FROM projects WHERE slug = ?", [slug]) || fs.existsSync(studio.projectDir(slug)); n++) {
    slug = `${base}-${n}`;
  }
  const fps = data.fps ?? studio.config.render.fps;
  const { width, height } = dimensions(data.aspect, studio.config.render.resolution);
  const settings = ProjectSettingsSchema.parse({
    voice: { kokoroVoice: studio.config.voice.voice },
    captions: studio.config.render.captions.enabled,
    ...data.settings,
  });
  const id = newId("prj");
  const stamp = nowIso();
  studio.db.run(
    `INSERT INTO projects (id, slug, title, description, aspect, width, height, fps, target_duration_sec, stage, settings_json, created_at, updated_at)
     VALUES (:id, :slug, :title, :description, :aspect, :width, :height, :fps, :target, 'outline', :settings, :stamp, :stamp)`,
    { id, slug, title, description: data.description.trim(), aspect: data.aspect, width, height, fps, target: data.targetDurationSec, settings: JSON.stringify(settings), stamp },
  );
  const project = getProject(studio, id);
  const p = projectPaths(studio, project);
  for (const dir of [p.assets, p.sharedComponents, p.docs, p.renders, p.runs]) fs.mkdirSync(dir, { recursive: true });
  studio.emit("project.created", { projectId: id });
  return project;
}

export function getProject(studio: Studio, idOrSlug: string): Project {
  const row = studio.db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ? OR slug = ?", [idOrSlug, idOrSlug]);
  if (!row) throw new Error(`No project called "${idOrSlug}"`);
  return fromRow<Project>(row)!;
}

export function listProjects(studio: Studio): Project[] {
  return fromRows<Project>(studio.db.all("SELECT * FROM projects ORDER BY created_at DESC"));
}

export function updateProject(
  studio: Studio,
  id: string,
  patch: { title?: string; description?: string; stage?: ProjectStage; targetDurationSec?: number; settings?: Partial<ProjectSettings> },
): Project {
  const current = getProject(studio, id);
  const settings = patch.settings ? ProjectSettingsSchema.parse({ ...current.settings, ...patch.settings }) : current.settings;
  studio.db.run(
    `UPDATE projects SET title = :title, description = :description, stage = :stage, target_duration_sec = :target,
       settings_json = :settings, updated_at = :stamp WHERE id = :id`,
    {
      id: current.id,
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      stage: patch.stage ?? current.stage,
      target: patch.targetDurationSec ?? current.targetDurationSec,
      settings: JSON.stringify(settings),
      stamp: nowIso(),
    },
  );
  studio.emit("project.updated", { projectId: current.id });
  return getProject(studio, current.id);
}

function titleFrom(description: string): string {
  const firstLine = description.trim().split(/\r?\n/)[0]!.replace(/[.!?]+$/, "");
  const words = firstLine.split(/\s+/).slice(0, 8).join(" ");
  return words.length > 80 ? words.slice(0, 80) : words;
}
