import React from "react";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { useTheme } from "./context";
import { ICONS } from "./icons";
import type { Palette } from "./types";

type Color = keyof Palette | string;

/* ------------------------------------------------------------------ */
/* HTML layer                                                          */
/* ------------------------------------------------------------------ */

/** Full-frame background in the style guide's colour, with optional faint stars or a glow. */
export const Background: React.FC<{ stars?: boolean; glow?: Color; color?: Color }> = ({ stars, glow, color = "background" }) => {
  const t = useTheme();
  return (
    <AbsoluteFill style={{ backgroundColor: t.color(color) }}>
      {glow ? (
        <AbsoluteFill
          style={{ background: `radial-gradient(circle at 50% 45%, ${t.color(glow)}33 0%, transparent 60%)` }}
        />
      ) : null}
      {stars ? (
        <svg width={t.width} height={t.height} style={{ position: "absolute", inset: 0 }}>
          {Array.from({ length: 70 }, (_, i) => (
            <circle
              key={i}
              cx={random(`x${i}`) * t.width}
              cy={random(`y${i}`) * t.height}
              r={1 + random(`r${i}`) * 2}
              fill={t.palette.text}
              opacity={0.15 + random(`o${i}`) * 0.35}
            />
          ))}
        </svg>
      ) : null}
    </AbsoluteFill>
  );
};

/** Large heading, centred horizontally. `progress` (0..1) fades and lifts it in. */
export const Title: React.FC<{
  children: React.ReactNode;
  progress?: number;
  y?: number;
  size?: number;
  color?: Color;
  weight?: number;
}> = ({ children, progress = 1, y, size = 84, color = "text", weight = 800 }) => {
  const t = useTheme();
  return (
    <div
      style={{
        position: "absolute",
        left: t.safe.left,
        right: t.width - t.safe.right,
        top: y ?? t.safe.top + 20,
        textAlign: "center",
        fontFamily: t.fontFamily,
        fontSize: size,
        fontWeight: weight,
        lineHeight: 1.15,
        color: t.color(color),
        opacity: progress,
        translate: `0px ${(1 - progress) * 30}px`,
      }}
    >
      {children}
    </div>
  );
};

/**
 * Short text placed by its anchor point (x, y) in pixels.
 * `box` draws a rounded panel behind it for readability.
 */
export const Label: React.FC<{
  children: React.ReactNode;
  x: number;
  y: number;
  progress?: number;
  size?: number;
  color?: Color;
  anchor?: "center" | "left" | "right";
  box?: boolean | Color;
  weight?: number;
  maxWidth?: number;
}> = ({ children, x, y, progress = 1, size = 44, color = "text", anchor = "center", box, weight = 700, maxWidth }) => {
  const t = useTheme();
  const shift = anchor === "center" ? "-50%" : anchor === "right" ? "-100%" : "0%";
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: `translate(${shift}, -50%)`,
        fontFamily: t.fontFamily,
        fontSize: size,
        fontWeight: weight,
        color: t.color(color),
        whiteSpace: maxWidth ? "normal" : "nowrap",
        maxWidth,
        textAlign: anchor === "right" ? "right" : anchor === "left" ? "left" : "center",
        opacity: progress,
        scale: String(0.85 + 0.15 * progress),
        padding: box ? "0.25em 0.6em" : undefined,
        borderRadius: box ? "0.5em" : undefined,
        backgroundColor: box ? (box === true ? `${t.palette.surface}E6` : t.color(box)) : undefined,
      }}
    >
      {children}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* SVG layer: put these inside <Canvas>, which uses pixel coordinates  */
/* ------------------------------------------------------------------ */

/** A full-frame SVG whose coordinates are the video's pixels (0..width, 0..height). */
export const Canvas: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => {
  const { width, height } = useVideoConfig();
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: "absolute", inset: 0, overflow: "visible", ...style }}
    >
      {children}
    </svg>
  );
};

/** One of the built-in icons (see ICON_NAMES), centred on (x, y). `progress` pops it in. */
export const Icon: React.FC<{
  name: string;
  x: number;
  y: number;
  size?: number;
  color?: Color;
  progress?: number;
  rotate?: number;
}> = ({ name, x, y, size = 160, color = "primary", progress = 1, rotate = 0 }) => {
  const t = useTheme();
  const draw = ICONS[name];
  if (!draw) throw new Error(`Unknown icon "${name}". Available: ${Object.keys(ICONS).join(", ")}`);
  const s = (size / 100) * (0.6 + 0.4 * progress);
  return (
    <g
      transform={`translate(${x} ${y}) rotate(${rotate}) scale(${s}) translate(-50 -50)`}
      opacity={Math.min(1, progress * 2)}
    >
      {draw(t.color(color), t.palette)}
    </g>
  );
};

