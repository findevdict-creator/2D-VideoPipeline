/**
 * s06 "Why Four Satellites"
 * The tilted s05 map (55% vertical scale, 10° skew) sits centre-right with satellites A, B, C and
 * their flat ellipse rings meeting at the true spot (faint dashed outline). A lower-left inset card
 * holds the phone and its cheap clock. The clock slips 1 µs, all rings grow and meet at a hollow
 * coral "ghost" point ~300 m away. A white 4th satellite slides in; its ring misses the ghost (coral
 * gap bracket). The clock is fixed, all four rings shrink onto the true spot and the blue dot pops in.
 *
 * Geometry is worked out in flat "map units" and projected onto the tilted map, so every ring meets
 * its neighbours exactly at one point at every frame (the meeting point slides along P → G).
 */
import React, { useMemo } from "react";
import { Easing, interpolate, interpolateColors, useCurrentFrame } from "remotion";
import { Background, Canvas, Icon, mix, useCues, useTheme } from "@pipeline/lib";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
const EASE_IN_OUT = Easing.inOut(Easing.cubic);
const BACK = Easing.out(Easing.back(1.7));
const BLUE = "#3D8BFF";

// Tilted map: 55% vertical scale with a 10° skew (as at the end of s05).
const SY = 0.55;
const SKEW = Math.tan((10 * Math.PI) / 180);
const U0 = 540; // map half-width in map units
const V0 = 560; // map half-depth in map units
const HOVER = 48; // satellite icons float this far above their map point
const RING_SAMPLES = 160;

type Pt = { x: number; y: number };
type MPt = { u: number; v: number };
type Bounds = { l: number; r: number; t: number; b: number };

const TRUE_M: MPt = { u: 0, v: 100 }; // true position
const GHOST_M: MPt = { u: 0, v: 300 }; // where the biased rings meet (~300 m off)
const SATS = [
  { id: "A", m: { u: -340, v: -320 }, color: "primary" },
  { id: "B", m: { u: 330, v: -330 }, color: "secondary" },
  { id: "C", m: { u: -120, v: -400 }, color: "accent" },
] as const;
const SAT4_M: MPt = { u: 520, v: -80 };
const SAT4_START_U = 820;

const dist = (a: MPt, b: MPt) => Math.hypot(a.u - b.u, a.v - b.v);
const lerpM = (a: MPt, b: MPt, p: number): MPt => ({ u: mix(a.u, b.u, p), v: mix(a.v, b.v, p) });

const rectDist = (p: Pt, c: Pt, hw: number, hh: number) =>
  Math.hypot(Math.max(Math.abs(p.x - c.x) - hw, 0), Math.max(Math.abs(p.y - c.y) - hh, 0));

