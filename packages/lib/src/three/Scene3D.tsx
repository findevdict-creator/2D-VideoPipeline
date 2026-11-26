import React, { useLayoutEffect } from "react";
import { useThree } from "@react-three/fiber";
import { ThreeCanvas } from "@remotion/three";
import { useVideoConfig } from "remotion";
import type { PerspectiveCamera } from "three";
import { SceneProvider, useScene, useTheme, useVideoData, VideoProvider } from "../context";
import { applyCamera, type CameraSpec, type Vec3 } from "./camera";

export type LightPreset = "studio" | "soft" | "dramatic" | "none";

/** Moves the canvas's camera to match the spec on every frame. */
const CameraRig: React.FC<{ spec: CameraSpec }> = ({ spec }) => {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const { width, height } = useVideoConfig();
  // No dependency list: the spec is a new object each frame, and the camera must follow it.
  useLayoutEffect(() => {
    applyCamera(camera, spec, width / height);
  });
  return null;
};

/**
 * Lighting that suits explainers: shapes read clearly and colours stay close to the palette.
 * "studio" is the default; "soft" has almost no shadows; "dramatic" is one strong light with a coloured rim.
 */
export const Lights: React.FC<{ preset?: LightPreset; shadows?: boolean; target?: Vec3 }> = ({ preset = "studio", shadows = false, target = [0, 0, 0] }) => {
  const t = useTheme();
  if (preset === "none") return null;
  const [x, y, z] = target;
  const key = (intensity: number, position: Vec3) => (
    <directionalLight
      position={[x + position[0], y + position[1], z + position[2]]}
      intensity={intensity}
      castShadow={shadows}
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0004}
      shadow-normalBias={0.03}
      shadow-camera-left={-12}
      shadow-camera-right={12}
      shadow-camera-top={12}
      shadow-camera-bottom={-12}
      shadow-camera-near={0.5}
      shadow-camera-far={60}
    />
  );
  if (preset === "soft") {
    return (
      <>
        <hemisphereLight args={["#ffffff", t.palette.background, 2.2]} />
        {key(1.1, [4, 9, 6])}
      </>
    );
  }
  if (preset === "dramatic") {
    return (
      <>
        <ambientLight intensity={0.25} />
        {key(3.4, [6, 7, 4])}
        <directionalLight position={[x - 5, y + 3, z - 7]} intensity={2.2} color={t.palette.accent} />
      </>
    );
  }
  return (
    <>
      <ambientLight intensity={0.9} />
      {key(2.6, [5, 9, 7])}
      <directionalLight position={[x - 7, y + 3, z + 3]} intensity={0.9} />
      <directionalLight position={[x, y + 5, z - 9]} intensity={0.7} />
    </>
  );
};

/** A floor that catches shadows. Its colour defaults to the palette's surface. */
export const Ground: React.FC<{ y?: number; size?: number; color?: string; opacity?: number }> = ({ y = 0, size = 80, color = "surface", opacity = 1 }) => {
  const t = useTheme();
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} receiveShadow>
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial color={t.color(color)} roughness={1} metalness={0} transparent={opacity < 1} opacity={opacity} />
    </mesh>
  );
};

export interface Scene3DProps {
  /** Where the camera is and what it looks at. Compute it from the frame to move the camera. */
  camera: CameraSpec;
  lights?: LightPreset;
  /** A palette key or CSS colour behind the scene. null leaves it clear, so a 2D <Background /> behind shows through. */
  background?: string | null;
  /** Let lights cast shadows. Meshes opt in with castShadow and receiveShadow. */
  shadows?: boolean;
  children?: React.ReactNode;
}

/**
 * A 3D scene that fills the frame. Its children are react-three-fiber elements
 * (<mesh>, <group>, lights) and this library's 3D components. Everything is drawn
 * from the current frame: there is no clock, so the same frame always looks the same.
 */
export const Scene3D: React.FC<Scene3DProps> = ({ camera, lights = "studio", background = "background", shadows = false, children }) => {
  const { width, height } = useVideoConfig();
  // React context does not cross into the 3D canvas by itself, so hand the scene's data over.
  const video = useVideoData();
  const scene = useScene();
  const t = useTheme();
  return (
    <ThreeCanvas
      width={width}
      height={height}
      shadows={shadows}
      gl={{ antialias: true, alpha: true }}
      camera={{ fov: camera.fov ?? 35, position: camera.position }}
      style={{ position: "absolute", left: 0, top: 0 }}
    >
      <VideoProvider data={video}>
        <SceneProvider scene={scene}>
          <CameraRig spec={camera} />
          {background ? <color attach="background" args={[t.color(background)]} /> : null}
          <Lights preset={lights} shadows={shadows} target={camera.lookAt} />
          {children}
        </SceneProvider>
      </VideoProvider>
    </ThreeCanvas>
  );
};
