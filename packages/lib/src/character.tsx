import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { useTheme } from "./context";

/** What a character's drawing is told each frame. */
export interface CharacterState<P extends string, E extends string> {
  pose: P;
  expression: E;
  /** The character's own colours, with palette keys already turned into colours. */
  colors: Record<string, string>;
  /** True for the few frames of a blink, which happens by itself every few seconds. */
  blink: boolean;
  /** 0 with the mouth shut, up to 1 wide open. Moves while the character is talking. */
  mouth: number;
  frame: number;
  fps: number;
}

export interface CharacterSpec<P extends string, E extends string> {
  /** The box the character is drawn in, in its own units. It faces right, and its feet stand in the middle of the bottom edge. */
  width: number;
  height: number;
  /** Every stance the character has. The first is the one it stands in when none is asked for. */
  poses: readonly [P, ...P[]];
  /** Every face the character has. The first is its resting face. */
  expressions: readonly [E, ...E[]];
  /**
   * The character's colours by name: skin, hair, shirt and so on. A palette key such as
   * "primary" follows the video's theme; any other value is a fixed CSS colour. Scenes
   * cannot change them, which is what keeps the character the same everywhere.
   */
  colors: Record<string, string>;
  /** Draw the character as SVG inside its box, for one pose and one expression. */
  draw: (state: CharacterState<P, E>) => React.ReactNode;
}

export interface CharacterProps<P extends string, E extends string> {
  /** Where the character's feet stand, in frame pixels. */
  x: number;
  y: number;
  /** How tall the character is on screen, in pixels. Its width follows from its box: a character is never stretched. */
  height?: number;
  pose?: P;
  expression?: E;
  /** Characters are drawn facing right; "left" mirrors them. */
  facing?: "left" | "right";
  /** 0 to 1: the entrance. The character fades and rises in. */
  progress?: number;
  /** True while the character speaks, which moves its mouth. */
  talking?: boolean;
}

/** A character component, with what it can do attached for the studio and the character sheet to read. */
export type Character<P extends string = string, E extends string = string> = React.FC<CharacterProps<P, E>> & {
  character: { width: number; height: number; poses: readonly P[]; expressions: readonly E[]; colors: Record<string, string> };
};

/** Frames a blink lasts, and how often one comes. */
const BLINK_EVERY_SEC = 3.4;
const BLINK_FRAMES = 4;

/**
 * Define a character once, so every scene draws it the same. A scene may place it, size
 * it by its height, mirror it, and choose one of its poses and expressions. Its
 * proportions and colours belong to the definition and cannot be changed from a scene.
 *
 *   export const Mia = defineCharacter({
 *     width: 200, height: 400,
 *     poses: ["stand", "point", "wave"],
 *     expressions: ["calm", "happy", "surprised"],
 *     colors: { skin: "#F2C6A0", shirt: "primary", hair: "#3B2A20" },
 *     draw: ({ pose, expression, colors, blink, mouth }) => <>...</>,
 *   });
 */
export function defineCharacter<const P extends string, const E extends string>(spec: CharacterSpec<P, E>): Character<P, E> {
  const Component: React.FC<CharacterProps<P, E>> = ({ x, y, height, pose, expression, facing = "right", progress = 1, talking = false }) => {
    const t = useTheme();
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const tall = height ?? Math.round(t.height * 0.45);
    const wide = (tall * spec.width) / spec.height;
    const colors = Object.fromEntries(Object.entries(spec.colors).map(([name, value]) => [name, t.color(value)]));
    const every = Math.max(BLINK_FRAMES + 1, Math.round(BLINK_EVERY_SEC * fps));
    const state: CharacterState<P, E> = {
      pose: pose && spec.poses.includes(pose) ? pose : spec.poses[0],
      expression: expression && spec.expressions.includes(expression) ? expression : spec.expressions[0],
      colors,
      blink: frame % every >= every - BLINK_FRAMES,
      mouth: talking ? Math.abs(Math.sin((frame / fps) * Math.PI * 4.5)) : 0,
      frame,
      fps,
    };
    return (
      <svg
        viewBox={`0 0 ${spec.width} ${spec.height}`}
        width={wide}
        height={tall}
        preserveAspectRatio="xMidYMax meet"
        style={{
          position: "absolute",
          left: x - wide / 2,
          top: y - tall,
          overflow: "visible",
          opacity: progress,
          translate: `0px ${(1 - progress) * tall * 0.06}px`,
          scale: facing === "left" ? "-1 1" : undefined,
        }}
      >
        {spec.draw(state)}
      </svg>
    );
  };
  return Object.assign(Component, { character: { width: spec.width, height: spec.height, poses: spec.poses, expressions: spec.expressions, colors: spec.colors } });
}

/**
 * Every pose and every expression of a character on one frame, each with its name. The
 * studio draws this as the character's picture, for the person to approve.
 */
export const CharacterSheet: React.FC<{ character: Character }> = ({ character: Who }) => {
  const t = useTheme();
  const { poses, expressions, width, height } = Who.character;
  const rows = [
    { title: "Poses", cells: poses.map((pose) => ({ name: pose, pose, expression: expressions[0]! })) },
    { title: "Expressions", cells: expressions.map((expression) => ({ name: expression, pose: poses[0]!, expression })) },
  ];
  const most = Math.max(poses.length, expressions.length);
  const left = t.width * 0.05;
  const cellW = (t.width * 0.9) / most;
  const rowH = t.height * 0.46;
  const label = Math.round(t.height * 0.03);
  // As tall as the row allows, and no wider than its cell.
  const tall = Math.min(rowH - label * 3.4, ((cellW * 0.9) / width) * height);
  return (
    <div style={{ position: "absolute", inset: 0, background: t.palette.background, fontFamily: t.fontFamily, color: t.palette.text }}>
      {rows.map((row, r) => (
        <React.Fragment key={row.title}>
          <div style={{ position: "absolute", left, top: t.height * 0.03 + r * rowH, fontSize: label, fontWeight: 700, opacity: 0.6 }}>{row.title}</div>
          {row.cells.map((cell, i) => {
            const cx = left + cellW * (i + 0.5);
            const feet = t.height * 0.03 + r * rowH + label * 1.6 + tall;
            return (
              <React.Fragment key={cell.name}>
                <Who x={cx} y={feet} height={tall} pose={cell.pose} expression={cell.expression} />
                <div style={{ position: "absolute", left: cx - cellW / 2, width: cellW, top: feet + label * 0.3, textAlign: "center", fontSize: label, fontWeight: 600 }}>{cell.name}</div>
              </React.Fragment>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
};
