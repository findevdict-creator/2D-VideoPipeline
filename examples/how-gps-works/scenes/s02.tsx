/**
 * s02 "Thirty Satellites, Atomic Clocks"
 * Earth centred with six tilted orbit lines and 30 satellites gliding along them.
 * One satellite is highlighted and an atomic-clock card expands out of it into the right third,
 * whose last digits tick rapidly and glow gold on "a few billionths of a second".
 */
import React from "react";
import { Easing, interpolate, interpolateColors, random, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Background, Canvas, Icon, Label, PulseRings, mix, useAppear, useCueAppear, useCueFrame, useTheme } from "@pipeline/lib";

const N_ORBITS = 6;
const PER_ORBIT = 5;
const RX = 300;
const RY = 100;
const EARTH_R = 125;
const OCEAN = "#2A64B0";
const LAND = "#5F9E78";
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Orbit phase: a slow drift from the start, ramping up to a steady glide at `glideAt`. */
function phaseAt(f: number, glideAt: number): number {
  const w0 = 0.0025;
  const w1 = 0.008;
  const f0 = glideAt;
  const f1 = glideAt + 24;
  const ramp = f < f0 ? 0 : f < f1 ? ((f - f0) * (f - f0)) / (2 * (f1 - f0)) : (f1 - f0) / 2 + (f - f1);
  return w0 * f + (w1 - w0) * ramp;
}

function orbitPoint(cx: number, cy: number, phiDeg: number, theta: number) {
  const phi = (phiDeg * Math.PI) / 180;
  const lx = RX * Math.cos(theta);
  const ly = RY * Math.sin(theta);
  return {
    x: cx + lx * Math.cos(phi) - ly * Math.sin(phi),
    y: cy + lx * Math.sin(phi) + ly * Math.cos(phi),
    depth: Math.sin(theta), // > 0: in front of the Earth, < 0: behind it
  };
}

