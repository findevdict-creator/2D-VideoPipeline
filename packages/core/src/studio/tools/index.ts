import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { LIB_EXAMPLE, LIB_README } from "../../paths.js";
import { checkSceneSource } from "../../render/sceneCheck.js";
import { loadPronunciations } from "../../voice/text.js";
import { assetPreview } from "../assets/preview.js";
import { ASSET_KINDS } from "../model/asset.js";
import { ThemeSchema } from "../model/project.js";
import { ScenePlanSchema, SceneSpecSchema, SCENE_TYPES, type SceneType } from "../model/scene.js";
import { availableSceneTypes } from "../renderers/registry.js";
import { renderSharedPreview, typecheckScene } from "../renderers/remotion.js";
import { checkScene, renderSceneStills } from "../scenes/render.js";
import { checkSpecAssets } from "../scenes/validate.js";
import type { ModelInfo } from "../assets/gltf.js";
import { listAssets, listProjectReferences } from "../store/assets.js";
import { getChapter, listChapters, proposeChapters } from "../store/chapters.js";
import { latestDocument, listDocuments, readDocument, saveDocument } from "../store/documents.js";
import { getProject, projectPaths, updateProject } from "../store/projects.js";
import type { RunKind } from "../store/runs.js";
import {
  currentVersion,
  getScene,
  listReviews,
  listScenes,
  proposeScenes,
  saveSpec,
  sceneLabel,
  sceneNarration,
  updateVersion,
  versionPaths,
  type Scene,
} from "../store/scenes.js";
import { findShared, listShared, planShared, readShared, requestShared, saveShared, setSharedPreview, SHARED_NAME } from "../store/shared.js";
import { cueFrames, ensureVoice } from "../voice.js";
import { defineTool, ToolRefusal, type ToolContext, type ToolDef } from "./types.js";

export { ToolRefusal, type ToolContext, type ToolDef, type ToolOutput } from "./types.js";

/** What each scene type is good for. Shown to the agents that choose types. */
export const SCENE_TYPE_GUIDE: Record<SceneType, string> = {
  "remotion-2d": "Animated 2D diagram written as code: shapes, icons, labels, charts and motion timed to the narration. The default choice.",
  r3f: "3D scene written as code with react-three-fiber. For depth, rotation and real objects seen from a moving camera.",
  manim: "Mathematical animation written with Manim: equations, graphs and geometry that transform step by step.",
  illustration: "One or more of the project's images with a slow camera move, labels and arrows on top. Needs an image asset.",
  footage: "A video clip from the project's assets, fitted to the narration, with labels on top. Needs a video asset.",
};

/** What a scene builder needs to know to use a 3D model: its parts by name, its animations, and its size. */
function modelSummary(model: ModelInfo) {
  return {
    howToUse: 'In an r3f scene: list the asset id under "assets" in the spec, then <Model asset="<id>" fit={4} />. Move, hide or recolour parts by name with its "parts" prop; show an animation at a time in seconds with its "animations" prop.',
    sizeInItsOwnUnits: model.size,
    parts: model.parts.map((p) => ({ name: p.name, inside: p.parent, position: p.position })),
    animations: model.animations.map((a) => ({ name: a.name, durationSec: a.durationSec, moves: a.parts })),
    triangles: model.triangles,
    warnings: model.warnings,
  };
}

function scopeOf(ctx: ToolContext, writers: RunKind[]) {
  if (!ctx.run) throw new ToolRefusal("This tool changes the project, and this session is not part of a run. Only reading is allowed here.");
  if (!writers.includes(ctx.run.targetKind)) {
    throw new ToolRefusal(`This tool belongs to ${writers.join(" and ")} runs. You are in a ${ctx.run.targetKind} run, so it is not yours to call.`);
  }
  return ctx.run;
}