/** Pick a label centre near `anchor` that keeps the box clear of every obstacle point. */
function placeLabel(anchor: Pt, w: number, h: number, obstacles: Pt[], bounds: Bounds, minGap: number): Pt {
  let best: Pt = { x: anchor.x, y: anchor.y + minGap + h / 2 };
  let bestScore = -Infinity;
  for (let dx = -400; dx <= 400; dx += 20) {
    for (let dy = -240; dy <= 240; dy += 15) {
      const c = { x: anchor.x + dx, y: anchor.y + dy };
      if (c.x - w / 2 < bounds.l || c.x + w / 2 > bounds.r || c.y - h / 2 < bounds.t || c.y + h / 2 > bounds.b) continue;
      const dA = rectDist(anchor, c, w / 2, h / 2);
      if (dA < minGap) continue;
      let clear = 40;
      for (const p of obstacles) {
        const d = rectDist(p, c, w / 2, h / 2);
        if (d < clear) {
          clear = d;
          if (clear <= 0) break;
        }
      }
      const score = clear * 12 - dA;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
  }
  return best;
}

export default function Scene() {
  const t = useTheme();
  const f = useCurrentFrame();

  // ---------- Cue timing ----------
  const qC = useCues("question");
  const clockC = useCues("clockInset");
  const ringC = useCues("rings");
  const ghostC = useCues("ghostDot");
  const s4C = useCues("sat4");
  const blueC = useCues("blueDot");
  const qAt = qC[0]?.startFrame ?? 21;
  const qEnd = qC[0]?.endFrame ?? 56;
  const wobAt = clockC[0]?.startFrame ?? 57;
  const wobEnd = clockC[0]?.endFrame ?? 116;
  const slipAt = clockC[1]?.startFrame ?? 129;
  const fixAt = clockC[2]?.startFrame ?? 393;
  const growAt = ringC[0]?.startFrame ?? 237;
  const pulseAt = ringC[1]?.startFrame ?? 297;
  const pulseEnd = ringC[1]?.endFrame ?? 356;
  const shrinkAt = ringC[2]?.startFrame ?? 465;
  const ghostAt = ghostC[0]?.startFrame ?? growAt;
  const sat4At = s4C[0]?.startFrame ?? 357;
  const blueAt = blueC[0]?.startFrame ?? shrinkAt;

  const { left: sl, right: sr, top: st, bottom: sb } = t.safe;

  // ---------- Layout (computed once) ----------
  const L = useMemo(() => {
    const mapTop = st + 180;
    const mapBottom = sb - 16;
    const ms = Math.min(1.12, (mapBottom - mapTop) / (2 * SY * V0));
    const halfW = (U0 + SKEW * SY * V0) * ms;
    const mx = sr - 12 - halfW;
    const my = (mapTop + mapBottom) / 2;
    const proj = (m: MPt): Pt => ({ x: mx + ms * (m.u + SKEW * SY * m.v), y: my + ms * SY * m.v });

    const card = { x: sl, w: 420, h: 290, y: sb - 290 };

    const r0 = SATS.map((s) => dist(s.m, TRUE_M));
    const rG = SATS.map((s) => dist(s.m, GHOST_M));
    const dBias = rG.reduce((a, r, i) => a + r - (r0[i] ?? r), 0) / SATS.length;
    const r4 = dist(SAT4_M, TRUE_M);
    const r4Biased = r4 + dBias;
    // Nearest point of the biased 4th ring to the ghost point (end of the gap bracket).
    const g4 = dist(SAT4_M, GHOST_M);
    const gapEnd: MPt = {
      u: SAT4_M.u + ((GHOST_M.u - SAT4_M.u) / g4) * r4Biased,
      v: SAT4_M.v + ((GHOST_M.v - SAT4_M.v) / g4) * r4Biased,
    };

    // Obstacle sampling for label placement.
    const ringPts = (c: MPt, R: number): Pt[] => {
      const out: Pt[] = [];
      for (let i = 0; i < 360; i++) {
        const a = (i / 360) * Math.PI * 2;
        const m = { u: c.u + R * Math.cos(a), v: c.v + R * Math.sin(a) };
        if (Math.abs(m.u) <= U0 && Math.abs(m.v) <= V0) out.push(proj(m));
      }
      return out;
    };
    const circlePts = (c: Pt, r: number): Pt[] =>
      Array.from({ length: 24 }, (_, i) => ({
        x: c.x + r * Math.cos((i / 24) * Math.PI * 2),
        y: c.y + r * Math.sin((i / 24) * Math.PI * 2),
      }));
    const segPts = (a: Pt, b: Pt): Pt[] => {
      const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8));
      return Array.from({ length: n + 1 }, (_, i) => ({ x: mix(a.x, b.x, i / n), y: mix(a.y, b.y, i / n) }));
    };
    const iconBox = (c: Pt): Pt[] => {
      const out: Pt[] = [];
      for (let x = -38; x <= 38; x += 10) for (let y = -30; y <= 16; y += 8) out.push({ x: c.x + x, y: c.y + y });
      return out;
    };

    const trueP = proj(TRUE_M);
    const ghostP = proj(GHOST_M);
    const satBase = SATS.map((s) => proj(s.m));
    const sat4Base = proj(SAT4_M);
    const iconPts = [...satBase, sat4Base].flatMap((b) => iconBox({ x: b.x, y: b.y - HOVER }));

    const baseRings = [...SATS.map((s, i) => ringPts(s.m, r0[i] ?? 0)), ringPts(SAT4_M, r4)].flat();
    const grownRings = [...SATS.map((s, i) => ringPts(s.m, rG[i] ?? 0)), ringPts(SAT4_M, r4Biased)].flat();

    const bounds: Bounds = { l: card.x + card.w + 24, r: sr, t: st + 120, b: sb };

    const offLabel = placeLabel(
      { x: (trueP.x + ghostP.x) / 2, y: (trueP.y + ghostP.y) / 2 },
      280,
      66,
      [
        ...grownRings,
        ...segPts(trueP, ghostP),
        ...segPts(ghostP, proj(gapEnd)),
        ...circlePts(trueP, 22),
        ...circlePts(ghostP, 24),
        ...iconPts,
      ],
      bounds,
      10,
    );
    const fixedLabel = placeLabel(trueP, 330, 72, [...baseRings, ...circlePts(trueP, 40), ...iconPts], bounds, 34);

    // Letters A, B, C next to their satellite icons, on the side with the most room.
    const allRings = [...baseRings, ...grownRings];
    const letterOffsets: Pt[] = [
      { x: 64, y: -6 },
      { x: -64, y: -6 },
      { x: 52, y: -50 },
      { x: -52, y: -50 },
      { x: 0, y: -74 },
    ];
    const letters = satBase.map((b, i) => {
      const icon = { x: b.x, y: b.y - HOVER };
      const others = [...satBase, sat4Base]
        .filter((_, j) => j !== i)
        .flatMap((o) => iconBox({ x: o.x, y: o.y - HOVER }));
      const obstacles = [...allRings, ...others];
      let best = { x: icon.x + 64, y: icon.y - 6 };
      let bestScore = -Infinity;
      letterOffsets.forEach((o, k) => {
        const c = { x: icon.x + o.x, y: icon.y + o.y };
        let clear = 30;
        for (const p of obstacles) clear = Math.min(clear, rectDist(p, c, 18, 24));
        const score = clear * 10 - k;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      });
      return best;
    });

    const corners = [
      proj({ u: -U0, v: -V0 }),
      proj({ u: U0, v: -V0 }),
      proj({ u: U0, v: V0 }),
      proj({ u: -U0, v: V0 }),
    ];

    return { proj, ms, card, r0, r4, dBias, gapEnd, trueP, ghostP, satBase, offLabel, fixedLabel, letters, corners };
  }, [sl, sr, st, sb]);

  const { proj, card } = L;

  const ellipseD = (c: MPt, R: number) => {
    if (R <= 0.5) return "";
    let d = "";
    for (let i = 0; i <= RING_SAMPLES; i++) {
      const a = (i / RING_SAMPLES) * Math.PI * 2;
      const p = proj({ u: c.u + R * Math.cos(a), v: c.v + R * Math.sin(a) });
      d += `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    }
    return `${d}Z`;
  };

  // ---------- Intro: s05's blue dot gives way to the dashed "true spot" ----------
  const oldDot = interpolate(f, [4, 22], [1, 0], { ...clamp, easing: EASE_IN_OUT });
  const trueIn = interpolate(f, [10, 30], [0, 1], clamp);

  // ---------- Rings: grow (clock error), pulse (shared error), shrink (fixed) ----------
  const grow = interpolate(f, [growAt, growAt + 32], [0, 1], { ...clamp, easing: EASE_IN_OUT });
  const shrink = interpolate(f, [shrinkAt, shrinkAt + 24], [0, 1], { ...clamp, easing: EASE_IN_OUT });
  const meet = lerpM(TRUE_M, GHOST_M, grow * (1 - shrink)); // the shared meeting point
  const pulse =
    f >= pulseAt && f <= pulseEnd ? Math.sin((Math.PI * (f - pulseAt)) / ((pulseEnd - pulseAt) / 2)) ** 2 : 0;
  const ringW = 3 + 3.5 * pulse;
  const glowW = 12 + 10 * pulse;
  const glowOp = 0.1 + 0.3 * pulse;

  // ---------- Ghost dot, dashed line and label ----------
  const ghostFade = 1 - interpolate(f, [shrinkAt, shrinkAt + 14], [0, 1], clamp);
  const ghostIn = interpolate(f, [ghostAt, ghostAt + 8], [0, 1], clamp) * ghostFade;
  const ghostPos = proj(lerpM(TRUE_M, GHOST_M, grow));
  const lineDraw = interpolate(f, [ghostAt + 28, ghostAt + 44], [0, 1], { ...clamp, easing: EASE_OUT });
  const offLabelIn = interpolate(f, [ghostAt + 36, ghostAt + 50], [0, 1], { ...clamp, easing: EASE_OUT }) * ghostFade;

  // ---------- 4th satellite ----------
  const slide = interpolate(f, [sat4At, sat4At + 20], [0, 1], { ...clamp, easing: EASE_OUT });
  const sat4M: MPt = { u: mix(SAT4_START_U, SAT4_M.u, slide), v: SAT4_M.v };
  const sat4In = interpolate(f, [sat4At, sat4At + 8], [0, 1], clamp);
  const ring4Out = interpolate(f, [sat4At + 12, sat4At + 32], [0, 1], { ...clamp, easing: EASE_OUT });
  const R4 = ring4Out * (L.r4 + L.dBias * (1 - shrink));
  const bracketIn = interpolate(f, [sat4At + 28, sat4At + 36], [0, 1], clamp);
  const blinkStart = sat4At + 28;
  const blink =
    f < blinkStart + 30 ? 0.3 + 0.7 * (0.5 + 0.5 * Math.cos(((f - blinkStart) * 2 * Math.PI) / 10)) : 1;
  const bracketOp = bracketIn * blink * ghostFade;

  // ---------- Blue dot ----------
  const popAt = Math.max(blueAt, shrinkAt) + 20;
  const pop = interpolate(f, [popAt, popAt + 12], [0, 1], { ...clamp, easing: BACK });
  const popRing = interpolate(f, [popAt, popAt + 24], [0, 1], { ...clamp, easing: EASE_OUT });
  const fixedLabelIn = interpolate(f, [popAt + 8, popAt + 20], [0, 1], { ...clamp, easing: EASE_OUT });

  // ---------- Clock inset ----------
  const cardIn = interpolate(f, [36, 54], [0, 1], { ...clamp, easing: EASE_OUT });
  const cardFloat = 3 * Math.sin(f / 24);
  const cardDy = cardFloat + (1 - cardIn) * 40;
  const wobEnv = Math.sin(Math.PI * interpolate(f, [wobAt, wobEnd], [0, 1], clamp));
  const dialRot = wobEnv * 5 * Math.sin((f - wobAt) * 0.55);
  const jitter = wobEnv * (6 * Math.sin(f * 1.9) + 3 * Math.sin(f * 3.7 + 1));
  const slipP = interpolate(f, [slipAt, slipAt + 14], [0, 1], { ...clamp, easing: BACK });
  const fixP = interpolate(f, [fixAt + 8, fixAt + 18, fixAt + 26, fixAt + 38], [1, 0.45, 0.45, 0], {
    ...clamp,
    easing: EASE_IN_OUT,
  });
  const offset = 16 * slipP * fixP;
  const handA = jitter + offset;
  const wedgeOp =
    interpolate(f, [slipAt, slipAt + 10], [0, 1], clamp) * (1 - interpolate(f, [fixAt + 20, fixAt + 40], [0, 1], clamp));
  const usLabelIn =
    interpolate(f, [slipAt + 18, slipAt + 32], [0, 1], { ...clamp, easing: EASE_OUT }) *
    (1 - interpolate(f, [fixAt + 30, fixAt + 48], [0, 1], clamp));
  const fixedOk = interpolate(f, [fixAt + 36, fixAt + 50], [0, 1], clamp);
  const rimColor = interpolateColors(fixedOk, [0, 1], [t.palette.text, t.palette.primary]);
  const handColor = interpolateColors(wedgeOp, [0, 1], [t.palette.text, t.palette.secondary]);

  const dial = { x: card.x + 292, y: card.y + 122, r: 78 };
  const onDial = (deg: number, r: number): Pt => ({
    x: dial.x + r * Math.sin((deg * Math.PI) / 180),
    y: dial.y - r * Math.cos((deg * Math.PI) / 180),
  });
  const phone = { x: card.x + 105, y: card.y + 138, size: 175 };
  const ps = phone.size / 100;

  // ---------- Title (typed in) ----------
  const TITLE = "Why 4 satellites?";
  const typeSpan = Math.max(1, qEnd - 6 - qAt);
  const charAt = (i: number) => qAt + (i * typeSpan) / TITLE.length;
  const typedCount = TITLE.split("").filter((_, i) => f >= charAt(i)).length;
  const caretOp =
    f < qAt - 4 || f > qEnd + 30 ? 0 : f <= qEnd ? 1 : 0.5 + 0.5 * Math.cos(((f - qEnd) * 2 * Math.PI) / 16);
  const caretFade = interpolate(f, [qEnd + 22, qEnd + 30], [1, 0], clamp);

  const satBob = (i: number) => 3 * Math.sin(f / 20 + i * 1.7);
  const mapPts = L.corners.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");

  const sat4P = proj(sat4M);
  const ghostP = L.ghostP;
  const gapEndP = proj(L.gapEnd);
  const bu = { x: gapEndP.x - ghostP.x, y: gapEndP.y - ghostP.y };
  const bLen = Math.hypot(bu.x, bu.y) || 1;
  const bDir = { x: bu.x / bLen, y: bu.y / bLen };
  const bN = { x: -bDir.y, y: bDir.x };
  const bA = { x: ghostP.x + bDir.x * 20, y: ghostP.y + bDir.y * 20 };
  const bB = { x: gapEndP.x - bDir.x * 6, y: gapEndP.y - bDir.y * 6 };

  const streets: [MPt, MPt][] = [
    [{ u: -300, v: -V0 }, { u: -300, v: V0 }],
    [{ u: 90, v: -V0 }, { u: 90, v: V0 }],
    [{ u: 390, v: -V0 }, { u: 390, v: V0 }],
    [{ u: -U0, v: -190 }, { u: U0, v: -190 }],
    [{ u: -U0, v: 230 }, { u: U0, v: 230 }],
    [{ u: -U0, v: 470 }, { u: 260, v: -V0 }],
  ];

  return (
    <>
      <Background stars />

      {/* Title, typed in with a stable layout (hidden characters keep their space) */}
      <div
        style={{
          position: "absolute",
          left: sl,
          right: t.width - sr,
          top: st + 4,
          textAlign: "center",
          fontFamily: t.fontFamily,
          fontSize: 80,
          fontWeight: 800,
          lineHeight: 1.15,
          color: t.palette.text,
          whiteSpace: "pre",
        }}
      >
        {TITLE.split("").map((ch, i) => {
          const p = interpolate(f, [charAt(i), charAt(i) + 3], [0, 1], clamp);
          return (
            <React.Fragment key={i}>
              {i === typedCount ? (
                <span style={{ position: "relative", display: "inline-block", width: 0 }}>
                  <span
                    style={{
                      position: "absolute",
                      left: 2,
                      top: -64,
                      width: 6,
                      height: 76,
                      borderRadius: 3,
                      backgroundColor: t.palette.accent,
                      opacity: caretOp * caretFade,
                    }}
                  />
                </span>
              ) : null}
              <span style={{ opacity: p, color: ch === "4" ? t.palette.accent : undefined }}>{ch}</span>
            </React.Fragment>
          );
        })}
        {typedCount >= TITLE.length ? (
          <span style={{ position: "relative", display: "inline-block", width: 0 }}>
            <span
              style={{
                position: "absolute",
                left: 4,
                top: -64,
                width: 6,
                height: 76,
                borderRadius: 3,
                backgroundColor: t.palette.accent,
                opacity: caretOp * caretFade,
              }}
            />
          </span>
        ) : null}
      </div>

      <Canvas>
        <defs>
          <clipPath id="s06-map-clip">
            <polygon points={mapPts} />
          </clipPath>
        </defs>

        {/* Tilted map */}
        <polygon points={mapPts} fill={t.palette.surface} stroke={t.palette.text} strokeOpacity={0.16} strokeWidth={2} />
        <g clipPath="url(#s06-map-clip)">
          {streets.map(([a, b], i) => {
            const pa = proj(a);
            const pb = proj(b);
            return (
              <line
                key={`st${i}`}
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                stroke={t.palette.text}
                strokeOpacity={0.07}
                strokeWidth={10}
                strokeLinecap="round"
              />
            );
          })}

          {/* Rings A, B, C: radii always meet exactly at the shared point */}
          {SATS.map((s) => {
            const d = ellipseD(s.m, dist(s.m, meet));
            const c = t.color(s.color);
            return (
              <g key={`ring${s.id}`}>
                <path d={d} fill="none" stroke={c} strokeWidth={glowW} opacity={glowOp} />
                <path d={d} fill="none" stroke={c} strokeWidth={ringW} strokeLinejoin="round" />
              </g>
            );
          })}

          {/* 4th satellite's ring */}
          {R4 > 1 ? (
            <g opacity={sat4In}>
              <path d={ellipseD(sat4M, R4)} fill="none" stroke={t.palette.text} strokeWidth={12} opacity={0.1} />
              <path d={ellipseD(sat4M, R4)} fill="none" stroke={t.palette.text} strokeWidth={3} />
            </g>
          ) : null}
        </g>

        {/* Satellite ground marks and tethers */}
        {SATS.map((s, i) => {
          const b = L.satBase[i];
          if (!b) return null;
          const c = t.color(s.color);
          return (
            <g key={`base${s.id}`}>
              <ellipse cx={b.x} cy={b.y} rx={13 * L.ms} ry={13 * L.ms * SY} fill={c} opacity={0.7} />
              <line
                x1={b.x}
                y1={b.y}
                x2={b.x}
                y2={b.y - HOVER + 14 + satBob(i)}
                stroke={c}
                strokeWidth={3}
                strokeDasharray="4 6"
                strokeLinecap="round"
                opacity={0.6}
              />
            </g>
          );
        })}
        <g opacity={sat4In * interpolate(f, [sat4At + 14, sat4At + 24], [0, 1], clamp)}>
          <ellipse cx={sat4P.x} cy={sat4P.y} rx={13 * L.ms} ry={13 * L.ms * SY} fill={t.palette.text} opacity={0.7} />
          <line
            x1={sat4P.x}
            y1={sat4P.y}
            x2={sat4P.x}
            y2={sat4P.y - HOVER + 14 + satBob(3)}
            stroke={t.palette.text}
            strokeWidth={3}
            strokeDasharray="4 6"
            strokeLinecap="round"
            opacity={0.6}
          />
        </g>

        {/* True spot: s05's blue dot fades into a faint dashed outline */}
        <circle
          cx={L.trueP.x}
          cy={L.trueP.y}
          r={18}
          fill="none"
          stroke={t.palette.text}
          strokeWidth={3}
          strokeDasharray="6 6"
          strokeDashoffset={-f * 0.5}
          opacity={0.6 * trueIn * (1 - pop * 0.6)}
        />
        {oldDot > 0.01 ? (
          <g opacity={oldDot}>
            <circle cx={L.trueP.x} cy={L.trueP.y} r={32 * oldDot} fill={BLUE} opacity={0.25} />
            <circle cx={L.trueP.x} cy={L.trueP.y} r={15 * (0.6 + 0.4 * oldDot)} fill={BLUE} stroke="white" strokeWidth={4} />
          </g>
        ) : null}

        {/* Dashed coral line from the true spot to the ghost point */}
        {lineDraw > 0 ? (
          <g opacity={ghostFade}>
            <line
              x1={L.trueP.x}
              y1={L.trueP.y}
              x2={mix(L.trueP.x, ghostP.x, lineDraw)}
              y2={mix(L.trueP.y, ghostP.y, lineDraw)}
              stroke={t.palette.secondary}
              strokeWidth={3.5}
              strokeDasharray="10 9"
              strokeLinecap="round"
            />
          </g>
        ) : null}

        {/* Ghost dot */}
        {ghostIn > 0.01 ? (
          <g opacity={ghostIn}>
            <circle cx={ghostPos.x} cy={ghostPos.y} r={22 + 10 * pulse} fill={t.palette.secondary} opacity={0.12 + 0.18 * pulse} />
            <circle
              cx={ghostPos.x}
              cy={ghostPos.y}
              r={13 * (0.6 + 0.4 * ghostIn)}
              fill={t.palette.background}
              stroke={t.palette.secondary}
              strokeWidth={4}
            />
          </g>
        ) : null}

        {/* Coral gap bracket between the ghost dot and the 4th ring */}
        {bracketOp > 0.01 ? (
          <path
            d={`M${bA.x + bN.x * 11} ${bA.y + bN.y * 11} L${bA.x - bN.x * 11} ${bA.y - bN.y * 11} M${bA.x} ${bA.y} L${bB.x} ${bB.y} M${
              bB.x + bN.x * 11
            } ${bB.y + bN.y * 11} L${bB.x - bN.x * 11} ${bB.y - bN.y * 11}`}
            fill="none"
            stroke={t.palette.secondary}
            strokeWidth={4.5}
            strokeLinecap="round"
            opacity={bracketOp}
          />
        ) : null}

        {/* Satellites */}
        {SATS.map((s, i) => {
          const b = L.satBase[i];
          if (!b) return null;
          return <Icon key={`sat${s.id}`} name="satellite" x={b.x} y={b.y - HOVER + satBob(i)} size={78} color={s.color} />;
        })}
        {sat4In > 0 ? (
          <Icon name="satellite" x={sat4P.x} y={sat4P.y - HOVER + satBob(3)} size={78} color="text" progress={sat4In} />
        ) : null}

        {/* Blue dot pops in on the true spot */}
        {pop > 0 ? (
          <g>
            {popRing < 1 ? (
              <circle
                cx={L.trueP.x}
                cy={L.trueP.y}
                r={mix(16, 80, popRing)}
                fill="none"
                stroke={BLUE}
                strokeWidth={4}
                opacity={1 - popRing}
              />
            ) : null}
            <circle cx={L.trueP.x} cy={L.trueP.y} r={(32 + 3 * Math.sin(f / 7)) * pop} fill={BLUE} opacity={0.25} />
            <circle cx={L.trueP.x} cy={L.trueP.y} r={15 * pop} fill={BLUE} stroke="white" strokeWidth={4} />
          </g>
        ) : null}

        {/* Clock inset card */}
        <g opacity={cardIn} transform={`translate(0 ${cardDy})`}>
          <rect
            x={card.x}
            y={card.y}
            width={card.w}
            height={card.h}
            rx={28}
            fill={t.palette.surface}
            stroke={t.palette.text}
            strokeOpacity={0.14}
            strokeWidth={2}
          />
          {/* Phone with a tiny map screen */}
          <Icon name="phone" x={phone.x} y={phone.y} size={phone.size} color="text" />
          <g>
            <path
              d={`M${phone.x - 16 * ps} ${phone.y - 10 * ps} L${phone.x + 16 * ps} ${phone.y + 6 * ps} M${phone.x - 4 * ps} ${
                phone.y - 32 * ps
              } L${phone.x + 4 * ps} ${phone.y + 28 * ps}`}
              stroke={t.palette.text}
              strokeOpacity={0.22}
              strokeWidth={4}
              fill="none"
            />
            <circle cx={phone.x - 1 * ps} cy={phone.y - 3 * ps} r={6} fill={BLUE} stroke="white" strokeWidth={2} />
          </g>

          {/* Cheap clock dial */}
          <g transform={`rotate(${dialRot} ${dial.x} ${dial.y})`}>
            <circle cx={dial.x} cy={dial.y} r={dial.r + 8} fill={t.palette.primary} opacity={0.18 * fixedOk} />
            <circle cx={dial.x} cy={dial.y} r={dial.r} fill={t.palette.background} stroke={rimColor} strokeWidth={5} />
            {Array.from({ length: 12 }, (_, i) => {
              const a = i * 30;
              const p1 = onDial(a, dial.r - (i === 0 ? 20 : 12));
              const p2 = onDial(a, dial.r - 5);
              return (
                <line
                  key={`tk${i}`}
                  x1={p1.x}
                  y1={p1.y}
                  x2={p2.x}
                  y2={p2.y}
                  stroke={t.palette.text}
                  strokeWidth={i % 3 === 0 ? 5 : 3}
                  strokeLinecap="round"
                  opacity={i % 3 === 0 ? 0.9 : 0.5}
                />
              );
            })}
            {/* Coral offset wedge between the true 12 o'clock and the slipped hand */}
            {offset > 0.3 && wedgeOp > 0.01 ? (
              <path
                d={`M${dial.x} ${dial.y} L${onDial(0, 66).x} ${onDial(0, 66).y} A66 66 0 0 1 ${onDial(offset, 66).x} ${
                  onDial(offset, 66).y
                } Z`}
                fill={t.palette.secondary}
                fillOpacity={0.45 + 0.3 * pulse}
                stroke={t.palette.secondary}
                strokeWidth={2}
                strokeLinejoin="round"
                opacity={wedgeOp}
              />
            ) : null}
            <line
              x1={dial.x}
              y1={dial.y}
              x2={onDial(120, 36).x}
              y2={onDial(120, 36).y}
              stroke={t.palette.text}
              strokeWidth={7}
              strokeLinecap="round"
            />
            <line
              x1={dial.x}
              y1={dial.y}
              x2={onDial(handA, 62).x}
              y2={onDial(handA, 62).y}
              stroke={handColor}
              strokeWidth={5}
              strokeLinecap="round"
            />
            <circle cx={dial.x} cy={dial.y} r={7} fill={t.palette.text} />
          </g>
        </g>
      </Canvas>

      {/* "1 µs off" under the dial */}
      <div
        style={{
          position: "absolute",
          left: dial.x,
          top: card.y + 246 + cardDy,
          transform: "translate(-50%, -50%)",
          fontFamily: t.fontFamily,
          fontSize: 38,
          fontWeight: 700,
          color: t.palette.secondary,
          whiteSpace: "nowrap",
          opacity: usLabelIn * cardIn,
          translate: `0px ${(1 - usLabelIn) * 12}px`,
        }}
      >
        1 µs off
      </div>

      {/* Satellite letters */}
      {SATS.map((s, i) => {
        const p = L.letters[i];
        if (!p) return null;
        return (
          <div
            key={`lt${s.id}`}
            style={{
              position: "absolute",
              left: p.x,
              top: p.y + satBob(i),
              transform: "translate(-50%, -50%)",
              fontFamily: t.fontFamily,
              fontSize: 40,
              fontWeight: 800,
              color: t.color(s.color),
            }}
          >
            {s.id}
          </div>
        );
      })}

      {/* "~300 m off" */}
      <div
        style={{
          position: "absolute",
          left: L.offLabel.x,
          top: L.offLabel.y,
          transform: "translate(-50%, -50%)",
          fontFamily: t.fontFamily,
          fontSize: 40,
          fontWeight: 700,
          color: t.palette.secondary,
          whiteSpace: "nowrap",
          padding: "4px 20px",
          borderRadius: 16,
          backgroundColor: `${t.palette.background}E6`,
          border: `3px solid ${t.palette.secondary}`,
          opacity: offLabelIn,
          scale: String(0.85 + 0.15 * offLabelIn),
        }}
      >
        ~300 m off
      </div>

      {/* "Clock fixed" */}
      <div
        style={{
          position: "absolute",
          left: L.fixedLabel.x,
          top: L.fixedLabel.y,
          transform: "translate(-50%, -50%)",
          fontFamily: t.fontFamily,
          fontSize: 44,
          fontWeight: 700,
          color: t.palette.text,
          whiteSpace: "nowrap",
          padding: "4px 22px",
          borderRadius: 18,
          backgroundColor: `${t.palette.background}E6`,
          border: `3px solid ${BLUE}`,
          opacity: fixedLabelIn,
          scale: String(0.85 + 0.15 * fixedLabelIn),
        }}
      >
        Clock fixed
      </div>
    </>
  );
}
