import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { useTheme, useVideoData } from "./context";
import type { Box } from "./types";

/**
 * Word-by-word captions: one short line at a time, with the word being spoken highlighted.
 * Without `box` they sit at the bottom (or top) of the frame. With it they are laid out
 * inside that rectangle, starting at its top, in the given size: that is how an export
 * in another shape gets captions that fit it.
 */
export const Captions: React.FC<{ box?: Box & { fontSize: number } }> = ({ box }) => {
  const frame = useCurrentFrame();
  const { captions } = useVideoData();
  const t = useTheme();
  if (!captions.enabled) return null;
  const page = captions.pages.find((p) => frame >= p.startFrame && frame < p.endFrame);
  if (!page) return null;
  const highlight = t.color(captions.highlight);
  return (
    <AbsoluteFill
      style={
        box
          ? { left: box.x, top: box.y, width: box.width, height: box.height, justifyContent: "flex-start", alignItems: "center", pointerEvents: "none" }
          : {
              justifyContent: captions.position === "top" ? "flex-start" : "flex-end",
              alignItems: "center",
              padding: `${Math.round(t.height * 0.05)}px ${Math.round(t.width * 0.08)}px`,
              pointerEvents: "none",
            }
      }
    >
      <div
        style={{
          fontFamily: t.fontFamily,
          fontSize: box?.fontSize ?? captions.fontSize,
          fontWeight: 800,
          lineHeight: 1.25,
          textAlign: "center",
          whiteSpace: "pre-wrap",
          color: t.palette.text,
          backgroundColor: "rgba(0, 0, 0, 0.45)",
          padding: "0.2em 0.6em",
          borderRadius: "0.4em",
        }}
      >
        {page.tokens.map((token, i) => {
          const active = frame >= token.startFrame && frame < token.endFrame;
          return (
            <span key={i} style={{ color: active ? highlight : undefined }}>
              {token.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
