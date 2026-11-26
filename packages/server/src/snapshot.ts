import fs from "node:fs";
import { listRenders } from "@studio/core/studio/assemble";
import type { Studio } from "@studio/core/studio/studio";
import { listAssets, listProjectReferences } from "@studio/core/studio/store/assets";
import { listChapters } from "@studio/core/studio/store/chapters";
import { listDocuments, readDocument } from "@studio/core/studio/store/documents";
import { getProject, listProjects, projectPaths, type Project } from "@studio/core/studio/store/projects";
import { listRuns } from "@studio/core/studio/store/runs";
import { getScene, listReviews, listScenes, listVersions, readSource, sceneLabel, sceneNarration, versionPaths, type Scene, type SceneVersion } from "@studio/core/studio/store/scenes";
import { listShared, listSharedRequests, readShared, sharedVersions } from "@studio/core/studio/store/shared";
import { getVoiceTrack } from "@studio/core/studio/voice";
import { availableSceneTypes } from "@studio/core/studio/renderers/registry";
import { SCENE_TYPE_GUIDE } from "@studio/core/studio/tools/index";
import type { Orchestrator } from "@studio/core/studio/workflow";

/** Turns a path inside a project folder into the URL the GUI loads it from. The time stamp defeats stale caches. */
function fileUrl(studio: Studio, project: Project, relative: string | null | undefined): string | null {
  if (!relative) return null;
  const abs = projectPaths(studio, project).abs(relative);
  if (!fs.existsSync(abs)) return null;
  return `/files/${encodeURIComponent(project.slug)}/${relative.split("/").map(encodeURIComponent).join("/")}?t=${Math.round(fs.statSync(abs).mtimeMs)}`;
}

function versionView(studio: Studio, project: Project, v: SceneVersion) {
  const p = projectPaths(studio, project);
  const paths = versionPaths(studio, project, v);
  const clips = studio.db.all<{ quality: string; path: string }>("SELECT quality, path FROM clips WHERE scene_version_id = ?", [v.id]);
  const track = v.voiceTrackId ? getVoiceTrack(studio, v.voiceTrackId) : undefined;
  return {
    id: v.id,
    version: v.version,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    summary: v.summary,
    checkProblems: v.checkProblems,
    durationSec: track?.durationSec ?? null,
    stills: v.stills.map((s) => ({ frame: s.frame, url: fileUrl(studio, project, s.file) })).filter((s) => s.url),
    reviewUrl: fileUrl(studio, project, p.rel(paths.review("preview"))),
    hasClip: clips.length > 0,
  };
}

export function sceneCard(studio: Studio, project: Project, scene: Scene) {
  const versions = listVersions(studio, scene.id);
  const current = versions.find((v) => v.id === scene.currentVersionId);
  return {
    id: scene.id,
    chapterId: scene.chapterId,
    label: sceneLabel(studio, scene),
    title: scene.title,
    type: scene.type,
    status: scene.status,
    reason: scene.staleReason,
    narration: sceneNarration(studio, scene),
    visualIdea: scene.plan.visualIdea ?? "",
    purpose: scene.plan.purpose ?? "",
    version: current?.version ?? null,
    approvedVersion: versions.find((v) => v.id === scene.approvedVersionId)?.version ?? null,
    current: current ? versionView(studio, project, current) : null,
  };
}

/** Everything the scene page shows: every version, the spec, the code, and what was said in review. */
export function sceneDetail(studio: Studio, sceneId: string) {
  const scene = getScene(studio, sceneId);
  const project = getProject(studio, scene.projectId);
  const versions = listVersions(studio, scene.id);
  const current = versions.find((v) => v.id === scene.currentVersionId);
  return {
    ...sceneCard(studio, project, scene),
    spec: current?.spec ?? null,
    code: current ? (readSource(studio, project, current) ?? null) : null,
    versions: versions.map((v) => versionView(studio, project, v)).reverse(),
    reviews: listReviews(studio, "scene", scene.id).reverse(),
    runs: listRuns(studio, project.id, { targetId: scene.id, limit: 20 }),
  };
}

export function projectList(studio: Studio) {
  return listProjects(studio).map((p) => {
    const scenes = listScenes(studio, p.id);
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      description: p.description,
      stage: p.stage,
      targetDurationSec: p.targetDurationSec,
      updatedAt: p.updatedAt,
      scenes: scenes.length,
      approved: scenes.filter((s) => s.status === "approved").length,
    };
  });
}

/** One project, whole: what the GUI redraws from whenever something changes. */
export function projectSnapshot(studio: Studio, orchestrator: Orchestrator, idOrSlug: string) {
  const project = getProject(studio, idOrSlug);
  const refs = new Map(listProjectReferences(studio, project.id).map((r) => [r.assetId, r]));
  const documents = listDocuments(studio, project.id);
  const latest = (kind: string) => {
    const doc = documents.filter((d) => d.kind === kind).at(-1);
    if (!doc) return null;
    return { id: doc.id, version: doc.version, status: doc.status, markdown: readDocument(studio, doc), notes: listReviews(studio, "document", doc.id).map((r) => r.notes).filter(Boolean) };
  };
  return {
    project,
    stage: orchestrator.stageStatus(project.id),
    sceneTypes: availableSceneTypes().map((t) => ({ type: t, about: SCENE_TYPE_GUIDE[t] })),
    documents: { outline: latest("outline"), bible: latest("bible") },
    chapters: listChapters(studio, project.id),
    scenes: listScenes(studio, project.id).map((s) => sceneCard(studio, project, s)),
    shared: listShared(studio, project.id).map((s) => ({
      ...s,
      code: readShared(studio, project.id, s.name) ?? null,
      versions: sharedVersions(studio, s.id).map((v) => ({ version: v.version, notes: v.notes, createdAt: v.createdAt, previewUrl: fileUrl(studio, project, v.previewPath) })),
    })),
    sharedRequests: listSharedRequests(studio, project.id, "open"),
    assets: listAssets(studio, project.id).map((a) => ({ ...a, url: fileUrl(studio, project, a.path), reference: refs.get(a.id) ?? null })),
    runs: listRuns(studio, project.id, { limit: 60 }),
    jobs: studio.db.all("SELECT id, kind, target_id AS targetId, status, progress, error, queued_at AS queuedAt FROM jobs WHERE project_id = ? ORDER BY queued_at DESC, id DESC LIMIT 30", [project.id]),
    renders: listRenders(studio, project.id).map((r) => ({ ...r, url: fileUrl(studio, project, r.path), srtUrl: fileUrl(studio, project, r.srtPath) })),
  };
}
