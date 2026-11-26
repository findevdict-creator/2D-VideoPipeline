import type { SceneSpec } from "../model/scene.js";
import type { Studio } from "../studio.js";
import { findAsset } from "../store/assets.js";

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
  spec.sfx.forEach((s, i) => need(s.assetId, ["audio_sfx", "audio_music"], `sfx.${i}`));

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
