/**
 * s07 "Back to the Blue Dot"
 * Back on the phone map: tiny signal rings keep arriving from four satellites while the
 * blue dot glides along a curving street. The phone then eases up to make room for a
 * three-chip recap row (teal, coral, gold) joined by arrows, ending on a final dot pulse.
 */
import React from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Arrow, Background, Canvas, Icon, mix, useAppear, useCueFrame, useCues, useTheme } from "@pipeline/lib";

const DOT_BLUE = "#3D8BFF";
const MAP_BASE = "#24406B";
const MAP_STREET = "#AEBBD0";
const MAP_PARK = "#3D6B58";
const MAP_WATER = "#2E5F9E";

// Phone drawn in local units, centred on (0, 0) (same look as s01).
const PW = 390;
const PH = 780;
const SCREEN = { x: -173, y: -330, w: 346, h: 660 };

// The curving street the dot follows (cubic Bezier, phone-local coordinates).
const P0 = { x: -230, y: 260 };
const P1 = { x: -30, y: 250 };
const P2 = { x: 10, y: -170 };
const P3 = { x: 230, y: -190 };
const STREET_D = `M${P0.x} ${P0.y} C${P1.x} ${P1.y} ${P2.x} ${P2.y} ${P3.x} ${P3.y}`;

const bez = (u: number) => {
  const a = (1 - u) ** 3;
  const b = 3 * (1 - u) ** 2 * u;
  const c = 3 * (1 - u) * u * u;
  const d = u ** 3;
  return { x: a * P0.x + b * P1.x + c * P2.x + d * P3.x, y: a * P0.y + b * P1.y + c * P2.y + d * P3.y };
};

