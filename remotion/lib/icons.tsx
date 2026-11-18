import React from "react";
import type { Palette } from "./types";

/**
 * Simple flat icons drawn in a 100x100 box. Each gets the palette and a main colour.
 * Use them through <Icon name="satellite" ... />.
 */
type IconDraw = (c: string, p: Palette) => React.ReactNode;

const stroke = (c: string, w = 6) => ({ stroke: c, strokeWidth: w, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const });

export const ICONS: Record<string, IconDraw> = {
  satellite: (c, p) => (
    <>
      <rect x="38" y="38" width="24" height="24" rx="4" fill={c} />
      <rect x="6" y="40" width="26" height="20" rx="2" fill={p.surface} stroke={c} strokeWidth="3" />
      <rect x="68" y="40" width="26" height="20" rx="2" fill={p.surface} stroke={c} strokeWidth="3" />
      <line x1="32" y1="50" x2="38" y2="50" {...stroke(c, 4)} />
      <line x1="62" y1="50" x2="68" y2="50" {...stroke(c, 4)} />
      <path d="M50 38 L50 26 M44 22 Q50 16 56 22" {...stroke(c, 4)} />
    </>
  ),
  phone: (c, p) => (
    <>
      <rect x="28" y="8" width="44" height="84" rx="9" fill={p.surface} stroke={c} strokeWidth="5" />
      <rect x="34" y="18" width="32" height="60" rx="3" fill={p.background} />
      <circle cx="50" cy="85" r="3" fill={c} />
    </>
  ),
  pin: (c) => (
    <>
      <path d="M50 92 C50 92 20 58 20 38 A30 30 0 0 1 80 38 C80 58 50 92 50 92 Z" fill={c} />
      <circle cx="50" cy="38" r="11" fill="white" opacity="0.9" />
    </>
  ),
  clock: (c, p) => (
    <>
      <circle cx="50" cy="50" r="40" fill={p.surface} stroke={c} strokeWidth="6" />
      <path d="M50 26 L50 50 L66 60" {...stroke(c, 6)} />
    </>
  ),
  earth: (c, p) => (
    <>
      <circle cx="50" cy="50" r="42" fill={c} />
      <path d="M22 36 Q34 28 42 38 Q48 46 40 54 Q30 58 26 50 Z M56 22 Q70 26 74 40 Q66 44 60 36 Q54 30 56 22 Z M58 60 Q72 58 76 66 Q70 80 60 80 Q54 70 58 60 Z" fill={p.secondary} opacity="0.85" />
    </>
  ),
  signal: (c) => (
    <>
      <circle cx="50" cy="78" r="6" fill={c} />
      <path d="M34 62 A22 22 0 0 1 66 62 M22 48 A38 38 0 0 1 78 48 M10 34 A54 54 0 0 1 90 34" {...stroke(c, 6)} />
    </>
  ),
  user: (c) => (
    <>
      <circle cx="50" cy="32" r="18" fill={c} />
      <path d="M16 90 C16 66 32 56 50 56 C68 56 84 66 84 90 Z" fill={c} />
    </>
  ),
  lightbulb: (c, p) => (
    <>
      <path d="M50 10 A28 28 0 0 1 66 62 L64 72 L36 72 L34 62 A28 28 0 0 1 50 10 Z" fill={c} />
      <rect x="37" y="76" width="26" height="7" rx="3" fill={p.text} />
      <rect x="41" y="86" width="18" height="6" rx="3" fill={p.text} />
    </>
  ),
  gear: (c, p) => (
    <>
      <g fill={c}>
        {Array.from({ length: 8 }, (_, i) => (
          <rect key={i} x="44" y="6" width="12" height="20" rx="3" transform={`rotate(${i * 45} 50 50)`} />
        ))}
      </g>
      <circle cx="50" cy="50" r="30" fill={c} />
      <circle cx="50" cy="50" r="12" fill={p.background} />
    </>
  ),
  check: (c) => <path d="M18 52 L40 74 L84 28" {...stroke(c, 12)} />,
  cross: (c) => <path d="M22 22 L78 78 M78 22 L22 78" {...stroke(c, 12)} />,
  star: (c) => <path d="M50 8 L62 38 L94 40 L69 60 L77 92 L50 74 L23 92 L31 60 L6 40 L38 38 Z" fill={c} />,
  cloud: (c) => <path d="M28 78 A20 20 0 0 1 26 38 A26 26 0 0 1 74 32 A22 22 0 0 1 76 78 Z" fill={c} />,
  server: (c, p) => (
    <>
      {[12, 40, 68].map((y) => (
        <g key={y}>
          <rect x="14" y={y} width="72" height="22" rx="5" fill={c} />
          <circle cx="28" cy={y + 11} r="4" fill={p.background} />
        </g>
      ))}
    </>
  ),
  lock: (c, p) => (
    <>
      <path d="M32 46 L32 32 A18 18 0 0 1 68 32 L68 46" {...stroke(c, 8)} />
      <rect x="20" y="44" width="60" height="46" rx="8" fill={c} />
      <circle cx="50" cy="64" r="6" fill={p.background} />
    </>
  ),
  battery: (c, p) => (
    <>
      <rect x="10" y="30" width="72" height="40" rx="7" fill={p.surface} stroke={c} strokeWidth="5" />
      <rect x="84" y="42" width="8" height="16" rx="2" fill={c} />
      <rect x="18" y="38" width="44" height="24" rx="3" fill={c} />
    </>
  ),
  chip: (c, p) => (
    <>
      {[30, 44, 58, 72].map((v) => (
        <g key={v} stroke={c} strokeWidth="5">
          <line x1={v - 2} y1="8" x2={v - 2} y2="24" />
          <line x1={v - 2} y1="76" x2={v - 2} y2="92" />
          <line x1="8" y1={v - 2} x2="24" y2={v - 2} />
          <line x1="76" y1={v - 2} x2="92" y2={v - 2} />
        </g>
      ))}
      <rect x="22" y="22" width="56" height="56" rx="8" fill={c} />
      <rect x="36" y="36" width="28" height="28" rx="4" fill={p.background} />
    </>
  ),
  rocket: (c, p) => (
    <>
      <path d="M50 6 C66 20 70 44 66 70 L34 70 C30 44 34 20 50 6 Z" fill={c} />
      <circle cx="50" cy="38" r="9" fill={p.background} />
      <path d="M34 56 L20 74 L34 72 Z M66 56 L80 74 L66 72 Z" fill={p.secondary} />
      <path d="M40 74 L50 94 L60 74 Z" fill={p.accent} />
    </>
  ),
  eye: (c, p) => (
    <>
      <path d="M6 50 Q50 6 94 50 Q50 94 6 50 Z" fill={p.surface} stroke={c} strokeWidth="5" />
      <circle cx="50" cy="50" r="16" fill={c} />
    </>
  ),
  document: (c, p) => (
    <>
      <path d="M22 8 L62 8 L80 26 L80 92 L22 92 Z" fill={p.surface} stroke={c} strokeWidth="5" strokeLinejoin="round" />
      {[40, 54, 68].map((y) => (
        <line key={y} x1="34" y1={y} x2="68" y2={y} {...stroke(c, 5)} />
      ))}
    </>
  ),
  chart: (c, p) => (
    <>
      <line x1="12" y1="88" x2="90" y2="88" {...stroke(p.text, 4)} />
      <rect x="18" y="56" width="16" height="32" rx="3" fill={c} />
      <rect x="42" y="36" width="16" height="52" rx="3" fill={c} />
      <rect x="66" y="16" width="16" height="72" rx="3" fill={c} />
    </>
  ),
  magnifier: (c) => (
    <>
      <circle cx="42" cy="42" r="26" {...stroke(c, 9)} />
      <line x1="62" y1="62" x2="88" y2="88" {...stroke(c, 12)} />
    </>
  ),
  home: (c, p) => (
    <>
      <path d="M10 48 L50 12 L90 48" {...stroke(c, 8)} />
      <path d="M22 44 L22 88 L78 88 L78 44" fill={c} />
      <rect x="42" y="62" width="16" height="26" fill={p.background} />
    </>
  ),
  car: (c, p) => (
    <>
      <path d="M10 66 L16 44 Q20 34 32 34 L68 34 Q80 34 84 44 L90 66 Z" fill={c} />
      <rect x="6" y="60" width="88" height="16" rx="6" fill={c} />
      <circle cx="28" cy="78" r="9" fill={p.text} />
      <circle cx="72" cy="78" r="9" fill={p.text} />
      <rect x="28" y="40" width="44" height="14" rx="3" fill={p.background} opacity="0.6" />
    </>
  ),
};

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS);
