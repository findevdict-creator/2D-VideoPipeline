import React from "react";
import { AbsoluteFill, OffthreadVideo } from "remotion";
import { Captions } from "../captions";
import { useVideoData } from "../context";
import { useAssetUrl } from "./assetUrl";

/**
 * A finished scene clip in a frame of another shape, for exports: the picture is placed
 * (and cropped at the sides when it is drawn larger than the frame) on the video's
 * background colour, and the captions are drawn again in the free space, in a size
 * that suits the new frame.
 */
export const Reframed: React.FC = () => {
  const data = useVideoData();
  const url = useAssetUrl();
  const r = data.reframe;
  if (!r) return null;
  return (
    <AbsoluteFill style={{ backgroundColor: data.style.palette.background, overflow: "hidden" }}>
      <OffthreadVideo
        src={url(r.src)}
        muted
        style={{ position: "absolute", left: r.picture.x, top: r.picture.y, width: r.picture.width, height: r.picture.height, maxWidth: "none" }}
      />
      {r.captions ? <Captions box={r.captions} /> : null}
    </AbsoluteFill>
  );
};
