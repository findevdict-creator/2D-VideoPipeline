/**
 * A generic scene that works for any storyboard scene: it lays out the scene's
 * elements as icons with short labels, each appearing on its cue. The mock
 * runner writes it instead of calling the Animator, so the render steps can be
 * tested for free.
 */
export const FALLBACK_SCENE = `import React from "react";
import { useVideoConfig } from "remotion";
import { Background, Canvas, Icon, Label, ICON_NAMES, Title, useAppear, useScene, useTheme } from "@pipeline/lib";

function guessIcon(text: string): string {
  const words = text.toLowerCase();
  return ICON_NAMES.find((name) => words.includes(name)) ?? "star";
}

const Element: React.FC<{ el: { id: string; kind: string; description: string }; at: number; x: number; y: number }> = ({ el, at, x, y }) => {
  const p = useAppear(at);
  return (
    <>
      <Canvas>
        <Icon name={guessIcon(el.id + " " + el.description)} x={x} y={y - 40} size={150} progress={p} />
      </Canvas>
      <Label x={x} y={y + 90} progress={p} size={36} maxWidth={360}>
        {el.description.split(/[,.;]/)[0]}
      </Label>
    </>
  );
};

export default function Scene() {
  const scene = useScene();
  const t = useTheme();
  const { fps } = useVideoConfig();
  const titleIn = useAppear(0);
  const n = scene.elements.length;
  const cy = (t.safe.top + t.safe.bottom) / 2 + 40;
  return (
    <>
      <Background stars />
      <Title progress={titleIn}>{scene.onScreenText[0] ?? scene.title}</Title>
      {scene.elements.map((el, i) => {
        const cue = scene.cues.find((c) => c.elementId === el.id);
        const at = cue ? cue.startFrame : Math.round((0.5 + i * 0.6) * fps);
        const x = t.safe.left + ((t.safe.right - t.safe.left) * (i + 0.5)) / n;
        return <Element key={el.id} el={el} at={at} x={x} y={cy} />;
      })}
    </>
  );
}
`;
