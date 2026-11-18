/**
 * s04 "Time Becomes Distance"
 * Satellite (top-left) with a teal "Sent" clock, phone (bottom-right) with a coral "Arrived" clock.
 * One teal pulse travels the diagonal; both clocks freeze as it leaves / lands, a gold bracket
 * marks the "< 0.1 s" gap, the equation assembles in a bottom banner and the trail becomes a
 * gold measured line with tick marks.
 */
import React from "react";
import { Easing, interpolate, interpolateColors, useCurrentFrame } from "remotion";
import { Background, Canvas, DrawPath, Icon, useAppear, useCueFrame, useCues, useTheme, mix } from "@pipeline/lib";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const EASE = Easing.bezier(0.16, 1, 0.3, 1);
const EASE_IN_OUT = Easing.inOut(Easing.cubic);
const LOCATION_BLUE = "#3D8BFF";

/** Simulated clock in "slow motion": 67 ms pass between the pulse leaving and landing. */
const formatClock = (ms: number) => {
  const total = 12 * 3600000 + Math.round(ms);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return { main: `${p(h)}:${p(m)}:${p(s)}`, frac: `.${p(milli, 3)}` };
};

const ClockCard: React.FC<{
  cx: number;
  cy: number;
  label: string;
  color: string;
  ms: number;
  freezeAt: number;
  appear: number;
  gapHighlight: number;
}> = ({ cx, cy, label, color, ms, freezeAt, appear, gapHighlight }) => {
  const t = useTheme();
  const frame = useCurrentFrame();
  const frozen = interpolate(frame, [freezeAt, freezeAt + 8], [0, 1], clamp);
  const bump = interpolate(frame, [freezeAt, freezeAt + 5, freezeAt + 16], [0, 1, 0], clamp);
  const glow = frozen * (14 + 8 * Math.sin((frame - freezeAt) / 9));
  const { main, frac } = formatClock(ms);
  const digitColor = interpolateColors(frozen, [0, 1], [t.palette.text, color]);
  const fracColor = interpolateColors(gapHighlight, [0, 1], [digitColor, t.palette.accent]);
  // "Live" dot blinks while the clock runs, then stays solid once frozen.
  const blink = 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(frame / 4));
  const dotOpacity = mix(blink, 1, frozen);
  const W = 460;
  const H = 165;
  return (
    <div
      style={{
        position: "absolute",
        left: cx - W / 2,
        top: cy - H / 2,
        width: W,
        height: H,
        boxSizing: "border-box",
        borderRadius: 24,
        backgroundColor: t.palette.surface,
        border: `4px solid ${interpolateColors(frozen, [0, 1], ["rgba(244, 247, 251, 0.25)", color])}`,
        boxShadow: `0 0 ${glow}px ${color}88`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        gap: 4,
        fontFamily: t.fontFamily,
        opacity: appear,
        scale: String((0.85 + 0.15 * appear) * (1 + 0.07 * bump)),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: color, opacity: dotOpacity }} />
        <div style={{ fontSize: 40, fontWeight: 700, color, lineHeight: 1.1 }}>{label}</div>
      </div>
      <div
        style={{
          fontSize: 54,
          fontWeight: 700,
          lineHeight: 1.15,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: 1,
          color: digitColor,
        }}
      >
        {main}
        <span style={{ color: fracColor }}>{frac}</span>
      </div>
    </div>
  );
};

