import fs from "node:fs";
import { listRenders, scenesChangedSince } from "@studio/core/studio/assemble";
import type { Studio } from "@studio/core/studio/studio";
import { referenceKeyframes } from "@studio/core/studio/assets/keyframes";
import { findAsset, listAssets, listProjectReferences, listSceneReferences } from "@studio/core/studio/store/assets";
import { listChapters } from "@studio/core/studio/store/chapters";
import { listDocuments, readDocument } from "@studio/core/studio/store/documents";
import { FONTS, PALETTE_USE, PALETTES, paletteWarnings } from "@studio/core/studio/model/project";
import { getProject, listProjects, projectPaths, type Project } from "@studio/core/studio/store/projects";
import { listRuns } from "@studio/core/studio/store/runs";
import { getScene, listReviews, listScenes, listVersions, readSource, sceneLabel, sceneNarration, versionByNumber, versionPaths, type Scene, type SceneVersion } from "@studio/core/studio/store/scenes";
import { compareVersions } from "@studio/core/studio/scenes/compare";
import { EXPORT_FORMATS, exportSize, listExports, type ExportFormat } from "@studio/core/studio/export";
import { characterInfo, listShared, listSharedRequests, readShared, sharedVersions } from "@studio/core/studio/store/shared";
import { getVoiceTrack } from "@studio/core/studio/voice";
import type { ModelInfo } from "@studio/core/studio/assets/gltf";
import { modelThumbnail } from "@studio/core/studio/renderers/modelPreview";
import { availableSceneTypes, unavailableSceneTypes } from "@studio/core/studio/renderers/registry";
import { SCENE_TYPE_GUIDE } from "@studio/core/studio/tools/index";
import type { Orchestrator } from "@studio/core/studio/workflow";

/** Turns a path inside a project folder into the URL the GUI loads it from. The time stamp defeats stale caches. */
export function fileUrl(studio: Studio, project: Project, relative: string | null | undefined): string | null {
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
    checkNotes: v.checkNotes,
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

/** The frames of a reference video worth looking at, as the GUI loads them. */
export async function assetKeyframes(studio: Studio, assetId: string, max?: number) {
  const asset = listAssetsById(studio, assetId);
  const project = getProject(studio, asset.projectId);
  const p = projectPaths(studio, project);
  const result = await referenceKeyframes(studio, assetId, { max });
  return {
    durationSec: result.durationSec,
    sheetUrl: result.sheet ? fileUrl(studio, project, p.rel(result.sheet)) : null,
    keyframes: result.keyframes.map((k) => ({ index: k.index, atSec: k.atSec, shotStartSec: k.shotStartSec, shotEndSec: k.shotEndSec, url: fileUrl(studio, project, p.rel(k.file)) })),
  };
}

function listAssetsById(studio: Studio, assetId: string) {
  const row = studio.db.get<{ project_id: string }>("SELECT project_id FROM assets WHERE id = ?", [assetId]);
  const asset = row ? findAsset(studio, row.project_id, assetId) : undefined;
  if (!asset) throw new Error(`No asset with the id "${assetId}"`);
  return asset;
}

/** The references attached to one scene, each with the picture the person picked. */
async function sceneReferences(studio: Studio, project: Project, sceneId: string) {
  const p = projectPaths(studio, project);
  const out = [];
  for (const ref of listSceneReferences(studio, sceneId)) {
    const asset = findAsset(studio, project.id, ref.assetId);
    let pictureUrl: string | null = null;
    try {
      if (asset?.kind === "image") pictureUrl = fileUrl(studio, project, asset.path);
      else if (asset?.kind === "video") {
        const frames = (await referenceKeyframes(studio, asset.id, { include: ref.atSec != null ? [ref.atSec] : [] })).keyframes;
        const frame = frames.find((k) => k.asked) ?? frames[0];
        if (frame) pictureUrl = fileUrl(studio, project, p.rel(frame.file));
      }
    } catch {
      // A clip that cannot be read still shows as a reference, without its picture.
    }
    out.push({ ...ref, label: asset?.label ?? "(removed)", kind: asset?.kind ?? "other", pictureUrl });
  }
  return out;
}

/** Everything the scene page shows: every version, the spec, the code, and what was said in review. */
export async function sceneDetail(studio: Studio, sceneId: string) {
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
    references: await sceneReferences(studio, project, scene.id),
  };
}

