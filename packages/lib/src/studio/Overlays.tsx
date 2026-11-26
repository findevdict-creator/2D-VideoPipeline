import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { useScene, useTheme } from "../context";
import { Arrow, Canvas, Label } from "../primitives";
import type { OverlayData } from "../types";

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

/** 0 to 1 as an overlay comes in, back to 0 as it leaves. */
function usePresence(o: OverlayData): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fade = Math.max(1, Math.round(fps * 0.4));
  const inP = interpolate(frame, [o.startFrame, o.startFrame + fade], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
  if (o.endFrame === null) return inP;
  const outP = interpolate(frame, [o.endFrame - fade, o.endFrame], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return Math.min(inP, outP);
}

const One: React.FC<{ o: OverlayData }> = ({ o }) => {
  const t = useTheme();
  const p = usePresence(o);
  if (p <= 0) return null;
  const px = (x: number) => x * t.width;
  const py = (y: number) => y * t.height;
  const color = o.color ?? "accent";

  if (o.kind === "label") {
    return (
      <Label x={px(o.x)} y={py(o.y)} progress={p} box={o.box} size={o.size ?? Math.round(t.height * 0.042)} color={o.color ?? "text"}>
        {o.text}
      </Label>
    );
  }
  if (o.kind === "arrow") {
    return (
      <Canvas>
        <Arrow x1={px(o.from[0])} y1={py(o.from[1])} x2={px(o.to[0])} y2={py(o.to[1])} progress={p} color={color} width={Math.max(4, t.height * 0.007)} />
      </Canvas>
    );
  }
  if (o.kind === "callout") {
    return (
      <>
        <Canvas>
          <g opacity={p}>
            <line
              x1={px(o.x)}
              y1={py(o.y)}
              x2={px(o.x) + (px(o.target[0]) - px(o.x)) * p}
              y2={py(o.y) + (py(o.target[1]) - py(o.y)) * p}
              stroke={t.color(color)}
              strokeWidth={Math.max(3, t.height * 0.004)}
              strokeLinecap="round"
            />
            <circle cx={px(o.target[0])} cy={py(o.target[1])} r={Math.max(6, t.height * 0.009) * p} fill={t.color(color)} />
          </g>
        </Canvas>
        <Label x={px(o.x)} y={py(o.y)} progress={p} box size={Math.round(t.height * 0.038)}>
          {o.text}
        </Label>
      </>
    );
  }
  // text-card: a title card across the middle of the frame
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", backgroundColor: `rgba(0, 0, 0, ${0.35 * p})` }}>
      <div
        style={{
          maxWidth: t.width * 0.72,
          padding: `${t.height * 0.045}px ${t.width * 0.045}px`,
          borderRadius: t.height * 0.025,
          backgroundColor: `${t.palette.surface}F2`,
          borderLeft: `${Math.max(6, t.width * 0.006)}px solid ${t.color(color)}`,
          fontFamily: t.fontFamily,
          color: t.palette.text,
          opacity: p,
          translate: `0px ${(1 - p) * 30}px`,
        }}
      >
        <div style={{ fontSize: Math.round(t.height * 0.066), fontWeight: 800, lineHeight: 1.15 }}>{o.title}</div>
        {o.body ? <div style={{ fontSize: Math.round(t.height * 0.038), marginTop: t.height * 0.018, opacity: 0.85, lineHeight: 1.35 }}>{o.body}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

/** Labels, arrows, callouts and text cards from the scene's spec, on top of any scene type. */
export const Overlays: React.FC = () => {
  const scene = useScene();
  if (!scene.overlays?.length) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {scene.overlays.map((o, i) => (
        <One key={i} o={o} />
      ))}
    </AbsoluteFill>
  );
};
