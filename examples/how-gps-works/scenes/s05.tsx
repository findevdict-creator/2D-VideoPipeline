/**
 * s05 "Circles That Cross": trilateration on a flat map, then the map tilts and
 * each circle becomes the equator of a sphere.
 */
import React from "react";
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Canvas, Icon, Label, mix, useAppear, useCueFrame, useTheme } from "@pipeline/lib";

const BLUE = "#3D8BFF";
const TILT_K = 0.55; // vertical scale of the tilted map
const SKEW_DEG = 10; // horizontal skew of the tilted map

// Layout in map-local units (origin = map centre). Circles A and B cross at P and Q;
// circle C passes through P only.
const P = { x: 30, y: 40 };
const Q = { x: 30, y: -220 };
const SATS = [
  { id: "A", x: -200, y: -90, color: "primary" },
  { id: "B", x: 280, y: -90, color: "secondary" },
  { id: "C", x: 30, y: 210, color: "accent" },
].map((s) => ({ ...s, r: Math.hypot(s.x - P.x, s.y - P.y) }));

// Faint street grid (local units).
const H_STREETS = [-330, -190, -20, 120, 300];
const V_STREETS = [-700, -520, -360, -90, 150, 430, 620];

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export default function Scene() {
  const t = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ---- Cue frames ----
  const aAt = useCueFrame("circleA", 0);
  const bAt = useCueFrame("circleB");
  const cAt = useCueFrame("circleC");
  const dotAt = useCueFrame("blueDot", 0);
  const chipAt = useCueFrame("dimLabel", 0);
  const tiltAt = useCueFrame("map");
  const sphereAt = useCueFrame("circleA", 1);
  const swapAt = useCueFrame("dimLabel", 1);
  const pulseAt = useCueFrame("blueDot", 1);

  // ---- Map geometry on the pixel grid ----
  const mapW = t.safe.right - t.safe.left;
  const mapH = t.safe.bottom - t.safe.top;
  const mx = t.width / 2;
  const my0 = (t.safe.top + t.safe.bottom) / 2;
  // Scale the layout down if the safe area is shorter than the design (extremes ≈ ±385).
  const u = Math.min(1, (mapH / 2 - 20) / 385);

  // ---- Tilt ----
  const tilt = interpolate(frame, [tiltAt, tiltAt + 36], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const k = mix(1, TILT_K, tilt);
  const skew = SKEW_DEG * tilt;
  const my = my0 + 18 * tilt; // centre the spheres vertically once tilted
  const tanS = Math.tan((skew * Math.PI) / 180);
  const tp = (x: number, y: number) => ({ x: mx + u * (x + tanS * k * y), y: my + u * k * y });
  const mapTransform = `translate(${mx} ${my}) scale(${u}) skewX(${skew}) scale(1 ${k})`;
  // Narrow the map plane as it skews so its slanted corners stay inside the safe area.
  const halfW = (mapW / 2 - Math.abs(tanS) * k * (mapH / 2) * 1.15) / u;
  const halfH = mapH / 2 / u;

  // ---- Entrances ----
  const satIn = [useAppear(0, 0.5), useAppear(5, 0.5), useAppear(10, 0.5)];
  const grow = [useAppear(aAt, 1.6), useAppear(bAt, 1.5), useAppear(cAt, 1.4)];
  const bDone = bAt + Math.round(1.3 * fps);
  const crossIn = useAppear(bDone, 0.35);
  const qOut = useAppear(cAt + Math.round(1.2 * fps), 0.7);
  const sphereIn = [
    useAppear(sphereAt, 0.7),
    useAppear(sphereAt + 8, 0.7),
    useAppear(sphereAt + 16, 0.7),
  ];
  const chipIn = useAppear(chipAt, 0.5);
  const swap = useAppear(swapAt + Math.round(0.8 * fps), 0.6);
  const youIn = useAppear(dotAt + 6, 0.5);
  const dotPop = spring({ frame: frame - dotAt, fps, config: { damping: 9, stiffness: 160 } });

  // Waves that keep rippling out from each satellite once its circle is drawn (gone by the tilt).
  const waveFade = interpolate(frame, [tiltAt, tiltAt + 20], [1, 0], clamp);
  const wavePeriod = 2.6 * fps;

  // Intersection dots blink while the narrator says "two points".
  const blink = frame >= bDone && frame < cAt + 10 ? ((frame - bDone) % 18) / 18 : -1;

  // Blue dot pulses: one on arrival, then gentle ones during the final cue (pulseAt).
  const arrivalRing = interpolate(frame, [dotAt, dotAt + 24], [0, 1], clamp);
  const finalLoop = frame >= pulseAt ? ((frame - pulseAt) % 30) / 30 : -1;
  const breathe = frame >= pulseAt ? 1 + 0.12 * Math.sin(((frame - pulseAt) / 30) * Math.PI * 2) ** 2 : 1;

  // P gets a tiny bump when circle C reaches it.
  const cHit = cAt + Math.round(1.4 * fps);
  const pBump = 1 + 0.4 * interpolate(frame, [cHit - 6, cHit, cHit + 10], [0, 1, 0], clamp);

  const pS = tp(P.x, P.y);
  const qS = tp(Q.x, Q.y);
  const font = t.fontFamily;

  return (
    <>
      <Canvas>
        {/* ---------------- The map plane (tilts as a whole) ---------------- */}
        <g transform={mapTransform}>
          <rect x={-halfW} y={-halfH} width={2 * halfW} height={2 * halfH} rx={36} fill={t.palette.surface} opacity={0.72} />
          {/* River and a park, flat fills */}
          <path
            d={`M ${-halfW} 210 C -560 150, -420 330, -250 300 S 40 360, 180 380 S 560 330, ${halfW} 360`}
            fill="none"
            stroke={t.palette.background}
            strokeOpacity={0.55}
            strokeWidth={30}
            strokeLinecap="round"
          />
          <rect x={470} y={160} width={220} height={140} rx={18} fill={t.palette.primary} opacity={0.08} />
          <rect x={-680} y={-300} width={140} height={90} rx={14} fill={t.palette.primary} opacity={0.07} />
          {H_STREETS.map((y) => (
            <line key={`h${y}`} x1={-halfW + 20 / u} x2={halfW - 20 / u} y1={y} y2={y} stroke={t.palette.text} strokeOpacity={0.08} strokeWidth={10} />
          ))}
          {V_STREETS.map((x) => (
            <line key={`v${x}`} x1={x} x2={x} y1={(-mapH / 2 + 20) / u} y2={(mapH / 2 - 20) / u} stroke={t.palette.text} strokeOpacity={0.08} strokeWidth={10} />
          ))}
          <line x1={-760} y1={360} x2={-120} y2={-380} stroke={t.palette.text} strokeOpacity={0.06} strokeWidth={14} />
          <line x1={360} y1={-380} x2={780} y2={140} stroke={t.palette.text} strokeOpacity={0.06} strokeWidth={14} />

          {/* Ripples from each satellite */}
          {SATS.map((s, i) => {
            const start = ([aAt, bAt, cAt][i] ?? 0) + Math.round(1.6 * fps);
            if (frame < start || waveFade <= 0) return null;
            const ph = (((frame - start) / wavePeriod + i * 0.33) % 1 + 1) % 1;
            return (
              <circle
                key={`w${s.id}`}
                cx={s.x}
                cy={s.y}
                r={s.r * ph}
                fill="none"
                stroke={t.color(s.color)}
                strokeWidth={3}
                vectorEffect="non-scaling-stroke"
                opacity={0.22 * (1 - ph) * waveFade}
              />
            );
          })}

          {/* Distance circles (they become the spheres' equators when tilted) */}
          {SATS.map((s, i) => {
            const g = grow[i] ?? 0;
            return (
            <g key={`c${s.id}`} opacity={g > 0 ? 1 : 0}>
              <circle cx={s.x} cy={s.y} r={s.r * g} fill={t.color(s.color)} opacity={0.06 * (1 - tilt)} />
              <circle
                cx={s.x}
                cy={s.y}
                r={s.r * g}
                fill="none"
                stroke={t.color(s.color)}
                strokeWidth={mix(6, 3.5, tilt)}
                vectorEffect="non-scaling-stroke"
              />
            </g>
            );
          })}
        </g>

        {/* ---------------- Upright sphere silhouettes ---------------- */}
        {SATS.map((s, i) => {
          const p = sphereIn[i] ?? 0;
          if (p <= 0) return null;
          const c = tp(s.x, s.y);
          return (
            <ellipse
              key={`s${s.id}`}
              cx={c.x}
              cy={c.y}
              rx={u * s.r}
              ry={u * s.r * mix(TILT_K, 1, p)}
              fill={t.color(s.color)}
              fillOpacity={0.2 * p}
              stroke={t.color(s.color)}
              strokeWidth={2}
              strokeOpacity={p}
            />
          );
        })}

        {/* ---------------- Satellite markers (stay upright) ---------------- */}
        {SATS.map((s, i) => {
          const c = tp(s.x, s.y);
          const bob = Math.sin((frame + i * 25) / 22) * 4;
          const bx = c.x + 46;
          const by = c.y - 36 + bob;
          return (
            <g key={`m${s.id}`} opacity={satIn[i] ?? 0}>
              <circle cx={c.x} cy={c.y} r={6} fill={t.color(s.color)} />
              <Icon name="satellite" x={c.x} y={c.y + bob} size={70} color={s.color} progress={satIn[i] ?? 0} rotate={Math.sin((frame + i * 40) / 30) * 5} />
              <circle cx={bx} cy={by} r={28} fill={t.palette.background} stroke={t.color(s.color)} strokeWidth={3} />
              <text x={bx} y={by + 1} fill={t.color(s.color)} fontFamily={font} fontSize={36} fontWeight={800} textAnchor="middle" dominantBaseline="central">
                {s.id}
              </text>
            </g>
          );
        })}

        {/* ---------------- Intersection dots ---------------- */}
        {crossIn > 0 ? (
          <>
            {blink >= 0
              ? [pS, ...(qOut < 1 ? [qS] : [])].map((pt, i) => (
                  <circle key={`b${i}`} cx={pt.x} cy={pt.y} r={12 + 26 * blink} fill="none" stroke={t.palette.text} strokeWidth={3} opacity={(1 - blink) * 0.8 * (i === 1 ? 1 - qOut : 1)} />
                ))
              : null}
            <circle cx={qS.x} cy={qS.y} r={12 * crossIn * (1 - 0.6 * qOut)} fill={t.palette.text} stroke={t.palette.background} strokeWidth={3} opacity={1 - qOut} />
            <circle
              cx={pS.x}
              cy={pS.y}
              r={12 * crossIn * pBump}
              fill={t.palette.text}
              stroke={t.palette.background}
              strokeWidth={3}
              opacity={interpolate(frame, [dotAt, dotAt + 8], [1, 0], clamp)}
            />
          </>
        ) : null}

        {/* ---------------- Blue location dot ---------------- */}
        {frame >= dotAt ? (
          <g>
            <circle cx={pS.x} cy={pS.y} r={20 + 90 * arrivalRing} fill="none" stroke={BLUE} strokeWidth={4} opacity={1 - arrivalRing} />
            {finalLoop >= 0 ? (
              <circle cx={pS.x} cy={pS.y} r={22 + 50 * finalLoop} fill="none" stroke={BLUE} strokeWidth={3} opacity={0.7 * (1 - finalLoop)} />
            ) : null}
            <circle cx={pS.x} cy={pS.y} r={36 * Math.max(0, dotPop) * breathe} fill={BLUE} opacity={0.25} />
            <circle cx={pS.x} cy={pS.y} r={18 * Math.max(0, dotPop) * breathe} fill={BLUE} stroke={t.palette.text} strokeWidth={4} />
          </g>
        ) : null}
      </Canvas>

      {/* "You" sits up-left of the dot, in the gap between the three circles. */}
      <Label x={pS.x - 58} y={pS.y - 46} anchor="right" size={44} progress={youIn} box>
        You
      </Label>

      {/* Dimension chip, upper left */}
      <div
        style={{
          position: "absolute",
          left: t.safe.left + 28,
          top: t.safe.top + 24,
          width: 330,
          height: 72,
          borderRadius: 36,
          backgroundColor: t.palette.surface,
          border: `3px solid ${t.palette.text}33`,
          opacity: chipIn,
          translate: `0px ${(1 - chipIn) * -16}px`,
          fontFamily: font,
          fontSize: 40,
          fontWeight: 600,
          color: t.palette.text,
        }}
      >
        {[
          { text: "2D: circles", o: 1 - swap, dy: -14 * swap },
          { text: "3D: spheres", o: swap, dy: 14 * (1 - swap) },
        ].map((l) => (
          <div
            key={l.text}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: l.o,
              translate: `0px ${l.dy}px`,
              whiteSpace: "nowrap",
            }}
          >
            {l.text}
          </div>
        ))}
      </div>
    </>
  );
}
