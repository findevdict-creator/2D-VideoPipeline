import React from "react";
import { AbsoluteFill, Composition } from "remotion";
import { Captions } from "../captions";
import { SceneProvider, VideoProvider } from "../context";
import type { VideoData } from "../types";
import { MissingScene, SceneShell } from "../Video";
import { FootageScene } from "./FootageScene";
import { HandDrawn } from "./HandDrawn";
import { IllustrationScene } from "./IllustrationScene";
import { Overlays } from "./Overlays";

/**
 * One studio scene as its own clip: the scene's visuals with its entrance and camera
 * move, the spec's overlays, and captions. No audio; narration is added at assembly.
 */
export const SceneClip: React.FC<{ data: VideoData; Component?: React.ComponentType }> = ({ data, Component }) => {
  const scene = data.scenes[0];
  if (!scene) return null;
  const body =
    scene.kind === "illustration" ? <IllustrationScene /> : scene.kind === "footage" ? <FootageScene /> : Component ? <Component /> : <MissingScene id={scene.id} />;
  const shell = (
    <SceneShell scene={scene} overlay={<Overlays />}>
      {body}
    </SceneShell>
  );
  // Real footage keeps its own look; everything drawn takes the video's.
  const sketched = data.style.look === "hand-drawn" && scene.kind !== "footage";
  return (
    <VideoProvider data={data}>
      <AbsoluteFill style={{ backgroundColor: data.style.palette.background }}>
        <SceneProvider scene={scene}>{sketched ? <HandDrawn>{shell}</HandDrawn> : shell}</SceneProvider>
        <Captions />
      </AbsoluteFill>
    </VideoProvider>
  );
};

const PLACEHOLDER: VideoData = {
  title: "",
  fps: 30,
  width: 1920,
  height: 1080,
  style: {
    visualStyle: "",
    palette: { background: "#0F172A", surface: "#1E293B", primary: "#38BDF8", secondary: "#A78BFA", accent: "#FBBF24", text: "#F8FAFC" },
    fontFamily: "Inter",
    iconStyle: "",
  },
  transitionFrames: 12,
  captionSafeArea: 0,
  scenes: [],
  captions: { enabled: false, fontSize: 54, position: "bottom", highlight: "accent", pages: [] },
  music: { src: null, volume: 0 },
};

/**
 * The Remotion root for studio renders. It registers one composition, "Scene", whose
 * size and length come from the data passed in as input props. Code scenes pass their
 * component; illustration and footage scenes are drawn from the data alone.
 */
export function makeSceneRoot(Component?: React.ComponentType) {
  const Clip: React.FC<Record<string, unknown>> = (props) => <SceneClip data={(props.data as VideoData | undefined) ?? PLACEHOLDER} Component={Component} />;
  const SceneRoot: React.FC = () => (
    <Composition
      id="Scene"
      component={Clip}
      defaultProps={{ data: PLACEHOLDER as unknown }}
      durationInFrames={1}
      fps={30}
      width={1920}
      height={1080}
      calculateMetadata={({ props }) => {
        const data = (props.data as VideoData | undefined) ?? PLACEHOLDER;
        return {
          durationInFrames: Math.max(1, data.scenes[0]?.durationInFrames ?? 1),
          fps: data.fps,
          width: data.width,
          height: data.height,
        };
      }}
    />
  );
  return SceneRoot;
}
