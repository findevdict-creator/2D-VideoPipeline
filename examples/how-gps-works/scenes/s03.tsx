/**
 * s03 "Your Phone Only Listens".
 * Satellite upper left broadcasts teal ring arcs toward a phone standing on the Earth arc (lower right).
 * 'Position' and 'Time' tags ride the straight satellite-to-phone path just ahead of the leading ring,
 * get absorbed by the phone, the receive badge lights up ("Only listens"), then a coral up-arrow is crossed out.
 */
import React from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Arrow, Background, Canvas, Icon, Label, useAppear, useCueFrame, useTheme } from "@pipeline/lib";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const EASE = Easing.inOut(Easing.cubic);

const PHONE_SIZE = 230; // icon box; body spans 44x84 of 100
const TAG_H = 76;
const POS_W = 280;
const TIME_W = 196;
const TAG_GAP = 16;

const Tag: React.FC<{
  x: number;
  y: number;
  w: number;
  icon: string;
  iconColor: string;
  text: string;
  opacity: number;
  scale: number;
}> = ({ x, y, w, icon, iconColor, text, opacity, scale }) => {
  const t = useTheme();
  if (opacity <= 0.001) return null;
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} opacity={opacity}>
      <rect
        x={-w / 2}
        y={-TAG_H / 2}
        width={w}
        height={TAG_H}
        rx={22}
        fill={t.palette.surface}
        stroke={t.palette.primary}
        strokeOpacity={0.7}
        strokeWidth={3}
      />
      <Icon name={icon} x={-w / 2 + 40} y={0} size={50} color={iconColor} />
      <text
        x={-w / 2 + 74}
        y={2}
        dominantBaseline="central"
        fontFamily={t.fontFamily}
        fontSize={38}
        fontWeight={700}
        fill={t.palette.text}
      >
        {text}
      </text>
    </g>
  );
};

