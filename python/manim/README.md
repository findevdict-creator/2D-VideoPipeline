# Manim scenes

A scene of type `manim` is a Python file, `scene.py`, that draws a mathematical
animation with [Manim Community](https://www.manim.community/). The studio runs it,
fits it to the narration, and puts the same captions, overlays and entrance on it as
on every other scene, so it sits in the video like the rest.

Use it for maths: equations that are written and transform, graphs, number lines,
geometry. For anything else, a `remotion-2d` scene is easier to get right.

Set up once with `npm run setup:manim`.

## The shape of a scene

```python
from manim import *
from pipeline_manim import StudioScene, safe, theme


class Main(StudioScene):
    def build(self):
        circle = Circle(radius=1.5, color=theme.primary).move_to(safe.center)

        self.wait_until("circle")            # the narrator starts saying the cue's phrase
        self.play(Create(circle), run_time=1.0)

        self.wait_until("area")
        self.play(circle.animate.set_fill(theme.primary, opacity=0.4), run_time=0.8)
```

- The class is called `Main` and extends `StudioScene`.
- Write `build(self)`, not `construct(self)`. The studio's `construct` paints the
  background, runs `build`, and then holds the last picture until the narration ends.
- Import only `manim`, `numpy`, `math` and `pipeline_manim`. A scene may not read or
  write files, use the network, or start other programs. `scene_check` refuses these.

A full example is in [example_scene.py](example_scene.py).

## Time: cues, not seconds

The scene is exactly as long as its narration. Each cue in the spec is a phrase of the
narration; the studio knows the moment it is spoken.

| Call | What it does |
| --- | --- |
| `self.wait_until("cue")` | Hold the picture until the phrase starts being spoken. Put it before the animation the phrase is about. |
| `self.wait_until("cue", lead=0.3)` | Arrive 0.3 s early, so the animation is under way as the word lands. |
| `self.until("cue")` | Seconds from now to the cue: `self.play(..., run_time=self.until("next"))` makes an animation end on the next cue. |
| `self.cue_time("cue")` | The cue's time in seconds from the scene's start. |
| `self.now` | Seconds since the scene's start. |
| `self.remaining()` | Seconds left until the scene ends. |
| `self.length` | The scene's length in seconds. |

A cue spoken more than once takes a second argument: `self.wait_until("pin", 1)` is the
second time.

Two things are reported by `scene_check` as problems, because the picture would be wrong:

- **A cue reached late.** If the animations before `wait_until("x")` are still running
  when `x` is spoken, what follows is late. Shorten their `run_time`.
- **Running past the end.** Whatever happens after the narration ends is cut off.

So keep each `run_time` shorter than the gap to the next cue, and leave the last second
of the scene for the finished picture to be read. Do not use `self.wait(n)` to line
things up with the narration: the narration's timing changes when its words change, and
`wait_until` follows it.

## Colour and font: the video's theme

`theme` holds the video's palette as hex strings Manim accepts as colours:
`theme.background`, `theme.surface`, `theme.primary`, `theme.secondary`,
`theme.accent`, `theme.text`. `theme.color("accent")` looks one up by name.

- The background is already `theme.background`. Do not set it.
- `Text` is in the video's font and `theme.text` colour unless you say otherwise.
- Manim's own default for shapes is white, and its named colours (`BLUE`, `YELLOW`)
  are not the video's. Give every shape a colour from `theme`, so the scene looks like
  the scenes around it.

## Space: stay inside `safe`

Manim's frame is 8 units high and, at 16:9, about 14.2 wide, centred on the origin.
Captions cover a strip at the bottom. `safe` is the part that is free:

| Name | What it is |
| --- | --- |
| `safe.center`, `safe.top_center`, `safe.bottom_center`, `safe.left_center`, `safe.right_center` | Points, as Manim coordinates |
| `safe.left`, `safe.right`, `safe.top`, `safe.bottom`, `safe.width`, `safe.height` | Its edges and size, in Manim units |
| `safe.point(x, y)` | A point from fractions: `(0, 0)` is the top left of the safe area, `(1, 1)` the bottom right |
| `safe.fit(mobject, share=1.0)` | Scales a mobject down, if needed, to fit a share of the safe area, and returns it |

Place things with `move_to(safe.point(0.25, 0.5))` rather than `to_edge(DOWN)`, which
would put them under the captions. Text should be large: `font_size` 36 or more for
labels, 60 or more for the equation the scene is about.

## Equations

Write equations with `MathTex`, one string per part you want to colour or move:

```python
equation = MathTex("a^2", "+", "b^2", "=", "c^2", font_size=72)
equation[4].set_color(theme.accent)
```

With LaTeX installed they are typeset. Without it, the studio shows them as plain
text in the video's font, with Unicode for what it can (`a² + b² = c²`, `√(x+1)`,
`π r²`, `(a+b)/2`), and `scene_check` adds a note saying so. Indexing parts,
`set_color_by_tex`, the numbers on `Axes` and `NumberLine`, and `DecimalNumber` work
either way. Keep expressions simple enough to read as plain text: stacked fractions,
matrices and integrals with limits need LaTeX to look right.

## What the camera can do

`StudioScene` is a `MovingCameraScene`, so the camera can zoom and pan:

```python
self.play(self.camera.frame.animate.scale(0.5).move_to(dot), run_time=1.2)
```

The captions and the spec's overlays do not move with it.

## Not available

- `ImageMobject`, `SVGMobject` and other things that load files. Draw with shapes.
- `ThreeDScene`. Use a scene of type `r3f` for 3D.
- `config`: the studio sets the frame size, frame rate and background.
- `self.add_sound`: sound is added when the video is assembled.
- Random numbers are allowed (`np.random`); they are seeded, so every render matches.

## Checking your work

`scene_check` reads the code and then runs the scene once without drawing it, which
takes a second or two. It reports Python errors with their line, cues reached late and
animations cut off by the end. `scene_stills` then draws the scene and shows frames
shortly after each cue. Look at them: text overlapping shapes and things too close to
the edge are the usual faults.