/** A straight arrow from (x1, y1) to (x2, y2) that draws itself as `progress` goes 0 to 1. */
export const Arrow: React.FC<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  progress?: number;
  color?: Color;
  width?: number;
  dashed?: boolean;
  head?: boolean;
}> = ({ x1, y1, x2, y2, progress = 1, color = "text", width = 8, dashed, head = true }) => {
  const t = useTheme();
  const c = t.color(color);
  const ex = x1 + (x2 - x1) * progress;
  const ey = y1 + (y2 - y1) * progress;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const h = width * 3.2;
  return (
    <g opacity={progress > 0 ? 1 : 0}>
      <line
        x1={x1}
        y1={y1}
        x2={ex}
        y2={ey}
        stroke={c}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={dashed ? `${width * 2.5} ${width * 2}` : undefined}
      />
      {head && progress > 0.05 ? (
        <polygon
          points={`${ex},${ey} ${ex - h * Math.cos(angle - 0.45)},${ey - h * Math.sin(angle - 0.45)} ${
            ex - h * Math.cos(angle + 0.45)
          },${ey - h * Math.sin(angle + 0.45)}`}
          fill={c}
        />
      ) : null}
    </g>
  );
};

/** Any SVG path that draws itself as `progress` goes 0 to 1. */
export const DrawPath: React.FC<{
  d: string;
  progress?: number;
  color?: Color;
  width?: number;
  fill?: Color;
  dashed?: boolean;
}> = ({ d, progress = 1, color = "primary", width = 6, fill, dashed }) => {
  const t = useTheme();
  // pathLength=1 lets us draw by fraction without measuring the path.
  return (
    <path
      d={d}
      pathLength={1}
      fill={fill ? t.color(fill) : "none"}
      fillOpacity={fill ? progress : undefined}
      stroke={t.color(color)}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={dashed ? "0.02 0.015" : `${progress} 1`}
      opacity={dashed ? progress : 1}
    />
  );
};

/** A circle outline that draws itself, with an optional soft fill. */
export const Ring: React.FC<{
  cx: number;
  cy: number;
  r: number;
  progress?: number;
  color?: Color;
  width?: number;
  fillOpacity?: number;
  dashed?: boolean;
}> = ({ cx, cy, r, progress = 1, color = "primary", width = 6, fillOpacity = 0, dashed }) => {
  const t = useTheme();
  const c = t.color(color);
  return (
    <g>
      {fillOpacity > 0 ? <circle cx={cx} cy={cy} r={r} fill={c} opacity={fillOpacity * progress} /> : null}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        pathLength={1}
        fill="none"
        stroke={c}
        strokeWidth={width}
        strokeDasharray={dashed ? "0.015 0.012" : `${progress} 1`}
        opacity={dashed ? progress : 1}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    </g>
  );
};

/** A filled dot. */
export const Dot: React.FC<{ cx: number; cy: number; r?: number; color?: Color; progress?: number }> = ({
  cx,
  cy,
  r = 14,
  color = "accent",
  progress = 1,
}) => {
  const t = useTheme();
  return <circle cx={cx} cy={cy} r={r * progress} fill={t.color(color)} />;
};

/** Rings that expand from (cx, cy) and fade, over and over, starting at `fromFrame`. Great for signals. */
export const PulseRings: React.FC<{
  cx: number;
  cy: number;
  maxRadius?: number;
  count?: number;
  periodSec?: number;
  fromFrame?: number;
  untilFrame?: number;
  color?: Color;
  width?: number;
}> = ({ cx, cy, maxRadius = 260, count = 3, periodSec = 1.6, fromFrame = 0, untilFrame, color = "primary", width = 5 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = useTheme();
  if (frame < fromFrame || (untilFrame !== undefined && frame > untilFrame)) return null;
  const period = periodSec * fps;
  return (
    <g>
      {Array.from({ length: count }, (_, i) => {
        const phase = (((frame - fromFrame) / period + i / count) % 1 + 1) % 1;
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={maxRadius * phase}
            fill="none"
            stroke={t.color(color)}
            strokeWidth={width}
            opacity={1 - phase}
          />
        );
      })}
    </g>
  );
};