/** The scene a call is about. Scene runs may only touch their own scene. */
function sceneOf(ctx: ToolContext, sceneId: string | undefined, write: boolean): Scene {
  const own = ctx.run?.targetKind === "scene" ? ctx.run.targetId : undefined;
  const id = sceneId ?? own;
  if (!id) throw new ToolRefusal("Say which scene: pass sceneId.");
  if (write && id !== own) {
    throw new ToolRefusal(`You are working on scene ${own ?? "(none)"} and may not change scene ${id}. Another run owns that scene.`);
  }
  const scene = getScene(ctx.studio, id);
  if (scene.projectId !== ctx.projectId) throw new ToolRefusal(`Scene ${id} is not part of this project.`);
  return scene;
}

const sceneId = z.string().optional().describe("Leave out in a scene run: it means your own scene");

const tools: ToolDef<any>[] = [
  // ---------- Reading ----------
  defineTool({
    name: "project_get",
    description: "The video being made: its description, length, look, chapters, documents and the references the person gave. Start here.",
    input: z.object({}),
    handler: (ctx) => {
      const { studio } = ctx;
      const project = getProject(studio, ctx.projectId);
      const assets = new Map(listAssets(studio, project.id).map((a) => [a.id, a]));
      const types = availableSceneTypes().filter((t) => project.settings.sceneTypes.includes(t));
      return {
        title: project.title,
        description: project.description,
        targetDurationSec: project.targetDurationSec,
        frame: { aspect: project.aspect, width: project.width, height: project.height, fps: project.fps },
        stage: project.stage,
        tone: project.settings.tone,
        audience: project.settings.audience,
        theme: project.settings.theme,
        sceneTypes: Object.fromEntries(types.map((t) => [t, SCENE_TYPE_GUIDE[t]])),
        references: listProjectReferences(studio, project.id).map((r) => ({
          ...r,
          label: assets.get(r.assetId)?.label,
          kind: assets.get(r.assetId)?.kind,
          howToUse: "A reference shows a direction to take, not a picture to copy. Look at it with asset_view.",
        })),
        chapters: listChapters(studio, project.id).map((c) => ({
          id: c.id,
          position: c.position,
          title: c.title,
          goal: c.goal,
          targetDurationSec: c.targetDurationSec,
          scenes: listScenes(studio, project.id, c.id).length,
        })),
        documents: listDocuments(studio, project.id)
          .filter((d) => d.status !== "superseded")
          .map((d) => ({ kind: d.kind, version: d.version, status: d.status, chapterId: d.chapterId })),
        sharedAssets: listShared(studio, project.id).map((s) => ({ name: s.name, brief: s.brief, status: s.status, version: s.currentVersion })),
      };
    },
  }),
  defineTool({
    name: "document_read",
    description: "Read the newest version of the outline, the bible or the research notes.",
    input: z.object({ kind: z.enum(["outline", "bible", "research"]) }),
    handler: (ctx, { kind }) => {
      const doc = latestDocument(ctx.studio, ctx.projectId, kind);
      if (!doc) return { exists: false, note: `There is no ${kind} yet.` };
      const notes = listReviews(ctx.studio, "document", doc.id).filter((r) => r.decision === "revise").map((r) => r.notes);
      return { exists: true, version: doc.version, status: doc.status, markdown: readDocument(ctx.studio, doc), reviewNotes: notes };
    },
  }),
  defineTool({
    name: "scene_list",
    description: "Every scene in order, with its narration and status. Use it to see what comes before and after a scene.",
    input: z.object({ chapterId: z.string().optional() }),
    handler: (ctx, { chapterId }) => ({
      scenes: listScenes(ctx.studio, ctx.projectId, chapterId).map((s) => ({
        id: s.id,
        label: sceneLabel(ctx.studio, s),
        title: s.title,
        type: s.type,
        status: s.status,
        narration: sceneNarration(ctx.studio, s),
      })),
    }),
  }),
  defineTool({
    name: "scene_get",
    description:
      "Everything about one scene: its plan, its spec, the person's review notes, where its code file is, and the exact timing of the recorded narration (each word, and each cue once the spec has cues).",
    input: z.object({ sceneId }),
    handler: async (ctx, input) => {
      const { studio } = ctx;
      const scene = sceneOf(ctx, input.sceneId, false);
      const project = getProject(studio, scene.projectId);
      const version = currentVersion(studio, scene);
      const track = (await ensureVoice(studio, [scene.id], ctx.log)).get(scene.id)!;
      const fps = project.fps;
      const all = listScenes(studio, project.id);
      const at = all.findIndex((s) => s.id === scene.id);
      const neighbour = (s?: Scene) => (s ? { title: s.title, narration: sceneNarration(studio, s) } : null);
      const paths = version ? versionPaths(studio, project, version) : undefined;
      const cues = version ? cueFrames(version.spec.cues, track, fps, await loadPronunciations(studio.config)) : [];
      return {
        id: scene.id,
        label: sceneLabel(studio, scene),
        status: scene.status,
        type: scene.type,
        plan: scene.plan,
        spec: version?.spec ?? null,
        version: version?.version ?? null,
        reviewNotes: listReviews(studio, "scene", scene.id).filter((r) => r.decision === "revise").map((r) => ({ onVersion: r.targetVersion, notes: r.notes })),
        checkProblems: version?.checkProblems ?? [],
        codeFile: paths?.source ?? null,
        codeExists: Boolean(paths?.source && fs.existsSync(paths.source)),
        libraryGuide: LIB_README,
        exampleScene: LIB_EXAMPLE,
        timing: {
          fps,
          durationSec: track.durationSec,
          durationFrames: Math.max(1, Math.round(track.durationSec * fps)),
          words: track.words.map((w) => ({ text: w.text, startSec: w.startSec })),
          cues: cues.map((c) => ({ id: c.id, phrase: c.phrase, startSec: Math.round(c.startSec * 100) / 100, startFrame: c.startFrame, match: c.match })),
        },
        previous: neighbour(all[at - 1]),
        next: neighbour(all[at + 1]),
        sharedAssets: listShared(studio, project.id)
          .filter((s) => s.currentVersion > 0)
          .map((s) => ({ name: s.name, version: s.currentVersion, brief: s.brief, importFrom: `@shared/${s.name}` })),
      };
    },
  }),
  defineTool({
    name: "asset_list",
    description: "The project's files: images, video clips, sounds and models, with their ids.",
    input: z.object({ kind: z.enum(ASSET_KINDS).optional() }),
    handler: (ctx, { kind }) => {
      const refs = new Map(listProjectReferences(ctx.studio, ctx.projectId).map((r) => [r.assetId, r]));
      return {
        assets: listAssets(ctx.studio, ctx.projectId, kind).map((a) => ({
          id: a.id,
          kind: a.kind,
          label: a.label,
          width: a.width,
          height: a.height,
          durationSec: a.durationSec,
          note: a.sourceNote,
          reference: refs.get(a.id) ? { role: refs.get(a.id)!.role, note: refs.get(a.id)!.note } : null,
          ...(a.meta.model ? { model: modelSummary(a.meta.model as ModelInfo) } : {}),
        })),
      };
    },
  }),
  defineTool({
    name: "asset_view",
    description: "Look at an image, at evenly spaced frames of a video clip, or at a 3D model from four sides and at the end of each of its animations. Use it on references and on any asset before you put it in a scene.",
    input: z.object({ assetId: z.string(), frames: z.number().int().min(1).max(12).default(4).describe("For video: how many frames to show") }),
    handler: async (ctx, { assetId, frames }) => {
      const asset = listAssets(ctx.studio, ctx.projectId).find((a) => a.id === assetId);
      if (!asset) throw new ToolRefusal(`There is no asset with the id "${assetId}" in this project. Use asset_list to see what exists.`);
      const previews = await assetPreview(ctx.studio, assetId, { frames });
      return {
        label: asset.label,
        kind: asset.kind,
        width: asset.width,
        height: asset.height,
        durationSec: asset.durationSec,
        ...(asset.meta.model ? { model: modelSummary(asset.meta.model as ModelInfo) } : {}),
        images: previews.map((p) => ({ file: p.file, caption: p.caption ?? (p.atSec !== undefined ? `${asset.label} at ${p.atSec}s` : asset.label) })),
      };
    },
  }),
  defineTool({
    name: "shared_list",
    description: "The shared components every scene can build on, so recurring things look the same everywhere.",
    input: z.object({}),
    handler: (ctx) => ({
      shared: listShared(ctx.studio, ctx.projectId).map((s) => ({
        name: s.name,
        brief: s.brief,
        status: s.status,
        version: s.currentVersion,
        built: s.currentVersion > 0,
        importFrom: `@shared/${s.name}`,
      })),
    }),
  }),
  defineTool({
    name: "shared_get",
    description: "The source of one shared component, to see its props before using it.",
    input: z.object({ name: z.string() }),
    handler: (ctx, { name }) => {
      const asset = findShared(ctx.studio, ctx.projectId, name);
      if (!asset) throw new ToolRefusal(`There is no shared asset called "${name}". Use shared_list to see what exists.`);
      return { name, brief: asset.brief, version: asset.currentVersion, importFrom: `@shared/${name}`, code: readShared(ctx.studio, ctx.projectId, name) ?? null };
    },
  }),

  // ---------- Planning ----------
  defineTool({
    name: "document_save",
    description: "Save a new version of a planning document as Markdown. The person reviews it before work continues.",
    writers: ["outline", "bible"],
    input: z.object({ kind: z.enum(["outline", "bible", "research"]), markdown: z.string().min(40) }),
    handler: (ctx, { kind, markdown }) => {
      const run = scopeOf(ctx, ["outline", "bible"]);
      const allowed = run.targetKind === "outline" ? ["outline", "research"] : ["bible"];
      if (!allowed.includes(kind)) throw new ToolRefusal(`A ${run.targetKind} run saves ${allowed.join(" or ")}, not the ${kind}.`);
      const doc = saveDocument(ctx.studio, ctx.projectId, kind, markdown, { createdBy: run.agent });
      return { saved: true, kind, version: doc.version };
    },
  }),
  defineTool({
    name: "chapters_propose",
    description: "Set the chapter plan: the video's parts in order. Replaces the earlier plan; chapters that already have scenes are kept when their title is unchanged.",
    writers: ["outline"],
    input: z.object({
      chapters: z
        .array(z.object({ title: z.string().min(2).max(120), goal: z.string().describe("What the viewer understands by the end of it"), targetDurationSec: z.number().int().min(5).max(3600) }))
        .min(1)
        .max(40),
    }),
    handler: (ctx, { chapters }) => {
      scopeOf(ctx, ["outline"]);
      const project = getProject(ctx.studio, ctx.projectId);
      const total = chapters.reduce((n, c) => n + c.targetDurationSec, 0);
      if (Math.abs(total - project.targetDurationSec) > project.targetDurationSec * 0.2) {
        throw new ToolRefusal(`The chapters add up to ${total}s but the video should be about ${project.targetDurationSec}s. Adjust the chapter lengths to within 20%.`);
      }
      const saved = proposeChapters(ctx.studio, ctx.projectId, chapters);
      return { chapters: saved.map((c) => ({ id: c.id, position: c.position, title: c.title })) };
    },
  }),
  defineTool({
    name: "theme_set",
    description: "Set the look every scene shares: colours, font and style words.",
    writers: ["bible"],
    input: z.object({ theme: ThemeSchema }),
    handler: (ctx, { theme }) => {
      scopeOf(ctx, ["bible"]);
      updateProject(ctx.studio, ctx.projectId, { settings: { theme } });
      return { saved: true };
    },
  }),
  defineTool({
    name: "shared_plan",
    description:
      "List the shared components to build before any scene starts: things that appear in more than one scene and must look the same each time, such as a recurring character or object.",
    writers: ["bible"],
    input: z.object({
      items: z
        .array(z.object({ name: z.string().regex(SHARED_NAME, "PascalCase letters and digits, such as CameraBody"), brief: z.string().min(10).describe("What it shows, its props, and how scenes use it") }))
        .max(20),
    }),
    handler: (ctx, { items }) => {
      scopeOf(ctx, ["bible"]);
      return { shared: planShared(ctx.studio, ctx.projectId, items).map((s) => ({ name: s.name, status: s.status })) };
    },
  }),
  defineTool({
    name: "shared_save",
    description:
      'Save a shared component: a .tsx file with named exports that scenes import from "@shared/<name>". It also exports a Demo component showing it in typical use. The code is checked before it is saved, and you get a picture of the Demo back; fix what the check reports or what looks wrong, and save again.',
    writers: ["foundation"],
    input: z.object({ name: z.string().regex(SHARED_NAME), code: z.string().min(20), brief: z.string().optional(), notes: z.string().optional().describe("What changed in this version") }),
    handler: async (ctx, input) => {
      const run = scopeOf(ctx, ["foundation"]);
      const { studio } = ctx;
      const p = projectPaths(studio, getProject(studio, ctx.projectId));
      const problems = checkSceneSource(input.code, { allowedPrefixes: ["@shared/"], defaultExport: false });
      if (!new RegExp(`export\\s+(?:const|function)\\s+${input.name}\\b`).test(input.code)) {
        problems.push(`The file must export a component named ${input.name} (export const ${input.name} = ... or export function ${input.name}).`);
      }
      if (!/export\s+(?:const|function)\s+Demo\b/.test(input.code)) {
        problems.push(`The file must also export a component named Demo that shows ${input.name} in typical use, with fixed props and nothing else on screen. It is what the person sees when approving.`);
      }
      if (!problems.length) {
        const probe = path.join(p.work, "shared-check", run.id, `${input.name}.tsx`);
        fs.mkdirSync(path.dirname(probe), { recursive: true });
        fs.writeFileSync(probe, input.code);
        problems.push(...(await typecheckScene(probe, path.dirname(probe), p.sharedComponents)));
        fs.rmSync(path.dirname(probe), { recursive: true, force: true });
      }
      if (problems.length) return { saved: false, problems };
      const result = saveShared(studio, ctx.projectId, { name: input.name, code: input.code, brief: input.brief, notes: input.notes, createdBy: run.agent });
      const saved = { saved: true, name: input.name, version: result.version.version, scenesNowStale: result.staleScenes.length };
      // The stand-in runner is for trying the flow without a browser, so it goes without pictures unless one is set.
      if (studio.config.runner === "mock" && !studio.config.render.browserExecutable) return saved;
      const preview = path.join(p.shared, "previews", `${input.name}-v${result.version.version}.png`);
      try {
        await renderSharedPreview(studio, getProject(studio, ctx.projectId), input.name, p.abs(result.version.path), preview);
      } catch (err) {
        return { ...saved, previewProblem: `The Demo could not be drawn: ${(err as Error).message.split("\n")[0]}. If that is a fault in the component, fix it and save again.` };
      }
      setSharedPreview(studio, result.version.id, p.rel(preview));
      studio.emit("shared.changed", { projectId: ctx.projectId, data: { name: input.name } });
      return { ...saved, images: [{ file: preview, caption: `${input.name}: its Demo, two seconds in. Check that it is drawn as the brief says.` }] };
    },
  }),
  defineTool({
    name: "scenes_propose",
    description: "Set the scene list of your chapter: each scene's title, type, exact narration and a sentence on what the viewer sees. Replaces the earlier list of this chapter.",
    writers: ["chapter"],
    input: z.object({ scenes: z.array(ScenePlanSchema).min(1).max(60) }),
    handler: (ctx, { scenes }) => {
      const run = scopeOf(ctx, ["chapter"]);
      const { studio } = ctx;
      const project = getProject(studio, ctx.projectId);
      const chapter = getChapter(studio, run.targetId!);
      const allowed = availableSceneTypes().filter((t) => project.settings.sceneTypes.includes(t));
      const problems: string[] = [];
      scenes.forEach((s, i) => {
        if (!allowed.includes(s.type)) problems.push(`scenes.${i}: type "${s.type}" is not available in this project. Choose from: ${allowed.join(", ")}.`);
      });
      const titles = scenes.map((s) => s.title.trim().toLowerCase());
      titles.forEach((t, i) => {
        if (titles.indexOf(t) !== i) problems.push(`scenes.${i}: the title "${scenes[i]!.title}" is used twice. Titles must differ.`);
      });
      const hasKind = (kind: string) => listAssets(studio, project.id).some((a) => a.kind === kind);
      if (scenes.some((s) => s.type === "illustration") && !hasKind("image")) problems.push("An illustration scene needs an image, and this project has none. Use another type.");
      if (scenes.some((s) => s.type === "footage") && !hasKind("video")) problems.push("A footage scene needs a video clip, and this project has none. Use another type.");
      if (problems.length) return { saved: false, problems };
      const saved = proposeScenes(studio, chapter.id, scenes);
      const words = scenes.reduce((n, s) => n + s.narration.split(/\s+/).filter(Boolean).length, 0);
      return {
        saved: true,
        scenes: saved.map((s) => ({ id: s.id, label: sceneLabel(studio, s), title: s.title, type: s.type })),
        estimatedSec: Math.round((words / 150) * 60),
        chapterTargetSec: chapter.targetDurationSec,
      };
    },
  }),

  // ---------- Building one scene ----------
  defineTool({
    name: "scene_save_spec",
    description:
      "Save your scene's spec: what the viewer sees, the things on screen, and the cues that tie motion to phrases of the narration. Returns the problems to fix, or the timing of every cue.",
    writers: ["scene"],
    input: z.object({ spec: SceneSpecSchema }),
    handler: async (ctx, { spec }) => {
      const run = scopeOf(ctx, ["scene"]);
      const { studio } = ctx;
      const scene = sceneOf(ctx, undefined, true);
      const approved = sceneNarration(studio, scene);
      const result = saveSpec(studio, scene.id, spec, run.agent, (s) => {
        const problems = checkSpecAssets(studio, ctx.projectId, s);
        if (s.type !== scene.type) problems.push(`type: this scene is planned as "${scene.type}". You may not change its type.`);
        if (run.task !== "revise" && s.narration.trim() !== approved.trim()) {
          problems.push("narration: the person approved this scene's narration. Use it word for word; do not rewrite it.");
        }
        for (const use of s.uses) {
          const shared = findShared(studio, ctx.projectId, use.name);
          if (!shared || !shared.currentVersion) problems.push(`uses: there is no shared component called "${use.name}". Use shared_list to see what exists.`);
        }
        return problems;
      });
      if (!result.ok) return { saved: false, problems: result.problems };
      const track = (await ensureVoice(studio, [scene.id], ctx.log)).get(scene.id)!;
      const fps = getProject(studio, ctx.projectId).fps;
      const cues = cueFrames(result.version.spec.cues, track, fps, await loadPronunciations(studio.config));
      const loose = cues.filter((c) => c.match !== "exact").map((c) => c.id);
      return {
        saved: true,
        version: result.version.version,
        codeFile: versionPaths(studio, getProject(studio, ctx.projectId), result.version).source,
        durationFrames: Math.max(1, Math.round(track.durationSec * fps)),
        cues: cues.map((c) => ({ id: c.id, startFrame: c.startFrame, startSec: Math.round(c.startSec * 100) / 100, match: c.match })),
        ...(loose.length ? { warning: `These cues could not be found word for word in the recording, so their timing is estimated: ${loose.join(", ")}. Use shorter phrases copied from the narration.` } : {}),
      };
    },
  }),
  defineTool({
    name: "scene_check",
    description: "Check your scene: its code is type-checked and scanned for things that break renders. Returns the problems, or none.",
    writers: ["scene"],
    input: z.object({}),
    handler: async (ctx) => {
      scopeOf(ctx, ["scene"]);
      const scene = sceneOf(ctx, undefined, true);
      if (!scene.currentVersionId) throw new ToolRefusal("Save a spec with scene_save_spec first.");
      const problems = await checkScene(ctx.studio, scene.id, ctx.log);
      return problems.length ? { ok: false, problems } : { ok: true };
    },
  }),
  defineTool({
    name: "scene_stills",
    description:
      "Render still frames of your scene and look at them. Without arguments you get a moment after each cue and the end of the scene. Look for overlap, text that is cut off or too small, things outside the frame, and motion that has not happened by its cue.",
    writers: ["scene"],
    input: z.object({
      frames: z.array(z.number().int().min(0)).max(8).optional(),
      cues: z.array(z.string()).max(8).optional().describe("Cue ids: a frame shortly after each"),
    }),
    handler: async (ctx, input) => {
      scopeOf(ctx, ["scene"]);
      const { studio } = ctx;
      const scene = sceneOf(ctx, undefined, true);
      if (!scene.currentVersionId) throw new ToolRefusal("Save a spec with scene_save_spec first.");
      const problems = await checkScene(studio, scene.id, ctx.log);
      if (problems.length) return { rendered: false, problems, note: "Fix these first; a scene that fails its check cannot be drawn." };
      const stills = await renderSceneStills(studio, scene.id, { frames: input.frames, cues: input.cues }, ctx.log);
      const p = projectPaths(studio, getProject(studio, ctx.projectId));
      const fps = getProject(studio, ctx.projectId).fps;
      return {
        rendered: true,
        images: stills.map((s) => ({ file: p.abs(s.file), caption: `frame ${s.frame} (${(s.frame / fps).toFixed(1)}s)` })),
      };
    },
  }),
  defineTool({
    name: "scene_submit",
    description:
      "Hand your scene over for rendering and the person's review. Call it once the check passes and the stills look right. The scene is checked again; if anything fails you get the problems back instead.",
    writers: ["scene"],
    input: z.object({ summary: z.string().min(10).max(600).describe("What you built or changed, in a sentence or two, for the person reviewing it") }),
    handler: async (ctx, { summary }) => {
      scopeOf(ctx, ["scene"]);
      const { studio } = ctx;
      const scene = sceneOf(ctx, undefined, true);
      const version = currentVersion(studio, scene);
      if (!version) throw new ToolRefusal("Save a spec with scene_save_spec first.");
      const problems = await checkScene(studio, scene.id, ctx.log);
      if (problems.length) return { submitted: false, problems };
      updateVersion(studio, version.id, { summary });
      studio.emit("scene.submitted", { projectId: ctx.projectId, targetId: scene.id });
      return { submitted: true, note: "The scene will now be rendered and shown to the person. You are done." };
    },
  }),
  defineTool({
    name: "shared_request",
    description:
      "Ask for a shared component that does not exist yet, when your scene needs something that other scenes will need too. The person decides. Carry on by drawing it inside your own scene for now.",
    writers: ["scene"],
    input: z.object({ name: z.string().regex(SHARED_NAME), why: z.string().min(10) }),
    handler: (ctx, { name, why }) => {
      scopeOf(ctx, ["scene"]);
      const scene = sceneOf(ctx, undefined, true);
      requestShared(ctx.studio, ctx.projectId, scene.id, name, why);
      return { recorded: true };
    },
  }),
];

export const TOOLS: readonly ToolDef[] = tools;
export const SCENE_TYPE_LIST = SCENE_TYPES;

/** Call a tool by name, the way the MCP server and the mock runner both do. Refusals come back as data. */
export async function callTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<{ ok: boolean; output: Record<string, unknown>; images: { file: string; caption: string }[] }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, output: { error: `There is no tool called "${name}".` }, images: [] };
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join(".") || "(input)"}: ${i.message}`);
    return { ok: false, output: { error: "The input is not valid.", problems: issues }, images: [] };
  }
  try {
    if (tool.writers) scopeOf(ctx, tool.writers);
    const { images, ...output } = await tool.handler(ctx, parsed.data);
    return { ok: true, output, images: images ?? [] };
  } catch (err) {
    if (err instanceof ToolRefusal) return { ok: false, output: { refused: err.message }, images: [] };
    return { ok: false, output: { error: (err as Error).message }, images: [] };
  }
}