/** Two versions of a scene next to each other: what each looks like, and what differs. */
export function sceneComparison(studio: Studio, sceneId: string, a: number, b: number) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) throw new Error("Name the two versions to compare by their numbers.");
  const scene = getScene(studio, sceneId);
  const project = getProject(studio, scene.projectId);
  const comparison = compareVersions(studio, sceneId, a, b);
  return {
    ...comparison,
    versions: [versionView(studio, project, versionByNumber(studio, sceneId, comparison.before)), versionView(studio, project, versionByNumber(studio, sceneId, comparison.after))],
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
  const scenes = listScenes(studio, project.id);
  const renders = listRenders(studio, project.id);
  return {
    project,
    stage: orchestrator.stageStatus(project.id),
    /** Set while work is on hold for Claude's usage limit. */
    usage: orchestrator.usagePause(),
    /** What the look editor offers: ready-made colour schemes, fonts, and what each colour is for. */
    colours: { schemes: PALETTES, fonts: FONTS, use: PALETTE_USE, warnings: paletteWarnings(project.settings.theme.palette) },
    sceneTypes: availableSceneTypes(studio).map((t) => ({ type: t, about: SCENE_TYPE_GUIDE[t] })),
    /** Scene types this machine cannot build until something is installed. */
    missingSceneTypes: unavailableSceneTypes(studio).map((t) => ({ ...t, about: SCENE_TYPE_GUIDE[t.type] })),
    documents: { outline: latest("outline"), bible: latest("bible") },
    chapters: listChapters(studio, project.id).map((c) => {
      // The newest video made of this chapter alone, and whether its scenes have changed since.
      const preview = renders.find((r) => r.scope === c.id);
      const current = preview !== undefined && scenesChangedSince(studio, preview) === 0;
      return { ...c, preview: preview ? { url: fileUrl(studio, project, preview.path), durationSec: preview.durationSec, createdAt: preview.createdAt, scenes: preview.sceneVersions.length, current } : null };
    }),
    scenes: scenes.map((s) => sceneCard(studio, project, s)),
    shared: listShared(studio, project.id).map((s) => ({
      ...s,
      code: readShared(studio, project.id, s.name) ?? null,
      /** For a character: the poses and expressions scenes can choose from. */
      character: s.kind === "character" ? characterInfo(readShared(studio, project.id, s.name)) : null,
      versions: sharedVersions(studio, s.id).map((v) => ({ version: v.version, notes: v.notes, createdAt: v.createdAt, previewUrl: fileUrl(studio, project, v.previewPath) })),
    })),
    sharedRequests: listSharedRequests(studio, project.id, "open"),
    assets: listAssets(studio, project.id).map((a) => {
      const thumb = a.kind === "model" ? modelThumbnail(studio, project, a) : null;
      return {
        ...a,
        url: fileUrl(studio, project, a.path),
        /** A picture of a 3D model, once it has been drawn. */
        previewUrl: thumb ? fileUrl(studio, project, projectPaths(studio, project).rel(thumb)) : null,
        model: (a.meta.model as ModelInfo | undefined) ?? null,
        reference: refs.get(a.id) ?? null,
      };
    }),
    runs: listRuns(studio, project.id, { limit: 60 }),
    jobs: studio.db.all("SELECT id, kind, target_id AS targetId, status, progress, error, queued_at AS queuedAt FROM jobs WHERE project_id = ? ORDER BY queued_at DESC, id DESC LIMIT 30", [project.id]),
    /** `changed` counts the scenes that are different now from the ones in the video. */
    renders: renders.map((r) => ({ ...r, url: fileUrl(studio, project, r.path), srtUrl: fileUrl(studio, project, r.srtPath), changed: scenesChangedSince(studio, r) })),
    /** The shapes the video can be exported in, each with the frame it would get. */
    exportFormats: (Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((format) => ({
      format,
      ...EXPORT_FORMATS[format],
      ...exportSize(project, format),
      /** True for the shape the scenes were built in, which needs no extra rendering. */
      asBuilt: EXPORT_FORMATS[format].aspect === project.aspect,
    })),
    exports: listExports(studio, project.id).map((e) => ({
      ...e,
      folderPath: projectPaths(studio, project).abs(e.folder),
      url: fileUrl(studio, project, e.files.video),
      subtitlesUrl: fileUrl(studio, project, e.files.subtitles),
      thumbnailUrl: fileUrl(studio, project, e.files.thumbnail),
      descriptionUrl: fileUrl(studio, project, e.files.description),
    })),
  };
}
