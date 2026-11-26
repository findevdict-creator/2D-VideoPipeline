import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createTikTokStyleCaptions, type Caption } from "@remotion/captions";
import type { CaptionPage, SceneData, VideoData } from "@pipeline/lib/types";
import { loadConfig } from "../config.js";
import type { StageContext } from "../context.js";
import type { Voiceover } from "../schemas.js";
import { files, readJson, type Brief, type Script, type Storyboard } from "../stages/files.js";
import { loadPronunciations, type Pronunciations, type TimedWord } from "../voice/text.js";

import { LIB_INDEX, LIB_TSCONFIG, REPO_ROOT } from "../paths.js";

export { REPO_ROOT };

/** Where animation and render files live inside a production folder. */
export const renderPaths = (ctx: StageContext) => {
  const p = ctx.production;
  return {
    dir: p.path("render"),
    publicDir: p.path("render", "public"),
    entry: p.path("render", "entry.tsx"),
    scenesIndex: p.path("render", "scenes.ts"),
    data: p.path("render", "video-data.json"),
    tsconfig: p.path("render", "tsconfig.json"),
    stills: p.path("render", "stills"),
    preview: p.path("render", "preview.mp4"),
    status: p.path("render", "animation-status.json"),
    scenesDir: p.path("scenes"),
    scene: (id: string) => p.path("scenes", `${id}.tsx`),
    review: (id: string) => p.path("scenes", `${id}.review.json`),
    finalDir: p.path(ctx.config.render.outputDir),
  };
};

export function dimensions(aspect: Brief["aspectRatio"], shortSide: number) {
  const even = (n: number) => Math.round(n / 2) * 2;
  if (aspect === "9:16") return { width: shortSide, height: even((shortSide * 16) / 9) };
  if (aspect === "1:1") return { width: shortSide, height: shortSide };
  return { width: even((shortSide * 16) / 9), height: shortSide };
}

/**
 * Join respelled words back into what the script says, for captions:
 * the narrator says "G P S", the caption shows "GPS".
 */
export function unRespell(words: TimedWord[], pronunciations: Pronunciations): TimedWord[] {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const entries = Object.entries(pronunciations)
    .map(([written, spoken]) => ({ written, spoken: spoken.split(/\s+/).map(squash).filter(Boolean) }))
    .filter((e) => e.spoken.length > 0)
    .sort((a, b) => b.spoken.length - a.spoken.length);
  const out: TimedWord[] = [];
  for (let i = 0; i < words.length; ) {
    const match = entries.find((e) => e.spoken.every((tok, k) => squash(words[i + k]?.text ?? "") === tok));
    if (match) {
      const last = words[i + match.spoken.length - 1]!;
      out.push({ text: match.written, startSec: words[i]!.startSec, endSec: last.endSec });
      i += match.spoken.length;
    } else {
      out.push(words[i]!);
      i += 1;
    }
  }
  return out;
}

/** Pick up render settings you changed in pipeline.config.json while the run was waiting for you. */
export function reloadRenderSettings(ctx: StageContext) {
  const fresh = loadConfig({ rootDir: ctx.config.rootDir, runner: ctx.config.runner });
  ctx.config.render = fresh.render;
  ctx.config.animator = fresh.animator;
}

