import { saveClip, type Clip } from "../../packages/core/src/studio/store/clips.js";
import { currentVersion, getScene, setSceneStatus } from "../../packages/core/src/studio/store/scenes.js";
import { Orchestrator } from "../../packages/core/src/studio/workflow.js";

/** An orchestrator that skips the browser: a "rendered" scene gets a clip row and goes up for review. */
export class NoRenderOrchestrator extends Orchestrator {
  rendered: string[] = [];
  /** How long a pretend render takes. Raise it when a test needs renders to overlap. */
  renderMs = 10;
  override async renderScene(sceneId: string): Promise<Clip> {
    const { studio } = this;
    const scene = getScene(studio, sceneId);
    const version = currentVersion(studio, scene)!;
    return this.lanes.run("renders", async () => {
      this.rendered.push(sceneId);
      await new Promise((r) => setTimeout(r, this.renderMs));
      const clip = saveClip(studio, { sceneVersionId: version.id, quality: "preview", cacheKey: `fake-${version.id}`, path: `scenes/${sceneId}/v${version.version}/clip-preview.mp4`, durationFrames: 90, width: 960, height: 540 });
      if (getScene(studio, sceneId).status !== "approved") setSceneStatus(studio, sceneId, "needs_review");
      return clip;
    });
  }
}
