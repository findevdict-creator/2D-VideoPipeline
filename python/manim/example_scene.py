"""
An example studio Manim scene: Pythagoras' theorem. Narration, roughly:
"Take any right triangle. Build a square on each side. The two small squares
together cover exactly the same area as the big one."
Cues in its spec: "triangle", "squares", "area".
"""

from manim import *
from pipeline_manim import StudioScene, safe, theme


class Main(StudioScene):
    def build(self):
        a, b = 1.5, 2.0
        A, B, C = ORIGIN, RIGHT * b, UP * a
        triangle = Polygon(A, B, C, color=theme.text, stroke_width=6)

        # A square on each side, pointing away from the triangle.
        on_b = Square(b, color=theme.primary, fill_opacity=0.35).next_to(Line(A, B), DOWN, buff=0)
        on_a = Square(a, color=theme.secondary, fill_opacity=0.35).next_to(Line(A, C), LEFT, buff=0)
        hyp = Line(B, C)
        on_c = Square(hyp.get_length(), color=theme.accent, fill_opacity=0.35)
        on_c.rotate(hyp.get_angle()).move_to(hyp.get_center() + rotate_vector(hyp.get_unit_vector(), -PI / 2) * hyp.get_length() / 2)

        # Place things inside `safe`: the frame without its margins and without the caption strip.
        figure = VGroup(triangle, on_a, on_b, on_c)
        safe.fit(figure, 0.92).move_to(safe.point(0.27, 0.5))

        equation = MathTex("a^2", "+", "b^2", "=", "c^2", font_size=72)
        equation.move_to(safe.point(0.74, 0.5))
        equation[0].set_color(theme.secondary)
        equation[2].set_color(theme.primary)
        equation[4].set_color(theme.accent)

        self.wait_until("triangle")
        self.play(Create(triangle), run_time=1.0)

        self.wait_until("squares")
        self.play(LaggedStart(FadeIn(on_a, scale=0.8), FadeIn(on_b, scale=0.8), FadeIn(on_c, scale=0.8), lag_ratio=0.35), run_time=1.6)

        # Arrive a moment early, so the equation is being written as the word is spoken.
        self.wait_until("area", lead=0.3)
        self.play(Write(equation), run_time=1.2)
        self.play(Indicate(equation[4], color=theme.accent), run_time=0.8)
