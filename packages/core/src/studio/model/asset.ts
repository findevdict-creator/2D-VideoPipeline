export const ASSET_KINDS = ["image", "video", "audio_sfx", "audio_music", "model", "font", "other"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const REFERENCE_ROLES = ["style", "layout", "motion"] as const;

const BY_EXTENSION: Record<string, { kind: AssetKind; mime: string }> = {
  ".png": { kind: "image", mime: "image/png" },
  ".jpg": { kind: "image", mime: "image/jpeg" },
  ".jpeg": { kind: "image", mime: "image/jpeg" },
  ".webp": { kind: "image", mime: "image/webp" },
  ".gif": { kind: "image", mime: "image/gif" },
  ".svg": { kind: "image", mime: "image/svg+xml" },
  ".mp4": { kind: "video", mime: "video/mp4" },
  ".mov": { kind: "video", mime: "video/quicktime" },
  ".webm": { kind: "video", mime: "video/webm" },
  ".mkv": { kind: "video", mime: "video/x-matroska" },
  ".wav": { kind: "audio_sfx", mime: "audio/wav" },
  ".mp3": { kind: "audio_sfx", mime: "audio/mpeg" },
  ".m4a": { kind: "audio_sfx", mime: "audio/mp4" },
  ".ogg": { kind: "audio_sfx", mime: "audio/ogg" },
  ".glb": { kind: "model", mime: "model/gltf-binary" },
  ".gltf": { kind: "model", mime: "model/gltf+json" },
  ".ttf": { kind: "font", mime: "font/ttf" },
  ".otf": { kind: "font", mime: "font/otf" },
  ".woff2": { kind: "font", mime: "font/woff2" },
};

export function guessAsset(fileName: string): { kind: AssetKind; mime: string } {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  return BY_EXTENSION[ext] ?? { kind: "other", mime: "application/octet-stream" };
}
