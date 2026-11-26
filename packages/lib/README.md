# Pipeline Remotion library

Each scene of a video is one file that default-exports a React component. In the studio it is `scene.tsx` in the scene's own folder; in the original pipeline it is `productions/<id>/scenes/sNN.tsx`. Whatever renders it puts it inside a `<Sequence>` for the scene, applies the entrance transition and camera move, and draws captions on top. **A scene only draws its own visuals.**

`useCurrentFrame()` inside a scene counts from 0 at the scene's first frame.

```tsx
import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background, Canvas, Icon, Label, useCueAppear, useTheme } from "@pipeline/lib";

export default function Scene() {
  const t = useTheme();
  const pinIn = useCueAppear("pin"); // 0 → 1 starting when the narrator says the pin's cue phrase
  return (
    <>
      <Background stars />
      <Canvas>
        <Icon name="pin" x={t.width / 2} y={t.height / 2} size={140} progress={pinIn} color="accent" />
      </Canvas>
      <Label x={t.width / 2} y={t.height / 2 + 120} progress={pinIn} box>You are here</Label>
    </>
  );
}
```

A complete example: [`packages/lib/examples/ExampleScene.tsx`](examples/ExampleScene.tsx).

## Rules

- Import only from `"@pipeline/lib"`, `"remotion"` and `"react"`, and in the studio from `"@shared/<Name>"` for the project's shared parts. No images, fonts or files from the internet.
- Drive every animation from `useCurrentFrame()` (directly, or through the helpers below) with `interpolate()`. CSS `transition`, `animation` and `@keyframes` do not render.
- No `Math.random()`: use `random("seed")` from `remotion` so every render is identical.
- Time each animation to its cue with `useCueFrame(elementId)` or `useCueAppear(elementId)`. The element ids are the cue ids in the scene's spec (in the original pipeline, the storyboard's element ids).
- Stay inside `useTheme().safe` (5% margins, and the bottom strip is kept clear for captions).
- Text at least 36 px tall, and short: a few words, not narration sentences.
- Scenes are type-checked with TypeScript `strict` and `noUncheckedIndexedAccess`: indexing an array (`items[i]`, `scene.cues[0]`) gives a value that may be `undefined`, so handle that (`?.`, `??`, or a guard).
- Use colours from the style guide: `"primary"`, `"secondary"`, `"accent"`, `"text"`, `"surface"`, `"background"` work anywhere a colour is accepted.

## Data and timing

| API | Returns |
|---|---|
| `useTheme()` | `palette`, `fontFamily`, `width`, `height`, `safe` `{left, right, top, bottom}`, `color(key or css)`, `visualStyle`, `iconStyle` |
| `useScene()` | This scene: `id`, `narration`, `visualDescription`, `layout`, `elements`, `onScreenText`, `cues`, `words`, `durationInFrames`, `speechStartFrame`, `speechEndFrame` |
| `useCueFrame(elementId, which = 0)` | Frame where the cue phrase for that element starts. Throws if the element has no cue |
| `useCues(elementId)` | All cues for an element: `startFrame`, `endFrame`, `cue`, `action` |
| `useAppear(atFrame, durationSec = 0.6)` | 0 → 1, eased, starting at a frame |
| `useCueAppear(elementId, {which, durationSec, delaySec})` | 0 → 1, eased, starting at the element's cue |
| `useBetween(startFrame, endFrame)` | Linear 0 → 1 between two frames, for things that travel |
| `useLoop(periodSec, fromFrame)` | Repeating 0 → 1, for pulses and blinking |
| `enter.fade / pop / up / down / left / right (p)` | Ready-made style objects for a progress value |
| `mix(from, to, p)` | Linear blend of two numbers |

Use `fps` from `useVideoConfig()` to turn seconds into frames.

## Components

HTML (place anywhere):

| Component | Props |
|---|---|
| `<Background stars? glow? color?>` | Full-frame background in the style guide colour |
| `<Title progress? y? size? color?>` | Big centred heading |
| `<Label x y progress? size? color? anchor? box? maxWidth?>` | Short text centred on (x, y); `box` adds a readable panel |

SVG (inside `<Canvas>`, which uses the video's pixel coordinates):

| Component | Props |
|---|---|
| `<Icon name x y size? color? progress? rotate?>` | Built-in flat icon centred on (x, y). Names: satellite, phone, pin, clock, earth, signal, user, lightbulb, gear, check, cross, star, cloud, server, lock, battery, chip, rocket, eye, document, chart, magnifier, home, car |
| `<Arrow x1 y1 x2 y2 progress? color? width? dashed? head?>` | Arrow that draws itself |
| `<DrawPath d progress? color? width? fill? dashed?>` | Any SVG path that draws itself |
| `<Ring cx cy r progress? color? width? fillOpacity? dashed?>` | Circle outline that draws itself |
| `<Dot cx cy r? color? progress?>` | Filled dot |
| `<PulseRings cx cy maxRadius? count? periodSec? fromFrame? untilFrame? color?>` | Expanding signal rings |

You can also draw any SVG (`<rect>`, `<path>`, `<text>`, gradients) inside `<Canvas>`, and any HTML with inline styles.

## Shared parts (studio)

A project's shared parts are components built once, before any scene, and imported by name:

```tsx
import { CameraBody } from "@shared/CameraBody";
```

A shared part follows the same rules as a scene. Its file exports the component by name, and also exports a `Demo` component that shows it with typical props, which the studio renders as the part's preview picture. A scene must not redraw something that exists as a shared part: use `shared_list` to see what there is, and `shared_request` to ask for one that is missing.
