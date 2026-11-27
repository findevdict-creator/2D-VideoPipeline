import React from "react";
import { AbsoluteFill, OffthreadVideo } from "remotion";
import { Captions } from "../captions";
import { useVideoData } from "../context";
import { useAssetUrl } from "./assetUrl";

/**
 * A finished scene clip in a frame of another shape, for exports: the picture is placed
 * (and cropped where it is drawn larger than the frame) on the video's background colour
 * or on a blurred copy of itself, and the captions are drawn again in a size that suits
 * the new frame: in the free space, or over the picture when it fills the frame.
 */
export const Reframed: React.FC = () => {
  const data = useVideoData();
  const url = useAssetUrl();
  const r = data.reframe;
  if (!r) return null;
  return (
    <AbsoluteFill style={{ backgroundColor: data.style.palette.background, overflow: "hidden" }}>
      {r.backdrop === "blur" ? (
        // The same picture, enlarged past the frame so the blur has no soft edge, and dimmed so the sharp one stands out.
        <OffthreadVideo
          src={url(r.src)}
          muted
          style={{ position: "absolute", inset: "-8%", width: "116%", height: "116%", maxWidth: "none", objectFit: "cover", filter: `blur(${Math.round(data.width * 0.04)}px) brightness(0.55)` }}
        />
      ) : null}
      <OffthreadVideo
        src={url(r.src)}
        muted
        style={{ position: "absolute", left: r.picture.x, top: r.picture.y, width: r.picture.width, height: r.picture.height, maxWidth: "none" }}
      />
      {r.captions ? <Captions box={r.captions} /> : null}
    </AbsoluteFill>
  );
};
