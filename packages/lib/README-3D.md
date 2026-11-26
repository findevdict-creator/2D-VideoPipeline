# 3D scenes

A scene of type `r3f` is a React component like any other scene, with a 3D picture inside it. The 3D part is drawn with [react-three-fiber](https://r3f.docs.pmnd.rs) (three.js as React elements) inside `<Scene3D>`. Everything in [README.md](README.md) still applies: cues, the theme, captions, the safe area, and 2D components such as `<Label>` drawn on top.

```tsx
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { Label, useCueAppear, useTheme } from "@pipeline/lib";
import { Scene3D, orbit, useScreenPoint, type CameraSpec } from "@pipeline/lib/three";

export default function Scene() {
  const t = useTheme();
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const boxIn = useCueAppear("box"); // 0 → 1 when the narrator says the box's cue phrase

  // The camera circles a little during the scene. It is plain data, computed from the frame.
  const camera: CameraSpec = { position: orbit(20 + 30 * (frame / durationInFrames), 10, 3), lookAt: [0, 0, 0], fov: 32 };
  const top = useScreenPoint(camera, [0, 1.4, 0]); // where a 3D point lands on screen

  return (
    <>
      <Scene3D camera={camera} shadows>
        <mesh scale={boxIn} castShadow>
          <boxGeometry args={[2, 2, 2]} />
          <meshStandardMaterial color={t.palette.primary} roughness={0.6} />
        </mesh>
      </Scene3D>
      <Label x={top.x} y={top.y - 60} progress={boxIn} box>The box</Label>
    </>
  );
}
```

A complete example: [`examples/ExampleScene3D.tsx`](examples/ExampleScene3D.tsx).

## The one rule that is different

**The frame is the only clock.** A render draws frames in any order, several at once, so the picture at frame 90 must depend on nothing but the number 90.

- Compute every position, rotation, scale and camera move from `useCurrentFrame()`, with `interpolate()`, `useCueAppear()` and the helpers below, and pass the result as props.
- Do not use `useFrame`, three.js clocks, `OrbitControls` or anything else that moves by itself. The check refuses them.
- No `Math.random()` and no three.js random helpers: use `random("seed")` from `remotion`.
- Nothing is loaded from the internet. That rules out drei's `<Text>`, `<Environment preset>`, `<Html>` and its loaders. Models and images come from the project's assets (below). Text is drawn in 2D on top, with `<Label>`.

## Imports

`"@pipeline/lib"`, `"@pipeline/lib/three"`, `"remotion"`, `"react"`, `"three"`, `"@react-three/fiber"`, and from `"@react-three/drei"` only these, which draw from their props alone:

`Box`, `Sphere`, `Cylinder`, `Cone`, `Torus`, `TorusKnot`, `Plane`, `Circle`, `Ring`, `Capsule`, `RoundedBox`, `Tetrahedron`, `Octahedron`, `Dodecahedron`, `Icosahedron`, `Tube`, `Extrude`, `Lathe`, `Shape`, `Line`, `QuadraticBezierLine`, `CubicBezierLine`, `CatmullRomLine`, `Edges`, `Outlines`, `Wireframe`, `Center`, `Billboard`, `Instances`, `Instance`, `Merged`, `ContactShadows`, `GradientTexture`, `Grid`, `Backdrop`, `Decal`, `MeshTransmissionMaterial`.

Shared 2D components (`@shared/<Name>`) are drawn with HTML and SVG, so they go on top of the 3D picture, not inside `<Scene3D>`.

## `@pipeline/lib/three`

| API | What it does |
|---|---|
| `<Scene3D camera lights? background? shadows?>` | The 3D picture, filling the frame. Children are three.js elements (`<mesh>`, `<group>`) and the components below. `lights` is `"studio"` (default), `"soft"`, `"dramatic"` or `"none"`. `background` is a palette key or colour; `null` leaves it clear so a 2D `<Background />` behind it shows through |
| `CameraSpec` | `{ position: [x, y, z], lookAt?: [x, y, z], fov?: number }`. `fov` is in degrees, default 35: about 25 flattens like a long lens, about 55 exaggerates depth |
| `orbit(angleDeg, radius, height?, center?)` | A point on a circle around `center`, for cameras and things that circle a subject. 0° is in front (+z), 90° to the right (+x) |
| `mix3(from, to, p)` | Blend two points |
| `useScreenPoint(camera, [x, y, z])` | `{ x, y, visible }`: where a 3D point is on screen in pixels, for `<Label>`, `<Arrow>` and other 2D things that point at it. Pass the same camera you give `<Scene3D>` |
| `<Lights preset? shadows?>` | The same lighting presets, if you set `lights="none"` and want to place them yourself |
| `<Ground y? size? color?>` | A floor that catches shadows |
| `<Model asset fit? position? rotation? scale? parts? animations?>` | A 3D model from the project's assets |
| `useModelInfo(asset)` | The model's `size`, `center`, `parts` and `animations` |
| `useAssetTexture(asset)` | One of the project's images as a texture: `<meshStandardMaterial map={useAssetTexture("as_...")} />` |

Units are up to you. A subject about 4 units across with the camera 10 to 14 units away at `fov` 30 fills the frame well. y is up.

Hooks from `@pipeline/lib` and `remotion` (`useTheme`, `useCueAppear`, `useCurrentFrame`) work inside `<Scene3D>` too, so you can split a scene into components.

### Keeping clear of captions and the frame's edge

Captions cover the bottom strip of the frame. To lift the subject above them, aim the camera at a point below the subject (`lookAt: [0, -0.6, 0]`) rather than moving the subject. Check the stills: nothing important in the bottom fifth, labels inside the frame.

### Colour and light

Take colours from `useTheme().palette` so 3D scenes match the 2D ones: `color={t.palette.primary}`. `meshStandardMaterial` with `roughness` 0.5 to 0.9 and `metalness` 0 looks clean and flat; `meshToonMaterial`, or `<Edges>` and `<Outlines>` from drei, give a drawn look. For shadows, set `shadows` on `<Scene3D>`, then `castShadow` and `receiveShadow` on meshes.

## Models from Blender

A model the person exported from Blender as `.glb` is one of the project's assets. `asset_list` gives its id, its parts by name, its animations and its size, and `asset_view` shows it from four sides.

1. List the asset's id under `assets` in the scene's spec.
2. Draw it:

```tsx
const open = useCueAppear("back");                                  // 0 → 1 on a cue
const shutterSec = Math.max(0, (frame - useCueFrame("click")) / fps); // seconds since a cue

<Model
  asset="as_1m8bdhmmnexbgf"
  fit={4}                                              // longest side becomes 4 units, centred
  parts={{ Back: { offset: [0, 0, -1.5 * open], opacity: 1 - 0.5 * open } }}
  animations={{ ShutterOpen: shutterSec }}             // show the file's animation at this time
/>
```

- `fit` resizes the model so its longest side is that many units and centres it. Use it: models come out of Blender at any size.
- `parts` changes named parts on top of how they sit in the file: `offset` moves a part (in the model's own units, which `asset_list` reports as its size), `rotate` turns it (radians), `scale`, `visible`, `color` (a palette key or colour) and `opacity`. This is how you open something up, pull a part out, or highlight one.
- `animations` shows animations made in Blender. Each is given a time in seconds, which you compute from the frame; nothing plays by itself. Past its end, an animation holds its last pose.
- To point a label at a part, use the part's position from `asset_list` and remember `fit` rescales it: or simpler, place the label by eye from the stills.
- A part or animation name that is not in the file stops the render with a message listing the names that are.