/** Build the data the Remotion video is drawn from, out of the approved files. */
export async function buildVideoData(ctx: StageContext): Promise<VideoData> {
  const f = files(ctx);
  const rc = ctx.config.render;
  const brief = await readJson<Brief>(f.brief);
  const script = await readJson<Script>(f.script);
  const board = await readJson<Storyboard>(f.storyboard);
  const voiceover = await readJson<Voiceover>(ctx.production.path("voiceover.json"));
  const pronunciations = await loadPronunciations(ctx.config);
  const fps = rc.fps;
  const { width, height } = dimensions(brief.aspectRatio, rc.resolution);
  const toFrame = (sec: number) => Math.round(sec * fps);

  let start = 0;
  const allCaptions: Caption[] = [];
  const scenes: SceneData[] = voiceover.scenes.map((vo) => {
    const sb = board.scenes.find((s) => s.id === vo.id);
    const sc = script.scenes.find((s) => s.id === vo.id);
    if (!sb || !sc) throw new Error(`Scene ${vo.id} is in voiceover.json but missing from the storyboard or script`);
    const durationInFrames = Math.max(1, toFrame(vo.durationSec));
    const startMs = (start / fps) * 1000;
    for (const w of unRespell(vo.words, pronunciations)) {
      allCaptions.push({
        text: ` ${w.text}`,
        startMs: startMs + w.startSec * 1000,
        endMs: startMs + w.endSec * 1000,
        timestampMs: startMs + ((w.startSec + w.endSec) / 2) * 1000,
        confidence: null,
      });
    }
    const scene: SceneData = {
      id: vo.id,
      title: sc.title,
      narration: sc.narration,
      layout: sb.layout,
      visualDescription: sb.visualDescription,
      elements: sb.elements,
      onScreenText: sb.onScreenText,
      transitionIn: sb.transitionIn,
      camera: sb.camera,
      startFrame: start,
      durationInFrames,
      speechStartFrame: toFrame(vo.speechStartSec),
      speechEndFrame: toFrame(vo.speechEndSec),
      audio: `voice/${path.basename(vo.audioFile)}`,
      cues: vo.cues.map((c, i) => ({
        elementId: c.elementId,
        cue: c.cue,
        action: sb.animations[i]?.elementId === c.elementId ? sb.animations[i]!.action : "",
        startFrame: toFrame(c.startSec),
        endFrame: toFrame(c.endSec),
        match: c.match,
      })),
      words: vo.words.map((w) => ({ text: w.text, startFrame: toFrame(w.startSec), endFrame: toFrame(w.endSec) })),
    };
    start += durationInFrames;
    return scene;
  });

  const { pages } = createTikTokStyleCaptions({
    captions: allCaptions,
    combineTokensWithinMilliseconds: rc.captions.combineWithinMs,
  });
  const captionPages: CaptionPage[] = pages.map((page) => ({
    startFrame: Math.round((page.startMs / 1000) * fps),
    endFrame: Math.round(((page.startMs + page.durationMs) / 1000) * fps),
    tokens: page.tokens.map((t) => ({
      text: t.text,
      startFrame: Math.round((t.fromMs / 1000) * fps),
      endFrame: Math.round((t.toMs / 1000) * fps),
    })),
  }));

  const captionsOn = rc.captions.enabled;
  return {
    title: brief.title,
    fps,
    width,
    height,
    style: board.styleGuide,
    transitionFrames: Math.round(rc.transitionSec * fps),
    captionSafeArea: captionsOn && rc.captions.position === "bottom" ? (rc.captions.fontSize * 2.6 + height * 0.05) / height : 0,
    scenes,
    captions: {
      enabled: captionsOn,
      fontSize: rc.captions.fontSize,
      position: rc.captions.position,
      highlight: rc.captions.highlight,
      pages: captionPages,
    },
    music: { src: rc.music.file ? `music${path.extname(rc.music.file)}` : null, volume: rc.music.volume },
  };
}

/**
 * Write everything Remotion needs to render this production: the video data,
 * an entry file that registers the scenes, a tsconfig for checking scene code,
 * and a public folder with the narration (and music).
 */
export async function writeProject(ctx: StageContext): Promise<VideoData> {
  const r = renderPaths(ctx);
  const data = await buildVideoData(ctx);
  await fs.mkdir(path.join(r.publicDir, "voice"), { recursive: true });
  await fs.mkdir(r.scenesDir, { recursive: true });

  for (const scene of data.scenes) {
    if (scene.audio) {
      await fs.copyFile(ctx.production.path(scene.audio), path.join(r.publicDir, scene.audio));
    }
  }
  if (data.music.src) {
    const source = path.resolve(ctx.config.rootDir, ctx.config.render.music.file);
    if (!existsSync(source)) throw new Error(`Music file not found: ${source} (render.music.file in pipeline.config.json)`);
    await fs.copyFile(source, path.join(r.publicDir, data.music.src));
  }

  await fs.writeFile(r.data, JSON.stringify(data, null, 2) + "\n");

  const present = data.scenes.filter((s) => existsSync(r.scene(s.id)));
  const imports = present.map((s) => `import ${s.id} from "../scenes/${s.id}";`).join("\n");
  await fs.writeFile(
    r.scenesIndex,
    `// Generated by the pipeline. Do not edit.\n${imports}\n\nexport const scenes = {\n${data.scenes
      .map((s) => `  ${s.id}: ${present.includes(s) ? s.id : "undefined"},`)
      .join("\n")}\n};\n`,
  );
  await fs.writeFile(
    r.entry,
    `// Generated by the pipeline. Do not edit.
import { registerRoot } from "remotion";
import { makeRoot } from "@pipeline/lib";
import data from "./video-data.json";
import { scenes } from "./scenes";

registerRoot(makeRoot(data as never, scenes));
`,
  );
  const lib = LIB_INDEX;
  await fs.writeFile(
    r.tsconfig,
    JSON.stringify(
      {
        extends: LIB_TSCONFIG,
        compilerOptions: {
          // Productions can live outside the repo, so point module lookups at the repo's packages.
          paths: {
            "@pipeline/lib": [lib],
            "*": [path.join(REPO_ROOT, "node_modules", "@types", "*"), path.join(REPO_ROOT, "node_modules", "*")],
          },
          typeRoots: [path.join(REPO_ROOT, "node_modules", "@types")],
        },
        include: [path.join(r.scenesDir, "*.tsx"), r.entry],
      },
      null,
      2,
    ) + "\n",
  );
  return data;
}
