import React from "react";
import { Composition, Folder } from "remotion";
import type { VideoData } from "./types";
import { ExplainerVideo, SingleScene, type SceneComponents } from "./Video";

/**
 * Builds the Remotion root for one production: "Video" for the full video, and
 * "Scene-s01", "Scene-s02"... for each scene on its own.
 */
export function makeRoot(data: VideoData, scenes: SceneComponents) {
  const total = data.scenes.reduce((sum, s) => sum + s.durationInFrames, 0);
  const Full: React.FC = () => <ExplainerVideo data={data} scenes={scenes} />;
  const single = Object.fromEntries(
    data.scenes.map((s) => [s.id, (() => <SingleScene data={data} scenes={scenes} sceneId={s.id} />) as React.FC]),
  );

  const RemotionRoot: React.FC = () => (
    <>
      <Composition
        id="Video"
        component={Full}
        durationInFrames={Math.max(1, total)}
        fps={data.fps}
        width={data.width}
        height={data.height}
      />
      <Folder name="Scenes">
        {data.scenes.map((s) => (
          <Composition
            key={s.id}
            id={`Scene-${s.id}`}
            component={single[s.id]!}
            durationInFrames={Math.max(1, s.durationInFrames)}
            fps={data.fps}
            width={data.width}
            height={data.height}
          />
        ))}
      </Folder>
    </>
  );
  return RemotionRoot;
}
