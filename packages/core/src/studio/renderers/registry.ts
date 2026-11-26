import type { SceneType } from "../model/scene.js";
import type { Studio } from "../studio.js";
import { ManimRenderer } from "./manim.js";
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
registerRenderer(new ManimRenderer());

/** Every scene type the studio has a renderer for. */
export const knownSceneTypes = (): SceneType[] => [...renderers.keys()];

/** Scene types that can be built on this machine: the known ones, without those that need something not installed. */
export const availableSceneTypes = (studio: Studio): SceneType[] => knownSceneTypes().filter((t) => !renderers.get(t)!.unavailable?.(studio));

/** Known scene types this machine cannot build yet, each with what to do about it. */
export const unavailableSceneTypes = (studio: Studio): { type: SceneType; why: string }[] =>
  knownSceneTypes().flatMap((type) => {
    const why = renderers.get(type)!.unavailable?.(studio);
    return why ? [{ type, why }] : [];
  });

export function rendererFor(type: SceneType): Renderer {
  const renderer = renderers.get(type);
  if (!renderer) {
    throw new Error(`Scenes of type "${type}" cannot be built yet. Available types: ${knownSceneTypes().join(", ")}.`);
  }
  return renderer;
}
