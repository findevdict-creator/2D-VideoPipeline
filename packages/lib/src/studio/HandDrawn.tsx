import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

/** How many times a second the wobble changes. Hand-drawn animation is redrawn on "twos" or "threes"; this sits between. */
const REDRAWS_PER_SEC = 6;

/**
 * The hand-drawn look: everything inside is pushed about by a soft noise field, a few
 * pixels at most, and the field changes a few times a second, so straight lines waver
 * the way they do when each drawing is traced anew. Done as an SVG filter, so it works
 * on any scene without the scene knowing.
 */
export const HandDrawn: React.FC<{ children: React.ReactNode; strength?: number }> = ({ children, strength = 1 }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  // A different field for each redraw, and the same one whenever the same frame is rendered again.
  const seed = (Math.floor(frame / Math.max(1, Math.round(fps / REDRAWS_PER_SEC))) % 89) + 1;
  // Sized against the frame, so the look is the same at any resolution.
  const frequency = 15 / width;
  const push = (width / 330) * strength;
  return (
    <AbsoluteFill>
      <svg width={0} height={0} style={{ position: "absolute" }}>
        <defs>
          <filter id="studio-hand-drawn" x="-2%" y="-2%" width="104%" height="104%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency={frequency} numOctaves={2} seed={seed} result="field" />
            <feDisplacementMap in="SourceGraphic" in2="field" scale={push} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>
      <AbsoluteFill style={{ filter: "url(#studio-hand-drawn)" }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};
