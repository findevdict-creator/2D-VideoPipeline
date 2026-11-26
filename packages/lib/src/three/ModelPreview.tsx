import React from "react";
import { AbsoluteFill, Composition } from "remotion";
import { SceneProvider, useTheme, VideoProvider } from "../context";
import type { VideoData } from "../types";
import { orbit, type CameraSpec } from "./camera";
import { Model } from "./Model";
import { Ground, Scene3D } from "./Scene3D";

/** The angles a model is shown from when someone needs to see what it is. */
export const MODEL_VIEWS = [
  { name: "front right", angle: 35, lift: 0.45 },
  { name: "back left", angle: 215, lift: 0.45 },
  { name: "front", angle: 0, lift: 0.05 },
  { name: "top", angle: 20, lift: 2.4 },
] as const;

export interface ModelPreviewProps {
  data: VideoData;
  /** Index into MODEL_VIEWS. */
  view: number;
  /** An animation from the file to show, and how far into it. */
  animation?: string;
  time?: number;
}

const FIT = 4;

const Preview: React.FC<{ view: number; animation?: string; time?: number }> = ({ view, animation, time }) => {
  const t = useTheme();
  const v = MODEL_VIEWS[view] ?? MODEL_VIEWS[0];
  const distance = 10.5;
  const camera: CameraSpec = { position: orbit(v.angle, distance / Math.sqrt(1 + v.lift * v.lift), (distance * v.lift) / Math.sqrt(1 + v.lift * v.lift)), lookAt: [0, 0, 0], fov: 30 };
  return (
    <AbsoluteFill style={{ backgroundColor: t.palette.background }}>
      <Scene3D camera={camera} lights="studio" shadows>
        <Model asset="model" fit={FIT} animations={animation ? { [animation]: time ?? 0 } : undefined} />
        <Ground y={-FIT / 2 - 0.02} />
      </Scene3D>
    </AbsoluteFill>
  );
};

/** The Remotion root for pictures of a model asset. The model arrives as the scene's asset "model". */
export function makeModelPreviewRoot() {
  const Still: React.FC<Record<string, unknown>> = (props) => {
    const { data, view, animation, time } = props as unknown as ModelPreviewProps;
    const scene = data?.scenes[0];
    if (!scene) return null;
    return (
      <VideoProvider data={data}>
        <SceneProvider scene={scene}>
          <Preview view={view ?? 0} animation={animation} time={time} />
        </SceneProvider>
      </VideoProvider>
    );
  };
  const Root: React.FC = () => <Composition id="ModelPreview" component={Still} durationInFrames={1} fps={30} width={1280} height={960} defaultProps={{}} />;
  return Root;
}
