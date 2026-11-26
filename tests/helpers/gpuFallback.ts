// Run by studioGpu.test.ts in a process of its own. Renders one clip as if the graphics
// card's encoder had passed its check, on a machine where it cannot run, and prints what happened.
import assert from "node:assert/strict";
import fs from "node:fs";
import { probe } from "../../packages/core/src/studio/media/ffmpeg.js";
import { encoderFor, forgetEncoder } from "../../packages/core/src/studio/renderers/gpu.js";
import { renderSceneClip } from "../../packages/core/src/studio/scenes/render.js";
import { addChapter } from "../../packages/core/src/studio/store/chapters.js";
import { createProject, projectPaths } from "../../packages/core/src/studio/store/projects.js";
import { addScene, saveSpec, versionPaths } from "../../packages/core/src/studio/store/scenes.js";
import { BROWSER, SAMPLE_SPEC, sceneCode, tempStudio } from "./studio.js";

async function main() {
  const studio = await tempStudio({ render: { browserExecutable: BROWSER } });
  const project = createProject(studio, { description: "How GPS finds you", targetDurationSec: 60 });
  const chapter = addChapter(studio, project.id, { title: "Only chapter" });
  const scene = addScene(studio, chapter.id, { title: "Scene 1", type: "remotion-2d", narration: SAMPLE_SPEC.narration });
  const saved = saveSpec(studio, scene.id, SAMPLE_SPEC, "test");
  assert.ok(saved.ok);
  fs.writeFileSync(versionPaths(studio, project, saved.version).source!, sceneCode("Scene 1"));

  forgetEncoder({ encoder: "h264_nvenc" });
  const lines: string[] = [];
  const { clip } = await renderSceneClip(studio, scene.id, "preview", () => {}, (m) => lines.push(m));
  const info = await probe(projectPaths(studio, project).abs(clip.path));
  const next = await encoderFor(studio);
  // Long enough for the stray rejection to arrive, so a process that did not absorb it would die here.
  await new Promise((r) => setTimeout(r, 1500));
  studio.close();
  console.log(JSON.stringify({ lines, codec: info.codec, durationSec: info.durationSec, next }));
}

void main();
