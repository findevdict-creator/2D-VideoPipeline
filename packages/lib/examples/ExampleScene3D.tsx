/**
 * Example 3D scene, for reference. "A satellite circles the Earth and sends its
 * signal down to a phone." Elements: earth, sat, phone, signal.
 * Cues: "sat" ("Each satellite"), "phone" ("Your phone listens").
 */
import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Label, useCueAppear, useCueFrame, useTheme } from "@pipeline/lib";
import { Scene3D, mix3, orbit, useScreenPoint, type CameraSpec, type Vec3 } from "@pipeline/lib/three";
import { Line, RoundedBox } from "@react-three/drei";

export default function Scene() {
  const t = useTheme();
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Everything that moves is a function of the frame. There is no clock in a render.
  const life = frame / durationInFrames;
  const satIn = useCueAppear("sat", { durationSec: 0.8 });
  const phoneIn = useCueAppear("phone", { durationSec: 0.5 });
  const signal = interpolate(frame, [useCueFrame("phone"), useCueFrame("phone") + fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // The camera drifts a quarter turn around the Earth over the scene.
  // Looking at a point below the Earth lifts the Earth in the frame, clear of the caption strip.
  const camera: CameraSpec = { position: orbit(-20 + 35 * life, 14, 3.5), lookAt: [0, -0.5, 0], fov: 32 };

  // The satellite rides a circle above the Earth; the phone is a point on the surface.
  const satAngle = 40 + 50 * life;
  const sat: Vec3 = orbit(satAngle, 4.8, 1.5);
  const phone: Vec3 = [0.75, 2.2, 1.45];
  const beamEnd = mix3(sat, phone, signal);

  // 2D labels that follow 3D points: project the point, then draw the label on top.
  const satOnScreen = useScreenPoint(camera, [sat[0], sat[1] + 0.9, sat[2]]);
  const phoneOnScreen = useScreenPoint(camera, phone);

  return (
    <>
      <Scene3D camera={camera} lights="studio" shadows>
        {/* Earth: one sphere, with a slightly larger see-through shell for atmosphere */}
        <mesh rotation={[0.2, life * 0.6, 0]} castShadow receiveShadow>
          <sphereGeometry args={[2.6, 64, 48]} />
          <meshStandardMaterial color={t.palette.primary} roughness={0.85} />
        </mesh>
        <mesh>
          <sphereGeometry args={[2.78, 48, 32]} />
          <meshStandardMaterial color={t.palette.secondary} transparent opacity={0.12} roughness={1} />
        </mesh>

        {/* Satellite: a body and two panels, scaled in by its cue */}
        <group position={sat} rotation={[0.3, (-satAngle * Math.PI) / 180, 0]} scale={satIn}>
          <RoundedBox args={[0.7, 0.5, 0.5]} radius={0.08} castShadow>
            <meshStandardMaterial color={t.palette.text} roughness={0.4} metalness={0.3} />
          </RoundedBox>
          {[-1, 1].map((side) => (
            <mesh key={side} position={[side * 0.95, 0, 0]} castShadow>
              <boxGeometry args={[1.1, 0.04, 0.5]} />
              <meshStandardMaterial color={t.palette.accent} roughness={0.5} />
            </mesh>
          ))}
        </group>

        {/* The phone: a glowing point on the surface, and the signal that reaches it */}
        <mesh position={phone} scale={phoneIn}>
          <sphereGeometry args={[0.16, 24, 16]} />
          <meshStandardMaterial color={t.palette.accent} emissive={t.palette.accent} emissiveIntensity={0.4 + 1.2 * signal} />
        </mesh>
        {signal > 0 ? <Line points={[sat, beamEnd]} color={t.palette.accent} lineWidth={5} dashed dashSize={0.25} gapSize={0.15} /> : null}
      </Scene3D>

      {satOnScreen.visible ? (
        <Label x={satOnScreen.x} y={satOnScreen.y} progress={satIn} box>
          Satellite
        </Label>
      ) : null}
      {phoneOnScreen.visible ? (
        <Label x={phoneOnScreen.x - 260} y={phoneOnScreen.y - 70} progress={phoneIn} box>
          Your phone
        </Label>
      ) : null}
    </>
  );
}
