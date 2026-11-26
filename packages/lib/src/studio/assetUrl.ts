import { useVideoData } from "../context";

/** Turns an asset path from the scene data into a URL the renderer can load. */
export function useAssetUrl(): (src: string) => string {
  const { assetBase } = useVideoData();
  return (src) => (/^(https?:|data:|blob:)/.test(src) || !assetBase ? src : `${assetBase.replace(/\/$/, "")}/${src.replace(/^\//, "")}`);
}