function arcPath(cx: number, cy: number, phiDeg: number, from: number, to: number, steps = 48) {
  let d = "";
  for (let s = 0; s <= steps; s++) {
    const p = orbitPoint(cx, cy, phiDeg, from + ((to - from) * s) / steps);
    d += `${s === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
  }
  return d;
}

// Continents on a strip 4 Earth-radii wide that scrolls behind the Earth's disc.
const CONTINENTS: { x: number; y: number; parts: [number, number, number, number][] }[] = [
  { x: 40, y: -40, parts: [[0, 0, 48, 30], [20, 30, 26, 34], [-30, -10, 24, 18]] },
  { x: 170, y: 30, parts: [[0, 0, 36, 50], [22, -30, 28, 22], [-14, 46, 18, 22]] },
  { x: 300, y: -55, parts: [[0, 0, 56, 26], [30, 22, 30, 22]] },
  { x: 410, y: 60, parts: [[0, 0, 34, 24], [24, 10, 20, 16]] },
];

const AtomSymbol: React.FC<{ frame: number; color: string }> = ({ frame, color }) => {
  const spin = frame * 0.4;
  return (
    <svg width={124} height={124} viewBox="-62 -62 124 124">
      <g transform={`rotate(${spin})`}>
        {[0, 60, 120].map((a, k) => {
          const ang = frame * 0.11 + k * 2.1;
          const ex = 52 * Math.cos(ang);
          const ey = 19 * Math.sin(ang);
          return (
            <g key={a} transform={`rotate(${a})`}>
              <ellipse cx={0} cy={0} rx={52} ry={19} fill="none" stroke={color} strokeWidth={4} />
              <circle cx={ex} cy={ey} r={6} fill={color} />
            </g>
          );
        })}
      </g>
      <circle cx={0} cy={0} r={11} fill={color} />
    </svg>
  );
};

export default function Scene() {
  const t = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ---- Timing (all from the storyboard cues) ----
  const orbitsAt = useCueFrame("orbits", 0); // "About thirty GPS satellites"
  const glideAt = useCueFrame("orbits", 1); // "circle the Earth"
  const cardAt = useCueFrame("clockCard", 0); // "carries atomic clocks"
  const tickAt = useCueFrame("clockCard", 1); // "a few billionths of a second"
  const highlightAt = cardAt - Math.round(0.7 * fps); // on "Each one"

  const earthIn = useAppear(0, 0.6);
  const labelIn = useCueAppear("countLabel", { durationSec: 0.8 });
  const hlIn = useAppear(highlightAt, 0.5);
  const cardIn = useCueAppear("clockCard", { durationSec: 0.75 });
  const titleIn = useCueAppear("clockCard", { durationSec: 0.6, delaySec: 0.35 });
  const glow = useCueAppear("clockCard", { which: 1, durationSec: 0.5 });
  const footerIn = useCueAppear("clockCard", { which: 1, durationSec: 0.6, delaySec: 0.4 });

  // ---- Layout ----
  const cx = t.width / 2;
  const cy = Math.round((t.safe.top + t.safe.bottom) / 2);
  const cardW = 500;
  const cardH = 410;
  const cardRight = t.safe.right;
  const cardLeft = cardRight - cardW;
  const cardCX = cardLeft + cardW / 2;
  const cardCY = cy;
  const cardTop = cardCY - cardH / 2;

  const accent = t.palette.accent;
  const primary = t.palette.primary;

  // ---- Orbits ----
  const orbitAngles = Array.from({ length: N_ORBITS }, (_, i) => i * 30);
  const orbitDraw = orbitAngles.map((_, i) =>
    interpolate(frame, [orbitsAt + i * 3, orbitsAt + i * 3 + 20], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.inOut(Easing.cubic),
    }),
  );
  const dim = mix(1, 0.55, hlIn);

  // ---- Satellites ----
  const phase = phaseAt(frame, glideAt);
  // Place satellite (0,0) at the upper-right of the flat orbit when the card opens, so it stays beside the card.
  const base = -0.55 - phaseAt(cardAt, glideAt);
  const sats = [] as { key: string; x: number; y: number; depth: number; pop: number; hl: boolean }[];
  for (let i = 0; i < N_ORBITS; i++) {
    for (let j = 0; j < PER_ORBIT; j++) {
      const k = j * N_ORBITS + i;
      const popAt = orbitsAt + 27 + k * 1.45;
      const pop =
        frame < popAt
          ? 0
          : spring({ frame: frame - popAt, fps, config: { damping: 10, stiffness: 170, mass: 0.6 } });
      const theta = base + i * 0.55 + (j * 2 * Math.PI) / PER_ORBIT + phase;
      const p = orbitPoint(cx, cy, orbitAngles[i] ?? 0, theta);
      sats.push({ key: `${i}-${j}`, x: p.x, y: p.y, depth: p.depth, pop, hl: i === 0 && j === 0 });
    }
  }
  const hlSat = sats.find((s) => s.hl)!;

  const renderSat = (s: (typeof sats)[number]) => {
    if (s.pop <= 0) return null;
    const depthT = (s.depth + 1) / 2;
    const size = mix(36, 48, depthT);
    const op = (s.depth < 0 ? 0.65 : 1) * dim;
    return (
      <g key={s.key} opacity={op}>
        <Icon name="satellite" x={s.x} y={s.y} size={size * s.pop} color="primary" />
      </g>
    );
  };

  // ---- Highlighted satellite & card geometry ----
  const hlColor = interpolateColors(hlIn, [0, 1], [primary, accent]);
  const hlBump = 1 + 0.35 * Math.sin(Math.PI * clamp01(hlIn * 1.4));
  const ringPulse = 0.5 + 0.5 * Math.sin((frame - highlightAt) * 0.18);

  const cardScale = mix(0.06, 1, cardIn);
  const curCX = mix(hlSat.x, cardCX, cardIn);
  const curCY = mix(hlSat.y, cardCY, cardIn);
  const curLeft = curCX - (cardW / 2) * cardScale;

  // ---- Clock readout ----
  const elapsed = Math.max(0, frame - cardAt);
  const ns = Math.floor((elapsed * 1e9) / fps) + 1;
  const secs = Math.floor(ns / 1e9);
  const frac = String(ns % 1e9).padStart(9, "0");
  const ms = frac.slice(0, 3);
  const fine =
    frame >= tickAt ? String(Math.floor(random(`s02-ns-${frame}`) * 1e6)).padStart(6, "0") : frac.slice(3);
  const fineColor = interpolateColors(glow, [0, 1], ["rgba(244,247,251,0.5)", accent]);
  const glowPulse = 0.5 + 0.5 * Math.sin((frame - tickAt) * 0.3);
  const glowPx = glow * (10 + 8 * glowPulse);

  // ---- Earth ----
  const drift = frame * 0.6;
  const strip = EARTH_R * 4;
  const earthScale = mix(0.9, 1, earthIn);

  return (
    <>
      <Background stars />
      <Canvas>
        <defs>
          <clipPath id="s02-earth-clip">
            <circle cx={cx} cy={cy} r={EARTH_R} />
          </clipPath>
        </defs>

        {/* Back halves of the orbit lines, behind the Earth */}
        <g opacity={dim}>
          {orbitAngles.map((phi, i) => {
            const prog = clamp01((orbitDraw[i] ?? 0) * 2 - 1);
            if (prog <= 0) return null;
            return (
              <path
                key={`b${i}`}
                d={arcPath(cx, cy, phi, Math.PI, 2 * Math.PI)}
                pathLength={1}
                fill="none"
                stroke={t.palette.surface}
                strokeWidth={4}
                strokeLinecap="round"
                strokeDasharray={`${prog} 1`}
              />
            );
          })}
        </g>
        {sats.filter((s) => !s.hl && s.depth < 0).map(renderSat)}

        {/* Earth */}
        <g
          transform={`translate(${cx} ${cy}) scale(${earthScale}) translate(${-cx} ${-cy})`}
          opacity={earthIn}
        >
          <circle cx={cx} cy={cy} r={EARTH_R + 12} fill="none" stroke={primary} strokeWidth={8} opacity={0.22} />
          <circle cx={cx} cy={cy} r={EARTH_R} fill={OCEAN} />
          <g clipPath="url(#s02-earth-clip)">
            {CONTINENTS.map((c, n) => {
              const x = ((((c.x - drift) % strip) + strip) % strip) - strip / 2;
              return (
                <g key={n} transform={`translate(${cx + x} ${cy + c.y})`} fill={LAND}>
                  {c.parts.map(([dx, dy, rx, ry], m) => (
                    <ellipse key={m} cx={dx} cy={dy} rx={rx} ry={ry} />
                  ))}
                </g>
              );
            })}
            <circle cx={cx + EARTH_R * 1.15} cy={cy + EARTH_R * 0.3} r={EARTH_R * 1.05} fill={t.palette.background} opacity={0.28} />
          </g>
        </g>

        {/* Front halves of the orbit lines, over the Earth */}
        <g opacity={dim}>
          {orbitAngles.map((phi, i) => {
            const prog = clamp01((orbitDraw[i] ?? 0) * 2);
            if (prog <= 0) return null;
            return (
              <path
                key={`f${i}`}
                d={arcPath(cx, cy, phi, 0, Math.PI)}
                pathLength={1}
                fill="none"
                stroke={t.palette.surface}
                strokeWidth={4}
                strokeLinecap="round"
                strokeDasharray={`${prog} 1`}
              />
            );
          })}
        </g>
        {sats.filter((s) => !s.hl && s.depth >= 0).map(renderSat)}

        {/* Highlighted satellite, always on top */}
        {frame >= highlightAt ? (
          <>
            <PulseRings cx={hlSat.x} cy={hlSat.y} maxRadius={60} count={2} periodSec={1.4} fromFrame={highlightAt} color="accent" width={3} />
            <circle
              cx={hlSat.x}
              cy={hlSat.y}
              r={(34 + 3 * ringPulse) * hlIn}
              fill="none"
              stroke={accent}
              strokeWidth={4}
              opacity={hlIn}
            />
          </>
        ) : null}
        {cardIn > 0 ? (
          <line
            x1={hlSat.x}
            y1={hlSat.y}
            x2={curLeft}
            y2={curCY}
            stroke={accent}
            strokeWidth={3}
            strokeLinecap="round"
            opacity={0.8 * Math.min(1, cardIn * 3)}
          />
        ) : null}
        {hlSat.pop > 0 ? (
          <Icon name="satellite" x={hlSat.x} y={hlSat.y} size={46 * hlSat.pop * hlBump} color={hlColor} />
        ) : null}
      </Canvas>

      <Label x={t.safe.left} y={t.safe.top + 50} anchor="left" size={56} progress={labelIn} box>
        ~30 satellites
      </Label>

      {/* Atomic clock card, expanding out of the highlighted satellite */}
      {cardIn > 0 ? (
        <div
          style={{
            position: "absolute",
            left: cardLeft,
            top: cardTop,
            width: cardW,
            height: cardH,
            boxSizing: "border-box",
            transform: `translate(${curCX - cardCX}px, ${curCY - cardCY}px) scale(${cardScale})`,
            transformOrigin: "50% 50%",
            opacity: Math.min(1, cardIn * 3),
            backgroundColor: t.palette.surface,
            borderRadius: 28,
            border: `3px solid rgba(255, 200, 87, ${0.3 + 0.6 * glow})`,
            padding: "24px 20px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            fontFamily: t.fontFamily,
          }}
        >
          <AtomSymbol frame={frame} color={accent} />
          <div
            style={{
              fontSize: 46,
              fontWeight: 800,
              color: t.palette.text,
              opacity: titleIn,
              translate: `0px ${(1 - titleIn) * 16}px`,
              lineHeight: 1.1,
            }}
          >
            Atomic clocks
          </div>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 36,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              color: t.palette.text,
              backgroundColor: t.palette.background,
              borderRadius: 14,
              padding: "12px 22px 16px",
              whiteSpace: "nowrap",
              lineHeight: 1.1,
            }}
          >
            <span>{`12:00:${String(secs).padStart(2, "0")}.${ms}`}</span>
            <span
              style={{
                position: "relative",
                color: fineColor,
                textShadow: glowPx > 0.5 ? `0 0 ${glowPx}px rgba(255, 200, 87, 0.85)` : undefined,
              }}
            >
              {fine}
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  bottom: -6,
                  height: 4,
                  borderRadius: 2,
                  width: `${glow * 100}%`,
                  backgroundColor: accent,
                }}
              />
            </span>
          </div>
          <div
            style={{
              fontSize: 36,
              fontWeight: 700,
              color: accent,
              opacity: footerIn,
              translate: `0px ${(1 - footerIn) * 16}px`,
              lineHeight: 1.1,
              whiteSpace: "nowrap",
            }}
          >
            Billionths of a second
          </div>
        </div>
      ) : null}
    </>
  );
}
