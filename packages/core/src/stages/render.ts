import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { serializeSrt, type Caption } from "@remotion/captions";
import type { VideoData } from "@pipeline/lib/types";
import type { StageContext } from "../context.js";
import { slugify } from "../production.js";
import { reloadRenderSettings, renderPaths, writeProject } from "../render/project.js";
import { bundleProduction, renderVideo } from "../render/remotion.js";
import { animate, sceneProblems } from "./animation.js";
import { files, readJson, type Brief } from "./files.js";
import type { Stage } from "./types.js";

const EXTENSION = { h264: "mp4", h265: "mp4", vp8: "webm", vp9: "webm", prores: "mov" } as const;

/** final/<title>.mp4 and final/<title>.srt */
function finalPaths(ctx: StageContext) {
  const dir = renderPaths(ctx).finalDir;
  const brief = existsSync(files(ctx).brief) ? readBriefTitle(files(ctx).brief) : ctx.production.id;
  const name = slugify(brief, 8);
  return {
    video: path.join(dir, `${name}.${EXTENSION[ctx.config.render.codec]}`),
    srt: path.join(dir, `${name}.srt`),
  };
}

function readBriefTitle(file: string): string {
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as Brief).title;
  } catch {
    return "video";
  }
}

/** Subtitles for uploading alongside the video, from the same caption lines that are burned in. */
export function captionsToSrt(data: VideoData): string {
  const ms = (frame: number) => (frame / data.fps) * 1000;
  const lines: Caption[][] = data.captions.pages.map((page) =>
    page.tokens.map((t) => ({
      text: t.text,
      startMs: ms(t.startFrame),
      endMs: ms(t.endFrame),
      timestampMs: null,
      confidence: null,
    })),
  );
  return serializeSrt({ lines });
}

async function renderFinal(ctx: StageContext) {
  const data = await writeProject(ctx);
  const out = finalPaths(ctx);
  const rc = ctx.config.render;
  ctx.log(`▸ Rendering the final video at ${data.width}x${data.height}...`);
  const serveUrl = await bundleProduction(ctx);
  await renderVideo(ctx, serveUrl, { output: out.video, scale: 1, crf: rc.crf, label: "Final" });
  await fs.writeFile(out.srt, captionsToSrt(data));
  ctx.log(`✓ Final video: ${out.video}`);
}

export const renderStage: Stage = {
  id: "render",
  title: "Final render",

  outputs: (ctx) => [finalPaths(ctx).video, finalPaths(ctx).srt],

  // Revision notes go to the Animator, so the scene files are what changes.
  archiveFiles: (ctx) => [renderPaths(ctx).status],

  async produce(ctx, notes) {
    if (notes) await animate(ctx, notes);
    await renderFinal(ctx);
  },

  async afterEdit(ctx) {
    reloadRenderSettings(ctx);
    await renderFinal(ctx);
  },

  async summarize(ctx) {
    const out = finalPaths(ctx);
    const data = await readJson<VideoData>(renderPaths(ctx).data);
    const rc = ctx.config.render;
    const size = existsSync(out.video) ? (await fs.stat(out.video)).size / 1e6 : 0;
    const seconds = data.scenes.reduce((n, s) => n + s.durationInFrames, 0) / data.fps;
    return [
      `Video: ${out.video}`,
      `  ${data.width}x${data.height}, ${data.fps} fps, ${seconds.toFixed(1)}s, ${rc.codec} (crf ${rc.crf}), ${size.toFixed(1)} MB`,
      `  Captions ${data.captions.enabled ? "burned in" : "off"}, music ${data.music.src ? "on" : "off"}`,
      `Subtitles for upload: ${out.srt}`,
      "",
      "To change scenes, choose [r] and describe it (name scenes as \"s03\" or \"scene 3\"); the Animator",
      "updates them and the video is rendered again. To change render settings (resolution, codec, quality,",
      "captions, music), edit the render section of pipeline.config.json and choose [e].",
    ].join("\n");
  },

  async validate(ctx) {
    return sceneProblems(ctx);
  },
};
