# Designing a scene

This is the studio's design guide for scenes. The library guide says which parts exist and
how to time them. This guide says how to arrange them so a frame looks designed, not
assembled. Follow it for every scene and every shared component. When the project's bible
says something different, the bible wins.

## One idea, one focal point

- Before you place anything, finish this sentence: "At the end of this scene the viewer is
  looking at ___." That thing is the focal point. It is the largest, the brightest or the
  only thing in the accent colour. Nothing else competes with it.
- A frame holds three to five things at once. More than that, and the earlier ones leave or
  dim to 30 to 40 percent opacity before the next arrives.
- If you cannot say what a thing is for, remove it. Decoration that does not explain is
  noise: no extra stars, grids, particles or icons "to fill the space".
- Empty space is part of the design. A third of the frame may stay empty.

## Layout

- Build on a grid. Divide the safe area into 12 columns with a gutter of 2 percent of the
  width, and start and end every block on a column line. Things that belong together share
  a left edge, a centre line or a baseline. Nearly aligned is worse than clearly offset.
- Keep a margin of at least 6 percent of the frame's width on every side, inside the safe
  area the library gives you. Nothing touches the edge unless it is meant to bleed off it.
- Use one of a few compositions and keep to it for the whole scene:
  - centred: one object in the middle, its label under it;
  - split: the object on one side taking 55 to 60 percent, text on the other;
  - row: two to four equal things side by side, for steps or a comparison;
  - stack: a title at the top, the picture under it, one line of result at the bottom.
- Put the focal point near a third of the frame or dead centre, never slightly off centre.
- Related things sit close together and unrelated things far apart. The gap inside a group
  is at most half the gap between groups.
- Take every gap from one scale: 8, 16, 24, 40, 64, 96 pixels at 1080p. Do not invent 37.
- In a vertical frame, stack instead of splitting, and make things larger rather than
  adding more of them.

## Text

- Text on screen is a label or a result, never a sentence the narrator is also saying. Two
  to five words. The captions already carry the narration.
- Sizes at 1080p: a title 72 to 96 pixels, a label 40 to 56, a small note never under 32.
  If text has to be smaller than 32 to fit, there is too much text.
- Three sizes in a scene at most, at least 1.4 times apart, so the order of importance is
  visible at a glance.
- Weights: 700 to 800 for a title, 500 to 600 for labels. Never a light weight on a dark
  background.
- At most two lines, and at most about 24 characters in a line. Break a line where the
  phrase breaks, not where the box ends.
- Left-align text that sits beside something, centre text that sits under something. Do not
  centre a block of more than two lines.
- Numbers are heroes: when the point is a number, set it at title size or larger with its
  unit smaller beside it.
- Line height 1.1 to 1.2 for titles and 1.3 to 1.4 for labels. Add a little letter spacing
  (0.02em) to short labels in capitals; use capitals only for labels of one or two words.

## Colour

- Colours come from the theme: `useTheme()` in code, `theme` in Manim. Never a hex code of
  your own.
- Follow 60, 30, 10: the background colour covers most of the frame, the surface and
  primary colours carry the picture, and the accent colour is used once, on the focal
  point or the word that matters.
- The secondary colour is for a second kind of thing, such as the other side of a
  comparison. It is not a decoration colour.
- Text is the text colour on the background or on a surface. Coloured text only for one
  emphasised word.
- Show state by more than colour: a tick, a label or a position as well as green or red.
- Dim what is no longer the point with opacity, not with a new grey.

## Shape and line

- One stroke width for outlines in a scene (4 to 6 pixels at 1080p) and one for fine lines
  (2 to 3). One corner radius for cards (16 to 24) and one for small chips.
- Draw things as simple, bold shapes that read at phone size. Detail smaller than 8 pixels
  disappears.
- Arrows start and end with a visible gap of 12 to 16 pixels from what they connect, and
  never cross text.
- A card is a surface-coloured rectangle with padding of at least 24 pixels. No borders and
  shadows together: pick one way to separate a card from the background.
- Shadows and glows are soft and rare. A glow marks the focal point only.

## Motion

- Everything that appears is tied to a cue. Nothing moves without a reason the narration
  gives.
- One thing arrives at a time, 0.3 to 0.6 seconds each. Stagger a group by 3 to 5 frames
  per item.
- Things enter by fading in while moving 20 to 40 pixels, or by drawing themselves. They do
  not fly across the frame, bounce more than once, or spin.
- Ease out for entrances, ease in for exits. Linear motion only for something that is
  really moving at a constant speed, such as a satellite on its orbit.
- Hold the finished picture for at least a second at the end of the scene.
- Once placed, a thing stays where it is. If the layout must change, move everything in one
  smooth step on a cue.

## Before you hand the scene over

Look at the stills and answer each of these. If one answer is no, fix it.

1. Squint: is one thing clearly the most important?
2. Is every text at least 32 pixels and at most two lines?
3. Do edges and centres line up, with the margin kept on every side?
4. Is the accent colour used once?
5. Is anything on screen that the narration never refers to?
6. Does nothing overlap, touch the frame's edge, or sit in the caption strip?
7. Would the frame still read on a phone held at arm's length?
