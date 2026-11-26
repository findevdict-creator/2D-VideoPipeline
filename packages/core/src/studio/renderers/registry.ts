import type { SceneType } from "../model/scene.js";
import { RemotionCodeRenderer, RemotionTemplateRenderer } from "./remotion.js";
import type { Renderer } from "./types.js";

const renderers = new Map<SceneType, Renderer>();

export function registerRenderer(renderer: Renderer) {
  renderers.set(renderer.type, renderer);
}

registerRenderer(new RemotionCodeRenderer("remotion-2d"));
registerRenderer(new RemotionCodeRenderer("r3f"));
registerRenderer(new RemotionTemplateRenderer("illustration"));
registerRenderer(new RemotionTemplateRenderer("footage"));

/** Scene types that can be built today. The others are planned for later phases. */
export const availableSceneTypes = (): SceneType[] => [...renderers.keys()];

export function rendererFor(type: SceneType): Renderer {
  const renderer = renderers.get(type);
  if (!renderer) {
    throw new Error(`Scenes of type "${type}" cannot be built yet. Available types: ${availableSceneTypes().join(", ")}.`);
  }
  return renderer;
}
