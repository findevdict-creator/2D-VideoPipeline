import type { CSSProperties } from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { useCueFrame } from "./context";

const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);

/** 0 before `atFrame`, rising smoothly to 1 over `durationSec`. */
export function useAppear(atFrame: number, durationSec = 0.6): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return interpolate(frame, [atFrame, atFrame + Math.max(1, durationSec * fps)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_OUT,
  });
}

/**
 * Progress (0 to 1) of an element's entrance, starting when its cue phrase is spoken.
 * `delaySec` can be negative to start slightly before the words.
 */
export function useCueAppear(
  elementId: string,
  { which = 0, durationSec = 0.6, delaySec = 0 }: { which?: number; durationSec?: number; delaySec?: number } = {},
): number {
  const { fps } = useVideoConfig();
  const at = useCueFrame(elementId, which) + Math.round(delaySec * fps);
  return useAppear(at, durationSec);
}

/** Linear progress from `startFrame` to `endFrame`, clamped to 0..1. Good for travelling dots and counters. */
export function useBetween(startFrame: number, endFrame: number): number {
  const frame = useCurrentFrame();
  return interpolate(frame, [startFrame, Math.max(startFrame + 1, endFrame)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/** A repeating 0..1 cycle, for pulses and blinking. Starts at `fromFrame`. */
export function useLoop(periodSec: number, fromFrame = 0): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < fromFrame) return 0;
  const period = Math.max(1, periodSec * fps);
  return ((frame - fromFrame) % period) / period;
}

/** Ready-made entrance styles. Pass the progress from useAppear or useCueAppear. */
export const enter = {
  fade: (p: number): CSSProperties => ({ opacity: p }),
  pop: (p: number): CSSProperties => ({ opacity: Math.min(1, p * 2), scale: String(0.6 + 0.4 * p) }),
  up: (p: number, distance = 40): CSSProperties => ({ opacity: p, translate: `0px ${(1 - p) * distance}px` }),
  down: (p: number, distance = 40): CSSProperties => ({ opacity: p, translate: `0px ${(p - 1) * distance}px` }),
  left: (p: number, distance = 60): CSSProperties => ({ opacity: p, translate: `${(1 - p) * distance}px 0px` }),
  right: (p: number, distance = 60): CSSProperties => ({ opacity: p, translate: `${(p - 1) * distance}px 0px` }),
};

/** Mix two numbers. */
export const mix = (from: number, to: number, p: number) => from + (to - from) * p;
