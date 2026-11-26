/**
 * Example scene, for reference. Storyboard: "Circles grow from three satellites
 * and meet at one point that becomes a pin". Elements: sat1, sat2, sat3, circles, pin.
 * Cue for "pin": "That point is you".
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { Background, Canvas, Icon, Label, Ring, useCueAppear, useCueFrame, useTheme, useAppear, Title } from "@pipeline/lib";

export default function Scene() {
  const t = useTheme();
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();

  // Lay out on the frame's pixel grid, inside the safe area.
  const cx = t.width / 2;
  const cy = (t.safe.top + t.safe.bottom) / 2 + 30;
  const sats = [
    { x: cx - 420, y: cy - 220 },
    { x: cx + 420, y: cy - 220 },
    { x: cx, y: cy + 260 },
  ];

  // Satellites appear one after another from the start of the scene.
  const satIn = [useAppear(0), useAppear(Math.round(0.4 * fps)), useAppear(Math.round(0.8 * fps))];
  // Circles grow during the first half of the narration.
  const grow = useAppear(Math.round(1 * fps), 3);
  // The pin drops exactly when the narrator says "That point is you".
  const pinIn = useCueAppear("pin", { durationSec: 0.5 });
  const pinAt = useCueFrame("pin");
  const titleIn = useAppear(0, 0.8);

  return (
    <>
      <Background stars />
      <Title progress={titleIn}>Trilateration</Title>
      <Canvas>
        {sats.map((s, i) => (
          <Ring
            key={`r${i}`}
            cx={s.x}
            cy={s.y}
            r={Math.hypot(s.x - cx, s.y - cy)}
            progress={grow}
            color={["primary", "secondary", "accent"][i]}
            width={5}
            fillOpacity={0.08}
          />
        ))}
        {sats.map((s, i) => (
          <Icon key={`s${i}`} name="satellite" x={s.x} y={s.y} size={120} progress={satIn[i]} color="text" />
        ))}
        {/* A small bounce after the pin lands, driven by frame, not CSS animation. */}
        <Icon name="pin" x={cx} y={cy - 50 - (frame > pinAt + 15 ? 0 : 20 * (1 - pinIn))} size={110} progress={pinIn} color="accent" />
      </Canvas>
      <Label x={cx} y={cy + 70} progress={pinIn} box>
        You are here
      </Label>
    </>
  );
}
