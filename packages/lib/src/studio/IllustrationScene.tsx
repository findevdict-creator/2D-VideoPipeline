import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { useScene, useTheme } from "../context";
import type { FocusData, ShotData } from "../types";
import { useAssetUrl } from "./assetUrl";

const EASE = Easing.inOut(Easing.cubic);

/** Where to put an image so the focus point is centred, without showing past its edges when it covers the frame. */
export function placeImage(shot: Pick<ShotData, "width" | "height" | "fit">, focus: FocusData, frameW: number, frameH: number) {
  const base =
    shot.fit === "cover" ? Math.max(frameW / shot.width, frameH / shot.height) : Math.min(frameW / shot.width, frameH / shot.height);
  const w = shot.width * base * focus.zoom;
  const h = shot.height * base * focus.zoom;
  const centre = (size: number, frame: number, f: number) => {
    if (size <= frame) return (frame - size) / 2;
    return Math.min(0, Math.max(frame - size, frame / 2 - f * size));
  };
  return { left: centre(w, frameW, focus.x), top: centre(h, frameH, focus.y), width: w, height: h };
}

const Shot: React.FC<{ shot: ShotData; opacity: number }> = ({ shot, opacity }) => {
  const frame = useCurrentFrame();
  const t = useTheme();
  const url = useAssetUrl();
  const p = interpolate(frame, [shot.startFrame, Math.max(shot.startFrame + 1, shot.endFrame)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const to = shot.to ?? shot.from;
  const focus = {
    x: shot.from.x + (to.x - shot.from.x) * p,
    y: shot.from.y + (to.y - shot.from.y) * p,
    zoom: shot.from.zoom + (to.zoom - shot.from.zoom) * p,
  };
  const box = placeImage(shot, focus, t.width, t.height);
  return <Img src={url(shot.src)} style={{ position: "absolute", ...box, opacity, maxWidth: "none" }} />;
};

/** Still images with a moving camera: pans and zooms on each image, with a short crossfade between images. */
export const IllustrationScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scene = useScene();
  const t = useTheme();
  const data = scene.illustration;
  if (!data) return null;
  const fade = Math.max(1, Math.round(fps * 0.5));
  const index = Math.max(0, data.shots.findLastIndex((s) => frame >= s.startFrame));
  const current = data.shots[index];
  const previous = index > 0 ? data.shots[index - 1] : undefined;
  if (!current) return null;
  const fadeIn = previous
    ? interpolate(frame, [current.startFrame, current.startFrame + fade], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;
  return (
    <AbsoluteFill style={{ backgroundColor: t.color(data.background), overflow: "hidden" }}>
      {previous && fadeIn < 1 ? <Shot shot={previous} opacity={1} /> : null}
      <Shot shot={current} opacity={fadeIn} />
    </AbsoluteFill>
  );
};