const smooth = Easing.inOut(Easing.cubic);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export default function Scene() {
  const t = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;

  // ---- Cue frames ----
  const signalAt = useCueFrame("phoneMap"); // "repeats this nonstop"
  const moveAt = useCueFrame("blueDot"); // "the blue dot follows you"
  const moveEnd = useCues("blueDot")[0]?.endFrame ?? moveAt + 60;
  const chip1At = useCueFrame("recap", 0); // "satellites send the time"
  const chip2Cue = useCueFrame("recap", 1); // "time becomes distance"
  const chip3Cue = useCueFrame("recap", 2); // "four distances find you"
  const pulseAt = chip3Cue + 24; // "find you"
  const makeRoomAt = chip1At - 24; // "So remember"

  // ---- Layout ----
  const cx = t.width / 2;
  const chipH = 92;
  const chipY = t.safe.bottom - chipH / 2 - 16;
  const chipTop = chipY - chipH / 2;

  const sA = Math.min(1, (t.safe.bottom - t.safe.top - 40) / PH);
  const midA = (t.safe.top + t.safe.bottom) / 2;
  const regionTop = t.safe.top + 10;
  const regionBottom = chipTop - 34;
  const sB = (regionBottom - regionTop) / PH;
  const midB = (regionTop + regionBottom) / 2;

  const room = interpolate(frame, [makeRoomAt, makeRoomAt + 22], [0, 1], { ...clamp, easing: smooth });
  const s = mix(sA, sB, room);
  const phoneY = mix(midA, midB, room) + Math.sin(sec * ((2 * Math.PI) / 3.4)) * 4;

  // ---- Blue dot travel ----
  const move = interpolate(frame, [moveAt, moveEnd], [0, 1], { ...clamp, easing: smooth });
  // Keep the dot well inside the screen (u 0.2 -> ~0.73) so it is never cut by the screen edge.
  const u0 = 0.2;
  const u = u0 + 0.48 * move + 0.00015 * frame; // smooth glide on cue plus a slow constant creep
  const dotL = bez(u);
  const dotG = { x: cx + dotL.x * s, y: phoneY + dotL.y * s };
  const trail = Array.from({ length: 41 }, (_, i) => bez(mix(u0, u, i / 40)));
  const trailPts = trail.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const breath = Math.sin(sec * ((2 * Math.PI) / 2.2));
  const haloR = 62 + 5 * breath;
  const loopP = 1.6 * fps;
  const loopPhase = (frame % loopP) / loopP;

  // Final pulse on "find you".
  const pk = frame - pulseAt;
  const bump = interpolate(pk, [0, 7, 20], [1, 1.4, 1], { ...clamp, easing: Easing.inOut(Easing.quad) });
  const finalRings = [0, 9].map((d) => {
    const q = interpolate(pk - d, [0, 26], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
    return { q, on: pk - d >= 0 && q < 1 };
  });

  // ---- Satellites and arriving signal rings ----
  const sats = [
    { x: cx - 600, y: t.safe.top + 130, off: 0 },
    { x: cx + 600, y: t.safe.top + 110, off: 0.35 },
    { x: cx - 520, y: t.safe.top + 450, off: 0.7 },
    { x: cx + 520, y: t.safe.top + 430, off: 1.05 },
  ];
  const satInA = useAppear(signalAt - 10, 0.6);
  const satInB = useAppear(signalAt + 1, 0.6);
  const satInC = useAppear(signalAt + 12, 0.6);
  const satInD = useAppear(signalAt + 23, 0.6);
  const satIns = [satInA, satInB, satInC, satInD];
  const period = 1.4 * fps;

  // ---- Recap chips ----
  const chipFont = 38;
  const gap = 110;
  const chipDefs = [
    { text: "Satellites send time", w: 510, color: t.palette.primary, at: chip1At },
    { text: "Time = distance", w: 400, color: t.palette.secondary, at: chip2Cue + 8 },
    { text: "4 distances = you", w: 440, color: t.palette.accent, at: chip3Cue + 8 },
  ];
  const totalW = chipDefs.reduce((a, c) => a + c.w, 0) + gap * (chipDefs.length - 1);
  let xCursor = cx - totalW / 2;
  const chips = chipDefs.map((c) => {
    const left = xCursor;
    xCursor += c.w + gap;
    return { ...c, left, right: left + c.w };
  });
  const chipP = [useAppear(chips[0]?.at ?? chip1At, 0.6), useAppear(chips[1]?.at ?? chip2Cue, 0.6), useAppear(chips[2]?.at ?? chip3Cue, 0.6)];
  const arrowP = [
    interpolate(frame, [chip2Cue, chip2Cue + 10], [0, 1], { ...clamp, easing: smooth }),
    interpolate(frame, [chip3Cue, chip3Cue + 10], [0, 1], { ...clamp, easing: smooth }),
  ];
  // The chip being spoken glows a little brighter.
  const activeIdx = frame >= chip3Cue ? 2 : frame >= chip2Cue ? 1 : 0;
  const glowFinal = pk >= 0 ? interpolate(pk, [0, 8, 30], [0, 1, 0.4], clamp) : 0;

  const streetMinor = { stroke: MAP_STREET, strokeWidth: 11, strokeLinecap: "round" as const, fill: "none", opacity: 0.4 };

  return (
    <>
      <Background stars />
      <Canvas>
        <defs>
          <clipPath id="s07-screen">
            <rect x={SCREEN.x} y={SCREEN.y} width={SCREEN.w} height={SCREEN.h} rx={30} />
          </clipPath>
        </defs>

        {/* Satellites */}
        {sats.map((st, i) => {
          const p = satIns[i] ?? 0;
          if (p <= 0) return null;
          const bob = Math.sin(sec * ((2 * Math.PI) / 3.2) + i * 1.3);
          return (
            <Icon
              key={`sat${i}`}
              name="satellite"
              x={st.x}
              y={st.y + bob * 6}
              size={96}
              progress={p}
              color="primary"
              rotate={(st.x < cx ? -12 : 12) + bob * 3}
            />
          );
        })}

        {/* Phone with the map */}
        <g transform={`translate(${cx} ${phoneY}) scale(${s})`}>
          <rect x={-PW / 2} y={-PH / 2} width={PW} height={PH} rx={58} fill={t.palette.surface} stroke="#2C4775" strokeWidth={6} />
          <rect x={-45} y={-PH / 2 + 18} width={90} height={12} rx={6} fill={t.palette.background} />
          <rect x={-55} y={PH / 2 - 30} width={110} height={8} rx={4} fill="#3A5687" />
          <g clipPath="url(#s07-screen)">
            <rect x={SCREEN.x} y={SCREEN.y} width={SCREEN.w} height={SCREEN.h} fill={MAP_BASE} />
            <rect x={40} y={20} width={120} height={150} rx={18} fill={MAP_PARK} />
            <path d="M-200 -340 L-200 -120 Q-120 -150 -60 -240 Q-30 -300 -40 -340 Z" fill={MAP_WATER} />
            <line x1={-200} y1={-250} x2={200} y2={-250} {...streetMinor} />
            <line x1={-200} y1={60} x2={200} y2={60} {...streetMinor} />
            <line x1={-200} y1={200} x2={200} y2={200} {...streetMinor} />
            <line x1={-110} y1={-340} x2={-110} y2={340} {...streetMinor} />
            <line x1={120} y1={-340} x2={120} y2={340} {...streetMinor} />
            {/* main curving street */}
            <path d={STREET_D} fill="none" stroke={MAP_STREET} strokeWidth={30} strokeLinecap="round" opacity={0.75} />
            <path d={STREET_D} fill="none" stroke={MAP_BASE} strokeWidth={3} strokeDasharray="14 14" opacity={0.6} />
            {/* travelled trail */}
            <polyline points={trailPts} fill="none" stroke={DOT_BLUE} strokeWidth={12} strokeLinecap="round" strokeLinejoin="round" opacity={0.55} />

            {/* blue dot */}
            <g transform={`translate(${dotL.x} ${dotL.y}) scale(${bump})`}>
              <circle r={haloR} fill={DOT_BLUE} opacity={0.18} />
              <circle r={haloR} fill="none" stroke={DOT_BLUE} strokeWidth={3} opacity={0.45} />
              <circle r={mix(26, haloR + 10, loopPhase)} fill="none" stroke={DOT_BLUE} strokeWidth={5} opacity={0.6 * (1 - loopPhase)} />
              <circle r={24} fill={DOT_BLUE} stroke="#FFFFFF" strokeWidth={8} />
            </g>
          </g>
        </g>

        {/* Signal rings arriving at the dot, nonstop */}
        {sats.map((st, i) => {
          const start = signalAt + st.off * fps;
          if (frame < start) return null;
          const cyc = ((frame - start) % period) / period;
          if (cyc < 0.72) {
            const tr = cyc / 0.72;
            const e = Easing.in(Easing.quad)(tr);
            const x = mix(st.x, dotG.x, e);
            const y = mix(st.y + 30, dotG.y, e);
            const op = 0.7 * Math.min(1, tr * 5) * (1 - tr ** 6);
            return (
              <g key={`pk${i}`} opacity={op}>
                <circle cx={x} cy={y} r={mix(18, 10, tr)} fill="none" stroke={t.palette.primary} strokeWidth={4} />
                <circle cx={x} cy={y} r={mix(30, 18, tr)} fill="none" stroke={t.palette.primary} strokeWidth={2.5} opacity={0.5} />
              </g>
            );
          }
          const q = (cyc - 0.72) / 0.28;
          return (
            <circle
              key={`rp${i}`}
              cx={dotG.x}
              cy={dotG.y}
              r={mix(28, 80, q) * s}
              fill="none"
              stroke={t.palette.primary}
              strokeWidth={3}
              opacity={0.55 * (1 - q)}
            />
          );
        })}

        {/* Final pulse */}
        {finalRings.map((fr, i) =>
          fr.on ? (
            <circle
              key={`fr${i}`}
              cx={dotG.x}
              cy={dotG.y}
              r={mix(30, 230, fr.q)}
              fill="none"
              stroke={DOT_BLUE}
              strokeWidth={8 - i * 3}
              opacity={0.85 * (1 - fr.q)}
            />
          ) : null,
        )}

        {/* Recap arrows */}
        {arrowP.map((p, i) => {
          const a = chips[i];
          const b = chips[i + 1];
          if (!a || !b) return null;
          return <Arrow key={`ar${i}`} x1={a.right + 16} y1={chipY} x2={b.left - 16} y2={chipY} progress={p} width={6} color="text" />;
        })}
      </Canvas>

      {/* Recap chips */}
      {chips.map((c, i) => {
        const p = chipP[i] ?? 0;
        if (p <= 0) return null;
        const active = (i === activeIdx ? 1 : 0) + (i === 2 ? glowFinal : 0);
        const fill = Math.round(mix(0.16, 0.3, Math.min(1, active)) * 255)
          .toString(16)
          .padStart(2, "0");
        return (
          <div
            key={`chip${i}`}
            style={{
              position: "absolute",
              left: c.left,
              top: chipTop,
              width: c.w,
              height: chipH,
              boxSizing: "border-box",
              borderRadius: chipH / 2,
              border: `4px solid ${c.color}`,
              backgroundColor: `${c.color}${fill}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: t.fontFamily,
              fontSize: chipFont,
              fontWeight: 700,
              color: t.palette.text,
              whiteSpace: "nowrap",
              opacity: p,
              translate: `${(1 - p) * -60}px 0px`,
              scale: String(0.92 + 0.08 * p + (i === 2 ? 0.04 * glowFinal : 0)),
            }}
          >
            {c.text}
          </div>
        );
      })}
    </>
  );
}
