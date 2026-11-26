import React from "react";
import { AbsoluteFill, Freeze, Loop, OffthreadVideo, useCurrentFrame } from "remotion";
import { useScene, useTheme } from "../context";
import { useAssetUrl } from "./assetUrl";

/**
 * A video clip fitted to the scene's length: trimmed, slowed down, and after it
 * runs out either held on its last frame or looped.
 */
export const FootageScene: React.FC = () => {
  const frame = useCurrentFrame();
  const scene = useScene();
  const t = useTheme();
  const url = useAssetUrl();
  const f = scene.footage;
  if (!f) return null;
  const covered = Math.max(1, f.coveredFrames);
  const video = (
    <OffthreadVideo
      src={url(f.src)}
      trimBefore={f.trimBeforeFrames}
      playbackRate={f.playbackRate}
      muted
      style={{ width: "100%", height: "100%", objectFit: f.objectFit }}
    />
  );
  let body: React.ReactNode = video;
  if (covered < scene.durationInFrames) {
    body =
      f.after === "loop" ? (
        <Loop durationInFrames={covered}>{video}</Loop>
      ) : (
        <Freeze frame={covered - 1} active={frame >= covered}>
          {video}
        </Freeze>
      );
  }
  return <AbsoluteFill style={{ backgroundColor: t.palette.background }}>{body}</AbsoluteFill>;
};
