import type { SceneSpec } from "../model/scene.js";
import type { Studio } from "../studio.js";
import { findAsset } from "../store/assets.js";

/** The longest file that may be used as a sound effect. */
export const MAX_SFX_SEC = 15;

/**
 * Checks that need the database: every asset a spec names must exist in the project
 * and be the right kind of file. Returned as plain sentences an agent can act on.
 */
export function checkSpecAssets(studio: Studio, projectId: string, spec: SceneSpec): string[] {
  const problems: string[] = [];
  const need = (assetId: string, kinds: string[], where: string) => {
    const asset = findAsset(studio, projectId, assetId);
    if (!asset) problems.push(`${where}: there is no asset with the id "${assetId}" in this project. Use asset_list to see what exists.`);
    else if (!kinds.includes(asset.kind)) problems.push(`${where}: asset "${assetId}" is ${article(asset.kind)}, but this needs ${kinds.map(article).join(" or ")}`);
    return asset;
  };

  spec.references.forEach((r, i) => need(r.assetId, ["image", "video"], `references.${i}`));
  spec.sfx.forEach((s, i) => {
    const asset = s.assetId ? need(s.assetId, ["audio_sfx", "audio_music"], `sfx.${i}`) : undefined;
    if (asset && (asset.durationSec ?? 0) > MAX_SFX_SEC) problems.push(`sfx.${i}: "${asset.label}" is ${Math.round(asset.durationSec!)}s long. A sound effect is at most ${MAX_SFX_SEC}s; a longer file is music`);
  });
  spec.assets.forEach((assetId, i) => {
    const asset = need(assetId, ["model", "image"], `assets.${i}`);
    if (asset?.kind === "model" && spec.type !== "r3f") problems.push(`assets.${i}: "${asset.label}" is a 3D model, which only a scene of type r3f can show`);
    if (spec.type === "manim") problems.push(`assets.${i}: a Manim scene draws everything itself and cannot load project files. Remove "assets", or use another scene type for this file`);
  });

  if (spec.type === "illustration") {
    spec.illustration.shots.forEach((s, i) => need(s.assetId, ["image"], `illustration.shots.${i}`));
  }
  if (spec.type === "footage") {
    const asset = need(spec.footage.assetId, ["video"], "footage");
    const length = asset?.durationSec;
    if (asset && length != null) {
      if (spec.footage.inSec >= length) problems.push(`footage: inSec ${spec.footage.inSec} is past the end of the clip, which is ${length.toFixed(1)}s long`);
      if (spec.footage.outSec !== undefined && spec.footage.outSec > length + 0.05) {
        problems.push(`footage: outSec ${spec.footage.outSec} is past the end of the clip, which is ${length.toFixed(1)}s long`);
      }
    }
  }
  return problems;
}

const article = (kind: string) =>
  ({ image: "an image", video: "a video", audio_sfx: "a sound effect", audio_music: "a music file", model: "a 3D model", font: "a font", other: "another kind of file" })[kind] ?? kind;