export default function Scene() {
  const t = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ---- Cues -------------------------------------------------------------
  const ringsAt = useCueFrame("rings"); // "keeps broadcasting two things"
  const posAt = useCueFrame("tags", 0); // "where it is"
  const timeAt = useCueFrame("tags", 1); // "the exact time"
  const phoneAt = useCueFrame("phone"); // "Your phone only listens"
  const noSendAt = useCueFrame("noSend"); // "It never sends anything back"

  // ---- Layout -----------------------------------------------------------
  const sat = { x: t.safe.left + 210, y: t.safe.top + 160 };
  const earthR = 1700;
  const earth = { x: t.width * 0.52, y: t.safe.bottom + 1480 };
  const phoneX = 1320;
  const groundY = earth.y - Math.sqrt(earthR * earthR - (phoneX - earth.x) ** 2);
  const phoneHalfH = (42 * PHONE_SIZE) / 100;
  const phoneHalfW = (22 * PHONE_SIZE) / 100;
  const phoneY = groundY + 4 - phoneHalfH;
  const phoneTop = phoneY - phoneHalfH;
  const phoneRight = phoneX + phoneHalfW;

  const dx = phoneX - sat.x;
  const dy = phoneY - sat.y;
  const L = Math.hypot(dx, dy);
  const ux = dx / L;
  const uy = dy / L;
  const pathAngle = Math.atan2(dy, dx);

  // ---- Entrances (scene opens on a cut) --------------------------------
  const satIn = useAppear(0, 0.5);
  const phoneIn = useAppear(4, 0.5);
  const earthIn = useAppear(0, 0.4);

  // ---- Rings ------------------------------------------------------------
  // Emitted on a steady beat; the beat lands exactly on the 'Position' cue so that ring carries the tags.
  const P = Math.max(12, Math.round((posAt - ringsAt) / 2));
  const carrierEmit = ringsAt + 2 * P;
  const TAG_LEAD = 290; // tag centre stays this far ahead of the carrier ring (clears the tag box corners)
  const arriveFrame = phoneAt + 20;
  const V = (L - 40 - TAG_LEAD) / Math.max(1, arriveFrame - carrierEmit); // px per frame, rings and tags
  const longMax = L - 150; // long rings fade out before reaching the phone
  const shortMax = 280; // early "heartbeat" pulses stay near the satellite (but travel far enough to read)
  const halfSector = (32 * Math.PI) / 180;
  const ringDim = interpolate(frame, [noSendAt, noSendAt + 20], [1, 0.5], clamp);

  const rings: { r: number; op: number; key: number }[] = [];
  if (frame >= ringsAt) {
    const n = Math.floor((frame - ringsAt) / P);
    for (let k = 0; k <= n; k++) {
      const emit = ringsAt + k * P;
      const r = V * (frame - emit);
      const isLong = emit >= carrierEmit;
      const max = isLong ? longMax : shortMax;
      if (r >= max) continue;
      const fadeIn = Math.min(1, r / 40);
      const op = 0.9 * fadeIn * Math.pow(1 - r / max, isLong ? 0.7 : 1) * ringDim;
      rings.push({ r, op, key: k });
    }
  }
  const arc = (r: number) => {
    const a0 = pathAngle - halfSector;
    const a1 = pathAngle + halfSector;
    return `M ${sat.x + r * Math.cos(a0)} ${sat.y + r * Math.sin(a0)} A ${r} ${r} 0 0 1 ${sat.x + r * Math.cos(a1)} ${
      sat.y + r * Math.sin(a1)
    }`;
  };
  // Satellite flashes on each emission
  const sinceEmit = frame >= ringsAt ? (frame - ringsAt) % P : 99;
  const flash = Math.max(0, 1 - sinceEmit / 10) * ringDim;

  // ---- Tags -------------------------------------------------------------
  const posIn = interpolate(frame, [posAt, posAt + 0.45 * fps], [0, 1], { ...clamp, easing: Easing.out(Easing.back(1.6)) });
  const timeIn = interpolate(frame, [timeAt, timeAt + 0.45 * fps], [0, 1], { ...clamp, easing: Easing.out(Easing.back(1.6)) });
  const pairShift = interpolate(frame, [timeAt, timeAt + 0.5 * fps], [0, 1], { ...clamp, easing: EASE });
  const absorb = interpolate(frame, [phoneAt - 5, arriveFrame + 5], [0, 1], { ...clamp, easing: EASE });
  const tagD = Math.min(L - 40, TAG_LEAD + V * Math.max(0, frame - carrierEmit));
  const gx = sat.x + ux * tagD;
  const gy = sat.y + uy * tagD;
  const totalW = POS_W + TAG_GAP + TIME_W;
  const posOff = -totalW / 2 + POS_W / 2; // when both tags are showing
  const timeOff = totalW / 2 - TIME_W / 2;
  const collapse = 1 - absorb;
  const tagFade = 1 - absorb;
  const tagScaleAbsorb = 1 - 0.35 * absorb;

  // ---- Phone badge ------------------------------------------------------
  const badgeIn = useAppear(phoneAt + 6, 0.5);
  const lit = useAppear(phoneAt + 14, 0.6);
  const labelIn = useAppear(phoneAt + 24, 0.6);
  const badgeX = phoneRight + 78; // centre of the wave arcs (waves curve toward the phone)
  const badgeY = phoneY - 24;
  const wavePhase = ((frame / (1.1 * fps)) % 1 + 1) % 1;
  const waveRadii = [14, 30, 46];
  const waveArc = (r: number) => {
    const a0 = Math.PI - 0.75;
    const a1 = Math.PI + 0.75;
    return `M ${badgeX + r * Math.cos(a0)} ${badgeY + r * Math.sin(a0)} A ${r} ${r} 0 0 1 ${badgeX + r * Math.cos(a1)} ${
      badgeY + r * Math.sin(a1)
    }`;
  };
  const glowPulse = 0.5 + 0.5 * Math.sin((frame / fps) * Math.PI * 1.6);

  // ---- No-send arrow ----------------------------------------------------
  const arrowP = interpolate(frame, [noSendAt, noSendAt + 0.6 * fps], [0, 1], { ...clamp, easing: EASE });
  const crossAt = noSendAt + Math.round(0.8 * fps); // lands on "sends"
  const stamp = interpolate(frame, [crossAt, crossAt + 0.35 * fps], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const crossScale =
    interpolate(frame, [crossAt, crossAt + 0.35 * fps], [1.8, 1], { ...clamp, easing: Easing.out(Easing.back(2.2)) }) *
    (1 + 0.03 * Math.sin(((frame - crossAt) / fps) * Math.PI * 1.4) * stamp);
  const shakeDecay = interpolate(frame, [crossAt + 0.25 * fps, crossAt + 0.7 * fps], [1, 0], clamp);
  const shake = frame > crossAt + 0.25 * fps ? 5 * Math.sin((frame - crossAt) * 2.2) * shakeDecay : 0;
  const arrowY1 = phoneTop - 18;
  const arrowY2 = phoneTop - 210;
  const crossY = (arrowY1 + arrowY2) / 2 - 10;
  const arrowOpacity = 1 - 0.45 * stamp;

  // ---- Continuous motion ------------------------------------------------
  const bob = 5 * Math.sin((frame / fps) * Math.PI * 0.8);
  const satTilt = 3 * Math.sin((frame / fps) * Math.PI * 0.5);
  const dotHalo = ((frame / (1.4 * fps)) % 1 + 1) % 1;

  const screenL = phoneX - (16 * PHONE_SIZE) / 100;
  const screenT = phoneY - (32 * PHONE_SIZE) / 100;
  const screenW = (32 * PHONE_SIZE) / 100;
  const screenH = (60 * PHONE_SIZE) / 100;

  // Land patches placed along the Earth's crown (angle from the top, size)
  const lands = [
    { a: -0.42, rx: 170, ry: 46 },
    { a: -0.2, rx: 95, ry: 30 },
    { a: 0.05, rx: 210, ry: 54 },
    { a: 0.33, rx: 140, ry: 40 },
    { a: 0.52, rx: 120, ry: 36 },
  ];

  return (
    <>
      <Background stars />
      <Canvas>
        <defs>
          <clipPath id="s03-safe">
            <rect x={t.safe.left} y={t.safe.top} width={t.safe.right - t.safe.left} height={t.safe.bottom - t.safe.top} />
          </clipPath>
          <linearGradient id="s03-earthfade" gradientUnits="userSpaceOnUse" x1="0" y1={t.safe.bottom - 90} x2="0" y2={t.safe.bottom}>
            <stop offset="0" stopColor="white" stopOpacity={1} />
            <stop offset="1" stopColor="white" stopOpacity={0} />
          </linearGradient>
          <mask id="s03-earthmask">
            <rect x={0} y={0} width={t.width} height={t.safe.bottom} fill="url(#s03-earthfade)" />
          </mask>
          <clipPath id="s03-earthclip">
            <circle cx={earth.x} cy={earth.y} r={earthR} />
          </clipPath>
          <clipPath id="s03-screen">
            <rect x={screenL} y={screenT} width={screenW} height={screenH} rx={7} />
          </clipPath>
        </defs>

        {/* Signal rings: arcs aimed down the satellite-to-phone path */}
        <g clipPath="url(#s03-safe)">
          {rings.map((ring) => (
            <path
              key={ring.key}
              d={arc(ring.r)}
              fill="none"
              stroke={t.palette.primary}
              strokeWidth={6}
              strokeLinecap="round"
              opacity={ring.op}
            />
          ))}
        </g>

        {/* Earth arc, softly fading out above the caption strip */}
        <g mask="url(#s03-earthmask)" opacity={earthIn}>
          <circle cx={earth.x} cy={earth.y} r={earthR + 26} fill={t.palette.primary} opacity={0.07} />
          <circle cx={earth.x} cy={earth.y} r={earthR} fill="#24508F" />
          <g clipPath="url(#s03-earthclip)">
            {lands.map((l, i) => {
              const lx = earth.x + (earthR - 40) * Math.sin(l.a);
              const ly = earth.y - (earthR - 40) * Math.cos(l.a);
              return (
                <ellipse
                  key={i}
                  cx={lx}
                  cy={ly}
                  rx={l.rx}
                  ry={l.ry}
                  fill="#4F8A68"
                  opacity={0.85}
                  transform={`rotate(${(l.a * 180) / Math.PI} ${lx} ${ly})`}
                />
              );
            })}
          </g>
          <circle cx={earth.x} cy={earth.y} r={earthR} fill="none" stroke={t.palette.primary} strokeOpacity={0.4} strokeWidth={6} />
        </g>

        {/* Satellite with an emission flash */}
        <circle cx={sat.x} cy={sat.y + bob} r={70} fill={t.palette.primary} opacity={0.18 * flash} />
        <Icon name="satellite" x={sat.x} y={sat.y + bob} size={170} color="primary" progress={satIn} rotate={satTilt} />

        {/* Phone: teal glow once it receives */}
        <rect
          x={phoneX - phoneHalfW - 16}
          y={phoneY - phoneHalfH - 16}
          width={(phoneHalfW + 16) * 2}
          height={(phoneHalfH + 16) * 2}
          rx={34}
          fill={t.palette.primary}
          opacity={lit * (0.14 + 0.08 * glowPulse)}
        />
        <Icon name="phone" x={phoneX} y={phoneY} size={PHONE_SIZE} color="text" progress={phoneIn} />
        <g clipPath="url(#s03-screen)" opacity={phoneIn}>
          <path
            d={`M ${screenL - 5} ${phoneY - 30} L ${screenL + screenW + 5} ${phoneY - 46} M ${phoneX - 14} ${screenT - 5} L ${
              phoneX + 8
            } ${screenT + screenH + 5} M ${screenL - 5} ${phoneY + 34} L ${screenL + screenW + 5} ${phoneY + 22}`}
            stroke={t.palette.surface}
            strokeWidth={6}
            fill="none"
          />
          <rect x={screenL} y={screenT} width={screenW} height={screenH} fill={t.palette.primary} opacity={0.12 * lit} />
          <circle cx={phoneX - 2} cy={phoneY - 4} r={10 + 14 * dotHalo} fill="#3D8BFF" opacity={0.35 * (1 - dotHalo)} />
          <circle cx={phoneX - 2} cy={phoneY - 4} r={9} fill="#3D8BFF" stroke="white" strokeWidth={2.5} />
        </g>

        {/* Receive badge: three arcs curving into the phone; highlight travels inward */}
        <g opacity={badgeIn}>
          {waveRadii.map((r, i) => {
            const d = (((wavePhase - i / 3) % 1) + 1) % 1;
            const hl = Math.max(0, 1 - Math.abs(d - 0.2) / 0.25);
            return (
              <g key={r}>
                <path d={waveArc(r)} fill="none" stroke={t.palette.surface} strokeWidth={7} strokeLinecap="round" />
                <path
                  d={waveArc(r)}
                  fill="none"
                  stroke={t.palette.primary}
                  strokeWidth={7}
                  strokeLinecap="round"
                  opacity={lit * (0.55 + 0.45 * hl)}
                />
              </g>
            );
          })}
        </g>

        {/* Tags riding just ahead of the carrier ring; upright, never rotated */}
        <Tag
          x={gx + posOff * pairShift * collapse}
          y={gy}
          w={POS_W}
          icon="pin"
          iconColor={t.palette.accent}
          text="Position"
          opacity={Math.min(1, posIn * 2) * tagFade}
          scale={(0.6 + 0.4 * posIn) * tagScaleAbsorb}
        />
        <Tag
          x={gx + timeOff * collapse}
          y={gy}
          w={TIME_W}
          icon="clock"
          iconColor={t.palette.primary}
          text="Time"
          opacity={Math.min(1, timeIn * 2) * tagFade}
          scale={(0.6 + 0.4 * timeIn) * tagScaleAbsorb}
        />

        {/* Nothing goes back up */}
        <g opacity={arrowOpacity}>
          <Arrow x1={phoneX} y1={arrowY1} x2={phoneX} y2={arrowY2} progress={arrowP} color="secondary" width={10} />
        </g>
        {stamp > 0 ? (
          <g transform={`translate(${phoneX + shake} ${crossY}) scale(${crossScale})`} opacity={stamp}>
            <path d="M -50 -50 L 50 50 M 50 -50 L -50 50" stroke={t.palette.background} strokeWidth={30} strokeLinecap="round" />
            <path d="M -50 -50 L 50 50 M 50 -50 L -50 50" stroke={t.palette.secondary} strokeWidth={17} strokeLinecap="round" />
          </g>
        ) : null}
      </Canvas>

      <Label x={badgeX + 22} y={badgeY} anchor="left" size={40} progress={labelIn} box color="primary">
        Only listens
      </Label>
    </>
  );
}
