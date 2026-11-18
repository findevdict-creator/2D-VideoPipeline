/**
 * s01 "The Blue Dot's Secret"
 * Close-up of a phone map with a pulsing blue dot whose accuracy halo tightens,
 * then the camera pulls back: the phone shrinks onto a small Earth and a satellite
 * slides in upper right, linked by a dashed gold "~20,000 km" distance line.
 */
import React from "react";
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Background, Canvas, Icon, Label, mix, useAppear, useCueAppear, useCueFrame, useTheme } from "@pipeline/lib";

const DOT_BLUE = "#3D8BFF";
const MAP_BASE = "#24406B";
const MAP_STREET = "#AEBBD0";
const MAP_PARK = "#3D6B58";
const MAP_WATER = "#2E5F9E";
const OCEAN = "#1F5FA8";
const LAND = "#5E9C6B";

// Phone drawn in local units, centred on (0, 0).
const PW = 390;
const PH = 780;
const SCREEN = { x: -173, y: -330, w: 346, h: 660 };
const DOT = { x: 10, y: 40 };

const smooth = Easing.inOut(Easing.cubic);

export default function Scene() {
  const t = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;

  // ---- Cue frames ----
  const dotAt = useCueFrame("blueDot", 0); // "A blue dot on your map"
  const haloAt = useCueFrame("blueDot", 1); // "within a few meters"
  const earthAt = useCueFrame("earth"); // "Its secret"
  const lineAt = useCueFrame("distLine"); // "twenty thousand kilometers"

  // ---- Layout ----
  const cx = t.width / 2;
  const availH = (t.safe.bottom - t.safe.top) / 1.06 - 20; // shell zooms from 1.06
  const s0 = availH / PH;
  const startY = (t.safe.top + t.safe.bottom) / 2;
  const crestY = t.safe.bottom - 90; // top of the Earth arc after the pull-back
  const s1 = 0.22;
  const endY = crestY - (PH * s1) / 2 + 8;
  const R = 1600; // Earth radius
  const sat = { x: Math.round(t.width * 0.77), y: t.safe.top + 175 };

  // ---- Camera pull-back (earth cue) ----
  const z = interpolate(frame, [earthAt, earthAt + 38], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: smooth,
  });
  const phoneScale = mix(s0, s1, z);
  const float = Math.sin(sec * ((2 * Math.PI) / 3)) * 5 * (1 - z);
  const phoneY = mix(startY, endY, z) + float;
  const earthCrest = mix(t.height + 80, crestY, z);
  const earthCy = earthCrest + R;
  const landDrift = frame * 0.35;

  // ---- Blue dot ----
  const pop = spring({ frame: frame - dotAt, fps, config: { damping: 11, stiffness: 140 } });
  const haloShrink = interpolate(frame, [haloAt, haloAt + 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: smooth,
  });
  const breath = Math.sin(sec * ((2 * Math.PI) / 2.2));
  const haloR = mix(140 + 8 * breath, 54 + 3 * breath, haloShrink);
  const pulsePeriod = 1.6 * fps;
  const pulsePhase = frame < dotAt + 10 ? -1 : ((frame - dotAt - 10) % pulsePeriod) / pulsePeriod;
  const dotK = mix(1, 2.3, z); // keep the dot readable once the phone is small

  // ---- Labels ----
  const metresIn = useCueAppear("blueDot", { which: 1, durationSec: 0.5 });
  const metresOut = interpolate(frame, [earthAt, earthAt + 12], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ---- Satellite ----
  const satIn = useCueAppear("sat1", { durationSec: 1.0 });
  const bob = Math.sin(sec * ((2 * Math.PI) / 3.2));
  const satX = sat.x + (1 - satIn) * 340;
  const satY = sat.y - (1 - satIn) * 240 + bob * 6;
  const satRot = (1 - satIn) * 28 + bob * 3;

  // ---- Distance line ----
  const A = { x: cx, y: endY - (PH * s1) / 2 - 26 };
  const dx = sat.x - A.x;
  const dy = sat.y - A.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const B = { x: sat.x - ux * 100, y: sat.y - uy * 100 };
  const draw = interpolate(frame, [lineAt, lineAt + 22], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: smooth,
  });
  const E = { x: mix(A.x, B.x, draw), y: mix(A.y, B.y, draw) };
  const kmIn = useAppear(lineAt + 20, 0.5);
  const mid = { x: mix(A.x, B.x, 0.5), y: mix(A.y, B.y, 0.5) };

  const head = (x: number, y: number, ax: number, ay: number, size: number) => {
    // Arrowhead with its tip at (x, y), pointing along (ax, ay).
    const px = -ay;
    const py = ax;
    return `${x},${y} ${x - ax * size + px * size * 0.6},${y - ay * size + py * size * 0.6} ${
      x - ax * size - px * size * 0.6
    },${y - ay * size - py * size * 0.6}`;
  };

  const gold = t.palette.accent;
  const streetMajor = { stroke: MAP_STREET, strokeWidth: 20, strokeLinecap: "round" as const, fill: "none", opacity: 0.6 };
  const streetMinor = { ...streetMajor, strokeWidth: 11, opacity: 0.4 };

  return (
    <>
      <Background stars />
      <Canvas>
        <defs>
          <clipPath id="s01-screen">
            <rect x={SCREEN.x} y={SCREEN.y} width={SCREEN.w} height={SCREEN.h} rx={30} />
          </clipPath>
          <clipPath id="s01-earth">
            <circle cx={cx} cy={earthCy} r={R} />
          </clipPath>
        </defs>

        {/* Earth arc rising from the bottom */}
        <g opacity={z > 0 ? 1 : 0}>
          <circle cx={cx} cy={earthCy} r={R + 16} fill="none" stroke={t.palette.primary} strokeWidth={14} opacity={0.22} />
          <circle cx={cx} cy={earthCy} r={R} fill={OCEAN} />
          <g clipPath="url(#s01-earth)">
            <g transform={`translate(${-landDrift} ${earthCrest})`}>
              <path d="M180 40 Q300 -10 420 30 Q520 70 470 130 Q360 170 250 140 Q160 100 180 40 Z" fill={LAND} />
              <path d="M760 70 Q840 20 900 60 Q930 110 860 140 Q780 130 760 70 Z" fill={LAND} />
              <path d="M1220 20 Q1360 -10 1500 40 Q1580 90 1520 160 Q1400 200 1300 150 Q1200 90 1220 20 Z" fill={LAND} />
              <path d="M1780 60 Q1880 30 1960 80 Q1990 140 1900 170 Q1800 150 1780 60 Z" fill={LAND} />
              <path d="M2120 30 Q2220 0 2300 50 Q2320 120 2220 140 Q2130 110 2120 30 Z" fill={LAND} />
            </g>
          </g>
        </g>

        {/* Phone with the map and blue dot */}
        <g transform={`translate(${cx} ${phoneY}) scale(${phoneScale})`}>
          <rect x={-PW / 2} y={-PH / 2} width={PW} height={PH} rx={58} fill={t.palette.surface} stroke="#2C4775" strokeWidth={6} />
          <rect x={-45} y={-PH / 2 + 18} width={90} height={12} rx={6} fill={t.palette.background} />
          <rect x={-55} y={PH / 2 - 30} width={110} height={8} rx={4} fill="#3A5687" />
          <g clipPath="url(#s01-screen)">
            <rect x={SCREEN.x} y={SCREEN.y} width={SCREEN.w} height={SCREEN.h} fill={MAP_BASE} />
            <rect x={-160} y={-310} width={130} height={150} rx={18} fill={MAP_PARK} />
            <path d="M80 340 Q120 200 200 150 L200 340 Z" fill={MAP_WATER} />
            <line x1={-200} y1={-230} x2={200} y2={-230} {...streetMinor} />
            <line x1={-200} y1={220} x2={200} y2={220} {...streetMinor} />
            <line x1={-100} y1={-340} x2={-100} y2={340} {...streetMinor} />
            <line x1={120} y1={-340} x2={120} y2={120} {...streetMinor} />
            <path d="M-200 300 Q-40 140 200 -150" {...streetMinor} />
            <line x1={-200} y1={DOT.y} x2={200} y2={DOT.y} {...streetMajor} />
            <line x1={DOT.x} y1={-340} x2={DOT.x} y2={340} {...streetMajor} />

            <g transform={`translate(${DOT.x} ${DOT.y}) scale(${dotK})`} opacity={frame >= dotAt ? 1 : 0}>
              {/* accuracy halo */}
              <circle r={haloR * Math.min(1, pop)} fill={DOT_BLUE} opacity={0.18} />
              <circle r={haloR * Math.min(1, pop)} fill="none" stroke={DOT_BLUE} strokeWidth={3} opacity={0.5} />
              {/* gentle pulse */}
              {pulsePhase >= 0 ? (
                <circle r={mix(26, haloR, pulsePhase)} fill="none" stroke={DOT_BLUE} strokeWidth={5} opacity={0.6 * (1 - pulsePhase)} />
              ) : null}
              {/* the dot */}
              <circle r={27 * pop} fill={DOT_BLUE} stroke="#FFFFFF" strokeWidth={8} />
            </g>
          </g>
        </g>

        {/* Dashed, double-headed distance line */}
        {draw > 0 ? (
          <g>
            <line
              x1={A.x}
              y1={A.y}
              x2={E.x}
              y2={E.y}
              stroke={gold}
              strokeWidth={6}
              strokeLinecap="round"
              strokeDasharray="18 14"
            />
            <polygon points={head(A.x, A.y, -ux, -uy, 22)} fill={gold} opacity={Math.min(1, draw * 4)} />
            {draw > 0.05 ? <polygon points={head(E.x, E.y, ux, uy, 22)} fill={gold} /> : null}
          </g>
        ) : null}

        {/* Satellite */}
        {satIn > 0 ? <Icon name="satellite" x={satX} y={satY} size={170} progress={satIn} color="primary" rotate={satRot} /> : null}
      </Canvas>

      <Label
        x={cx + (PW / 2) * s0 + 40}
        y={startY + DOT.y * s0}
        anchor="left"
        size={46}
        progress={metresIn * metresOut}
        box
      >
        Within a few metres
      </Label>

      <Label x={mid.x + 60} y={mid.y + 40} anchor="left" size={52} color="accent" progress={kmIn} box>
        ~20,000 km
      </Label>
    </>
  );
}
