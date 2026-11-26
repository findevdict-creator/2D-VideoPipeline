import React from "react";
import { AbsoluteFill, Audio, interpolate, Easing, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Captions } from "./captions";
import { SceneProvider, useTheme, useVideoData, VideoProvider } from "./context";
import type { SceneData, VideoData } from "./types";

export type SceneComponents = Record<string, React.ComponentType | undefined>;

const ease = Easing.bezier(0.16, 1, 0.3, 1);

/** Applies the storyboard's entrance transition and camera move around a scene. */
const SceneShell: React.FC<{ scene: SceneData; children: React.ReactNode }> = ({ scene, children }) => {
  const frame = useCurrentFrame();
  const { transitionFrames } = useVideoData();
  const t = useTheme();
  const p =
    scene.transitionIn === "cut"
      ? 1
      : interpolate(frame, [0, Math.max(1, transitionFrames)], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: ease,
        });
  const life = interpolate(frame, [0, Math.max(1, scene.durationInFrames)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const camera: React.CSSProperties =
    scene.camera === "slow-zoom-in"
      ? { scale: String(1 + 0.06 * life) }
      : scene.camera === "slow-zoom-out"
        ? { scale: String(1.06 - 0.06 * life) }
        : scene.camera === "pan"
          ? { translate: `${(0.5 - life) * t.width * 0.04}px 0px`, scale: "1.05" }
          : {};

  const entrance: React.CSSProperties =
    scene.transitionIn === "fade"
      ? { opacity: p }
      : scene.transitionIn === "slide"
        ? { translate: `${(1 - p) * t.width * 0.25}px 0px`, opacity: p }
        : scene.transitionIn === "zoom"
          ? { scale: String(0.85 + 0.15 * p), opacity: p }
          : scene.transitionIn === "wipe"
            ? { clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` }
            : {};

  return (
    <AbsoluteFill style={{ backgroundColor: t.palette.background, overflow: "hidden" }}>
      <AbsoluteFill style={entrance}>
        <AbsoluteFill style={camera}>{children}</AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const MissingScene: React.FC<{ id: string }> = ({ id }) => {
  const t = useTheme();
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", backgroundColor: t.palette.surface }}>
      <div style={{ fontFamily: t.fontFamily, fontSize: 56, color: t.palette.text, opacity: 0.7 }}>
        Scene {id} has not been animated yet
      </div>
    </AbsoluteFill>
  );
};

const SceneBlock: React.FC<{ scene: SceneData; Component?: React.ComponentType; withAudio: boolean }> = ({
  scene,
  Component,
  withAudio,
}) => (
  <SceneProvider scene={scene}>
    <SceneShell scene={scene}>{Component ? <Component /> : <MissingScene id={scene.id} />}</SceneShell>
    {withAudio && scene.audio ? <Audio src={staticFile(scene.audio)} /> : null}
  </SceneProvider>
);

/** The whole video: every scene in order with its narration, plus music and captions. */
export const ExplainerVideo: React.FC<{ data: VideoData; scenes: SceneComponents }> = ({ data, scenes }) => (
  <VideoProvider data={data}>
    <AbsoluteFill style={{ backgroundColor: data.style.palette.background }}>
      {data.scenes.map((scene) => (
        <Sequence key={scene.id} name={scene.id} from={scene.startFrame} durationInFrames={scene.durationInFrames}>
          <SceneBlock scene={scene} Component={scenes[scene.id]} withAudio />
        </Sequence>
      ))}
      {data.music.src ? <Audio src={staticFile(data.music.src)} volume={data.music.volume} loop /> : null}
      <Captions />
    </AbsoluteFill>
  </VideoProvider>
);

/** One scene on its own, for test frames and Studio. Captions are shown at their place in the full video. */
export const SingleScene: React.FC<{ data: VideoData; scenes: SceneComponents; sceneId: string }> = ({
  data,
  scenes,
  sceneId,
}) => {
  const scene = data.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`No scene ${sceneId}`);
  return (
    <VideoProvider data={data}>
      <AbsoluteFill>
        <SceneBlock scene={scene} Component={scenes[scene.id]} withAudio />
        <Sequence from={-scene.startFrame} layout="none">
          <Captions />
        </Sequence>
      </AbsoluteFill>
    </VideoProvider>
  );
};