export default function Scene() {
  const t = useTheme();
  const frame = useCurrentFrame();

  // Cue frames (from the storyboard timing).
  const sentAt = useCueFrame("sentClock"); // pulse leaves
  const arrivedAt = useCueFrame("arrivedClock"); // pulse lands
  const gapAt = useCueFrame("gapLabel");
  const eqAt = useCueFrame("equation");
  const eqEnd = useCues("equation")[0]?.endFrame ?? eqAt + 95;
  const measureAt = useCueFrame("pulse", 1);

  // ---------- Layout ----------
  // Clocks sit above the diagonal so the pulse path never crosses them.
  const sat = { x: t.safe.left + 164, y: t.safe.top + 245 };
  const phone = { x: t.safe.right - 164, y: t.safe.top + 595 };
  const sentCard = { x: sat.x + 380, y: sat.y - 120 };
  const arrivedCard = { x: phone.x - 100, y: phone.y - 230 };
  const dx = phone.x - sat.x;
  const dy = phone.y - sat.y;
  const len = Math.hypot(dx, dy);
  const u = { x: dx / len, y: dy / len };
  const n = { x: -u.y, y: u.x };
  const P0 = { x: sat.x + u.x * 100, y: sat.y + u.y * 100 };
  const P1 = { x: phone.x - u.x * 95, y: phone.y - u.y * 95 };

  // ---------- Entrances ----------
  const satIn = useAppear(0, 0.6);
  const sentIn = useAppear(6, 0.6);
  const phoneIn = useAppear(10, 0.6);
  const arrivedIn = useAppear(16, 0.6);
  const satBob = 5 * Math.sin(frame / 18);

  // ---------- Clocks ----------
  const msAt = (f: number) => ((f - sentAt) * 67) / Math.max(1, arrivedAt - sentAt);
  const sentMs = msAt(Math.min(frame, sentAt));
  const arrivedMs = msAt(Math.min(frame, arrivedAt));

  // ---------- Pulse ----------
  const travel = EASE_IN_OUT(interpolate(frame, [sentAt, arrivedAt], [0, 1], clamp));
  const pos = { x: mix(P0.x, P1.x, travel), y: mix(P0.y, P1.y, travel) };
  const pulseVisible = frame >= sentAt;
  const launch = interpolate(frame, [sentAt, sentAt + 6], [0, 1], { ...clamp, easing: EASE });
  const absorb = interpolate(frame, [arrivedAt, arrivedAt + 12], [1, 0], clamp);
  const pulseScale = launch * absorb * (1 + 0.08 * Math.sin(frame / 3));

  // ---------- Measured line ----------
  const measure = interpolate(frame, [measureAt, measureAt + 14], [0, 1], { ...clamp, easing: EASE });
  const trailColor = interpolateColors(measure, [0, 1], [t.palette.primary, t.palette.accent]);
  const trailOpacity = mix(0.35, 1, measure);
  const trailWidth = mix(5, 7, measure);
  const shimmer = measure * (0.25 + 0.15 * Math.sin(frame / 7));
  const ticks = Array.from({ length: 11 }, (_, i) => i);

  // ---------- Gap bracket ----------
  const bracketY = sentCard.y;
  const bracketX0 = sentCard.x + 230 + 16;
  const bracketX1 = arrivedCard.x;
  const bracketY1 = arrivedCard.y - 82 - 14;
  const bracketDraw = interpolate(frame, [gapAt, gapAt + 30], [0, 1], { ...clamp, easing: EASE_IN_OUT });
  const gapLabelIn = useAppear(gapAt + 22, 0.6);
  const gapHighlight = interpolate(frame, [gapAt + 18, gapAt + 30], [0, 1], clamp);
  const endTick = interpolate(bracketDraw, [0.9, 1], [0, 1], clamp);

  // ---------- Equation ----------
  const bannerIn = useAppear(eqAt, 0.6);
  const span = eqEnd - eqAt;
  const words: { text: string; at: number; color: string }[] = [
    { text: "distance", at: eqAt + Math.round(span * 0.88), color: t.palette.accent },
    { text: "=", at: eqAt + Math.round(span * 0.76), color: t.palette.text },
    { text: "time", at: eqAt + Math.round(span * 0.21), color: t.palette.text },
    { text: "x", at: eqAt + Math.round(span * 0.38), color: t.palette.text },
    { text: "speed of light", at: eqAt + Math.round(span * 0.6), color: t.palette.primary },
  ];
  const wordProgress = words.map((w) =>
    interpolate(frame, [w.at, w.at + 14], [0, 1], { ...clamp, easing: EASE }),
  );
  const distanceBump = interpolate(frame, [measureAt + 10, measureAt + 20, measureAt + 34], [0, 1, 0], clamp);
  const bannerCy = t.safe.bottom - 70;

  // Departure / arrival ripples.
  const ripple = (start: number, dur: number) => interpolate(frame, [start, start + dur], [0, 1], clamp);
  const depart = ripple(sentAt, 22);
  const arrive1 = ripple(arrivedAt, 28);
  const arrive2 = ripple(arrivedAt + 8, 28);
  const screenGlow = interpolate(frame, [arrivedAt, arrivedAt + 6, arrivedAt + 30], [0, 1, 0.25], clamp);

  return (
    <>
      <Background stars />
      <Canvas>
        {/* Trail → measured line */}
        {pulseVisible ? (
          <g>
            <line
              x1={P0.x}
              y1={P0.y}
              x2={pos.x}
              y2={pos.y}
              stroke={trailColor}
              strokeWidth={trailWidth + 14}
              strokeLinecap="round"
              opacity={shimmer}
            />
            <line
              x1={P0.x}
              y1={P0.y}
              x2={pos.x}
              y2={pos.y}
              stroke={trailColor}
              strokeWidth={trailWidth}
              strokeLinecap="round"
              opacity={trailOpacity}
            />
          </g>
        ) : null}
        {ticks.map((i) => {
          const f = i / 10;
          const isEnd = i === 0 || i === 10;
          const p = interpolate(frame, [measureAt + 6 + i * 3, measureAt + 14 + i * 3], [0, 1], {
            ...clamp,
            easing: EASE,
          });
          const half = (isEnd ? 26 : 14) * p;
          const cx = mix(P0.x, P1.x, f);
          const cy = mix(P0.y, P1.y, f);
          return (
            <line
              key={i}
              x1={cx - n.x * half}
              y1={cy - n.y * half}
              x2={cx + n.x * half}
              y2={cy + n.y * half}
              stroke={t.palette.accent}
              strokeWidth={isEnd ? 7 : 5}
              strokeLinecap="round"
              opacity={p}
            />
          );
        })}

        {/* Departure ripple at the satellite */}
        {depart > 0 && depart < 1 ? (
          <circle cx={P0.x} cy={P0.y} r={mix(20, 110, depart)} fill="none" stroke={t.palette.primary} strokeWidth={5} opacity={1 - depart} />
        ) : null}

        {/* Satellite */}
        <Icon name="satellite" x={sat.x} y={sat.y + satBob} size={180} progress={satIn} color="primary" />

        {/* Phone with a little map screen */}
        <Icon name="phone" x={phone.x} y={phone.y} size={190} progress={phoneIn} color="text" />
        <g opacity={phoneIn}>
          <rect
            x={phone.x - 30}
            y={phone.y - 61}
            width={60}
            height={114}
            rx={6}
            fill={t.palette.primary}
            opacity={0.35 * screenGlow}
          />
          <path
            d={`M ${phone.x - 30} ${phone.y - 20} L ${phone.x + 30} ${phone.y + 10} M ${phone.x - 8} ${phone.y - 61} L ${phone.x + 4} ${phone.y + 53}`}
            stroke={t.palette.text}
            strokeOpacity={0.25}
            strokeWidth={4}
            fill="none"
          />
          <circle cx={phone.x - 2} cy={phone.y - 4} r={16} fill={LOCATION_BLUE} opacity={0.3} />
          <circle cx={phone.x - 2} cy={phone.y - 4} r={8} fill={LOCATION_BLUE} stroke="white" strokeWidth={2.5} />
        </g>

        {/* Arrival ripples at the phone */}
        {[arrive1, arrive2].map((a, i) =>
          a > 0 && a < 1 ? (
            <circle key={i} cx={phone.x} cy={phone.y} r={mix(60, 170, a)} fill="none" stroke={t.palette.primary} strokeWidth={5} opacity={0.8 * (1 - a)} />
          ) : null,
        )}

        {/* The pulse */}
        {pulseVisible && pulseScale > 0.01 ? (
          <g transform={`translate(${pos.x} ${pos.y}) scale(${pulseScale})`}>
            <circle r={48} fill={t.palette.primary} opacity={0.2} />
            <circle r={30} fill="none" stroke={t.palette.primary} strokeWidth={7} />
            <circle r={10} fill={t.palette.text} />
          </g>
        ) : null}

        {/* Gold gap bracket between the clocks */}
        {bracketDraw > 0 ? (
          <DrawPath
            d={`M ${bracketX0} ${bracketY} H ${bracketX1} V ${bracketY1}`}
            progress={bracketDraw}
            color="accent"
            width={6}
          />
        ) : null}
        <line
          x1={bracketX0}
          y1={bracketY - 20 * Math.min(1, bracketDraw * 8)}
          x2={bracketX0}
          y2={bracketY + 20 * Math.min(1, bracketDraw * 8)}
          stroke={t.palette.accent}
          strokeWidth={6}
          strokeLinecap="round"
          opacity={bracketDraw > 0 ? 1 : 0}
        />
        <line
          x1={bracketX1 - 20 * endTick}
          y1={bracketY1}
          x2={bracketX1 + 20 * endTick}
          y2={bracketY1}
          stroke={t.palette.accent}
          strokeWidth={6}
          strokeLinecap="round"
          opacity={endTick}
        />
      </Canvas>

      {/* Clocks */}
      <ClockCard
        cx={sentCard.x}
        cy={sentCard.y}
        label="Sent"
        color={t.palette.primary}
        ms={sentMs}
        freezeAt={sentAt}
        appear={sentIn}
        gapHighlight={gapHighlight}
      />
      <ClockCard
        cx={arrivedCard.x}
        cy={arrivedCard.y}
        label="Arrived"
        color={t.palette.secondary}
        ms={arrivedMs}
        freezeAt={arrivedAt}
        appear={arrivedIn}
        gapHighlight={gapHighlight}
      />

      {/* Gap label */}
      <div
        style={{
          position: "absolute",
          left: (bracketX0 + bracketX1) / 2,
          top: bracketY - 52,
          transform: "translate(-50%, -50%)",
          fontFamily: t.fontFamily,
          fontSize: 54,
          fontWeight: 800,
          color: t.palette.accent,
          whiteSpace: "nowrap",
          opacity: gapLabelIn,
          translate: `0px ${(1 - gapLabelIn) * 16}px`,
        }}
      >
        {"< 0.1 s"}
      </div>

      {/* Equation banner */}
      <div
        style={{
          position: "absolute",
          left: t.width / 2,
          top: bannerCy,
          transform: "translate(-50%, -50%)",
          height: 112,
          padding: "0 56px",
          boxSizing: "border-box",
          borderRadius: 28,
          backgroundColor: t.palette.surface,
          border: `3px solid ${t.palette.text}22`,
          display: "flex",
          alignItems: "center",
          gap: 24,
          fontFamily: t.fontFamily,
          fontSize: 58,
          fontWeight: 700,
          whiteSpace: "nowrap",
          opacity: bannerIn,
          translate: `0px ${(1 - bannerIn) * 50}px`,
        }}
      >
        {words.map((w, i) => {
          const p = wordProgress[i] ?? 0;
          return (
          <span
            key={w.text}
            style={{
              display: "inline-block",
              color: w.color,
              opacity: p,
              translate: `0px ${(1 - p) * 36}px`,
              scale: i === 0 ? String(1 + 0.1 * distanceBump) : undefined,
            }}
          >
            {w.text}
          </span>
          );
        })}
      </div>
    </>
  );
}
