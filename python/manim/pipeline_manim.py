"""What a studio Manim scene builds on.

A scene file looks like this:

    from manim import *
    from pipeline_manim import StudioScene, theme, safe

    class Main(StudioScene):
        def build(self):
            title = Text("Pythagoras").move_to(safe.top_center + DOWN * 0.6)
            self.play(Write(title))
            self.wait_until("square")      # the moment the narrator says the cue's phrase
            ...

The studio runs it with the scene's data in the file named by STUDIO_SCENE_DATA:
the palette and font of the video, the length of the narration, and when each cue is
spoken. Run on its own, the helper uses placeholder data, so a scene can still be tried
with plain `manim`.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys

import manim
import numpy as np
from manim import DOWN, LEFT, RIGHT, UP, MovingCameraScene, Text, VGroup, config

__all__ = ["StudioScene", "theme", "safe", "cue_time", "has_cue", "latex_available", "to_plain"]

_PLACEHOLDER = {
    "fps": 30,
    "width": 1920,
    "height": 1080,
    "durationSec": 10.0,
    "captionSafeArea": 0.0,
    "style": {
        "palette": {"background": "#0F172A", "surface": "#1E293B", "primary": "#38BDF8", "secondary": "#A78BFA", "accent": "#FBBF24", "text": "#F8FAFC"},
        "fontFamily": "Inter",
    },
    "cues": [],
}


def _load() -> dict:
    path = os.environ.get("STUDIO_SCENE_DATA")
    if not path:
        return _PLACEHOLDER
    with open(path, encoding="utf8") as handle:
        return json.load(handle)


DATA = _load()
FPS = float(DATA["fps"])
DURATION = float(DATA["durationSec"])
STANDALONE = "STUDIO_SCENE_DATA" not in os.environ

# What the run found out, for the studio: warnings, and when each cue was reached.
REPORT: dict = {"warnings": [], "cues": [], "builtSec": None, "durationSec": DURATION, "plainEquations": []}


def warn(message: str) -> None:
    if message not in REPORT["warnings"]:
        REPORT["warnings"].append(message)
    if STANDALONE:
        print(f"Warning: {message}", file=sys.stderr)


# ---------- Theme ----------


def _installed_fonts() -> set[str]:
    try:
        import manimpango

        return {name.lower() for name in manimpango.list_fonts()}
    except Exception:
        return set()


def _pick_font(wanted: str) -> str:
    """The video's font if this machine has it, otherwise the next one other scenes would fall back to."""
    installed = _installed_fonts()
    if not installed:
        return wanted
    for name in [wanted, "Inter", "Segoe UI", "Roboto", "Helvetica", "Arial"]:
        if name.lower() in installed:
            if name != wanted:
                warn(f'The font "{wanted}" is not installed on this machine, so Manim text uses "{name}".')
            return name
    warn(f'The font "{wanted}" is not installed on this machine, so Manim text uses the system\'s default font.')
    return "sans-serif"


class Theme:
    """The video's colours and font. Every colour is a hex string Manim accepts as a color."""

    def __init__(self, style: dict):
        palette = style["palette"]
        self.background: str = palette["background"]
        self.surface: str = palette["surface"]
        self.primary: str = palette["primary"]
        self.secondary: str = palette["secondary"]
        self.accent: str = palette["accent"]
        self.text: str = palette["text"]
        self.palette: dict[str, str] = dict(palette)
        self.font: str = _pick_font(style.get("fontFamily") or "Inter")

    def color(self, name: str) -> str:
        """A palette colour by its name, or the value itself when it is already a colour."""
        return self.palette.get(name, name)


theme = Theme(DATA["style"])


# ---------- The part of the frame that is free ----------


class SafeArea:
    """
    The part of the frame scenes should draw in, in Manim's units: the frame without a
    margin at the edges and without the strip at the bottom where captions are shown.
    """

    def __init__(self, caption_share: float, margin: float = 0.5):
        half_w = config.frame_width / 2
        half_h = config.frame_height / 2
        self.left: float = -half_w + margin
        self.right: float = half_w - margin
        self.top: float = half_h - margin
        self.bottom: float = -half_h + max(margin, caption_share * config.frame_height + 0.15)
        self.width: float = self.right - self.left
        self.height: float = self.top - self.bottom
        self.center = np.array([0.0, (self.top + self.bottom) / 2, 0.0])
        self.top_center = np.array([0.0, self.top, 0.0])
        self.bottom_center = np.array([0.0, self.bottom, 0.0])
        self.left_center = np.array([self.left, self.center[1], 0.0])
        self.right_center = np.array([self.right, self.center[1], 0.0])

    def point(self, x: float, y: float) -> np.ndarray:
        """A point inside the safe area from fractions: (0, 0) is its top left, (1, 1) its bottom right."""
        return np.array([self.left + x * self.width, self.top - y * self.height, 0.0])

    def fit(self, mobject, share: float = 1.0):
        """Scale a mobject down, if it has to be, to fit within a share of the safe area. Returns it."""
        scale = min(1.0, self.width * share / max(mobject.width, 1e-6), self.height * share / max(mobject.height, 1e-6))
        if scale < 1.0:
            mobject.scale(scale)
        return mobject


safe = SafeArea(float(DATA.get("captionSafeArea") or 0.0))


# ---------- Cues ----------


def _find_cue(cue: str, occurrence: int = 0) -> dict:
    matches = [c for c in DATA["cues"] if c["id"] == cue]
    if not matches:
        known = ", ".join(sorted({c["id"] for c in DATA["cues"]})) or "none"
        raise ValueError(f'There is no cue with the id "{cue}" in this scene\'s spec. Cues: {known}.')
    if occurrence >= len(matches):
        raise ValueError(f'The cue "{cue}" is spoken {len(matches)} time(s), so there is no occurrence {occurrence}.')
    return matches[occurrence]


def has_cue(cue: str) -> bool:
    return any(c["id"] == cue for c in DATA["cues"])


def cue_time(cue: str, occurrence: int = 0) -> float:
    """Seconds from the scene's start to the moment the cue's phrase starts being spoken."""
    return float(_find_cue(cue, occurrence)["startSec"])


# ---------- The scene ----------

# Rendered past the scene's end, so the clip never runs out a frame early.
_TAIL_FRAMES = 3


class StudioScene(MovingCameraScene):
    """
    The base of every studio Manim scene. Write build(), not construct(): the base
    paints the background, runs build(), then holds the last picture until the
    narration ends, so the clip is exactly as long as the scene.
    """

    # Manim keeps the length of the animation being played in self.duration, so the scene's own length has another name.
    length: float = DURATION

    def construct(self) -> None:
        self.camera.background_color = theme.background
        self.build()
        built = self.now
        REPORT["builtSec"] = round(built, 4)
        over = built - DURATION
        if over > 1.5 / FPS:
            warn(
                f"OVERRUN The animations take {built:.2f}s but the narration is {DURATION:.2f}s long, so the last {over:.2f}s are cut off. "
                "Shorten run_time values or remove waits."
            )
        self._wait_for(DURATION + _TAIL_FRAMES / FPS)

    def build(self) -> None:
        raise NotImplementedError("Write the scene in build(self).")

    @property
    def now(self) -> float:
        """Seconds since the scene's start."""
        return float(self.renderer.time)

    def cue_time(self, cue: str, occurrence: int = 0) -> float:
        return cue_time(cue, occurrence)

    def has_cue(self, cue: str) -> bool:
        return has_cue(cue)

    def until(self, cue: str, occurrence: int = 0, at_least: float = 0.2) -> float:
        """Seconds from now to a cue: a run_time for an animation that should end as the phrase is spoken."""
        return max(at_least, cue_time(cue, occurrence) - self.now)

    def remaining(self) -> float:
        """Seconds from now to the end of the scene."""
        return max(0.0, DURATION - self.now)

    def _wait_for(self, target: float) -> None:
        # Manim rounds each wait to whole frames, so measure again after each one.
        for _ in range(4):
            frames = round((target - self.now) * FPS)
            if frames < 1:
                return
            self.wait(frames / FPS)

    def wait_until(self, cue: str, occurrence: int = 0, lead: float = 0.0) -> None:
        """
        Hold the picture until the narrator starts saying the cue's phrase. `lead` arrives
        that many seconds early, for an animation that should be under way as the word lands.
        """
        target = cue_time(cue, occurrence) - lead
        late = self.now - target
        self._wait_for(target)
        REPORT["cues"].append({"id": cue, "occurrence": occurrence, "targetSec": round(target, 4), "reachedSec": round(self.now, 4)})
        if late > 2.5 / FPS:
            warn(
                f'LATE The cue "{cue}" is spoken at {target:.2f}s, but the animations before it run until {self.now:.2f}s, {late:.2f}s late. '
                "Shorten what comes before it, or give those animations run_time=self.until(...)."
            )

    def wait_until_time(self, seconds: float) -> None:
        """Hold the picture until a time in seconds from the scene's start."""
        self._wait_for(min(seconds, DURATION))


# ---------- Defaults that follow the theme ----------

Text.set_default(font=theme.font, color=theme.text)
for _name in ("MarkupText", "Paragraph"):
    getattr(manim, _name).set_default(font=theme.font, color=theme.text)


# ---------- Equations without LaTeX ----------


def latex_available() -> bool:
    """Whether equations can be typeset: LaTeX is installed, and the studio has not switched it off."""
    if os.environ.get("STUDIO_MANIM_LATEX") == "off":
        return False
    return bool(shutil.which("latex")) and bool(shutil.which("dvisvgm"))


_SYMBOLS = {
    "times": "×", "cdot": "·", "div": "÷", "pm": "±", "mp": "∓", "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥", "neq": "≠", "ne": "≠",
    "approx": "≈", "equiv": "≡", "sim": "~", "propto": "∝", "to": "→", "rightarrow": "→", "leftarrow": "←", "Rightarrow": "⇒",
    "Leftarrow": "⇐", "leftrightarrow": "↔", "implies": "⇒", "iff": "⇔", "infty": "∞", "partial": "∂", "nabla": "∇", "sum": "Σ",
    "prod": "Π", "int": "∫", "angle": "∠", "triangle": "△", "circ": "°", "degree": "°", "ldots": "…", "cdots": "…", "dots": "…",
    "in": "∈", "notin": "∉", "subset": "⊂", "cup": "∪", "cap": "∩", "forall": "∀", "exists": "∃", "perp": "⊥", "parallel": "∥",
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "varepsilon": "ε", "zeta": "ζ", "eta": "η", "theta": "θ",
    "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π", "rho": "ρ", "sigma": "σ", "tau": "τ",
    "upsilon": "υ", "phi": "φ", "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω", "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ",
    "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω", "quad": "  ", "qquad": "    ",
    "left": "", "right": "", "displaystyle": "", "limits": "", "big": "", "Big": "", "bigg": "", "Bigg": "",
}
_SUPER = str.maketrans("0123456789+-=()ni", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ")
_SUB = str.maketrans("0123456789+-=()aeoxhklmnpst", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜ")
_WRAPPERS = ("text", "mathrm", "mathbf", "mathit", "mathsf", "mathtt", "textbf", "textit", "textrm", "operatorname", "boldsymbol", "mathbb", "mathcal", "vec", "hat", "bar", "overline", "underline")


def _group(text: str, start: int) -> tuple[str, int]:
    """The argument that starts at `start`: a {group} or a single token. Returns it and where it ends."""
    while start < len(text) and text[start] == " ":
        start += 1
    if start >= len(text):
        return "", start
    if text[start] == "{":
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    return text[start + 1 : i], i + 1
        return text[start + 1 :], len(text)
    if text[start] == "\\":
        match = re.match(r"\\[A-Za-z]+|\\.", text[start:])
        end = start + (match.end() if match else 1)
        return text[start:end], end
    return text[start], start + 1


def _wrap(text: str) -> str:
    return f"({text})" if re.search(r"[+\-−/ ]", text.strip()) and not re.fullmatch(r"\(.*\)", text.strip()) else text


def _script(text: str, table: dict, marker: str) -> str:
    converted = text.translate(table)
    if all(ch not in text or ch in "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜ" for ch in converted) and text:
        return converted
    return f"{marker}{_wrap(text)}"


def to_plain(tex: str) -> str:
    """A LaTeX expression as plain text with Unicode symbols: what is shown when LaTeX is not installed."""
    out: list[str] = []
    i = 0
    while i < len(tex):
        ch = tex[i]
        if ch == "\\":
            match = re.match(r"\\([A-Za-z]+)", tex[i:])
            if not match:
                # "\\" is a line break, "\," and "\ " are spaces, "\%" is a percent sign.
                nxt = tex[i + 1] if i + 1 < len(tex) else ""
                out.append(" " if nxt in "\\,;:! " else nxt)
                i += 2
                continue
            name = match.group(1)
            i += match.end()
            if name in ("frac", "dfrac", "tfrac"):
                top, i = _group(tex, i)
                bottom, i = _group(tex, i)
                out.append(f"{_wrap(to_plain(top))}/{_wrap(to_plain(bottom))}")
            elif name == "sqrt":
                inner, i = _group(tex, i)
                plain = to_plain(inner)
                out.append(f"√{plain}" if len(plain) == 1 else f"√({plain})")
            elif name in _WRAPPERS:
                inner, i = _group(tex, i)
                out.append(to_plain(inner))
            elif name in ("begin", "end"):
                _, i = _group(tex, i)
            elif name in _SYMBOLS:
                out.append(_SYMBOLS[name])
            else:
                out.append(name)
        elif ch in "^_":
            inner, i = _group(tex, i + 1)
            out.append(_script(to_plain(inner), _SUPER if ch == "^" else _SUB, ch))
        elif ch == "{":
            inner, i = _group(tex, i)
            out.append(to_plain(inner))
        elif ch in "}&$":
            i += 1
        elif ch == "~":
            out.append(" ")
            i += 1
        else:
            out.append(ch)
            i += 1
    return re.sub(r" {3,}", "  ", "".join(out)).strip(" ") or " "


class PlainTex(Text):
    """
    Stands in for MathTex and Tex when LaTeX is not installed: the expression as plain
    text in the video's font. Each string given becomes one part, as with MathTex, so
    eq[0], set_color_by_tex and TransformMatchingTex keep working.
    """

    def __init__(self, *tex_strings: str, arg_separator: str = " ", font_size: float = 48, color=None, tex_to_color_map: dict | None = None, **kwargs):
        for unused in ("tex_environment", "tex_template", "substrings_to_isolate", "stroke_width", "should_center", "height", "organize_left_to_right"):
            kwargs.pop(unused, None)
        self.tex_strings = [str(s) for s in tex_strings]
        self.tex_string = arg_separator.join(self.tex_strings)
        plain = [to_plain(s) for s in self.tex_strings]
        if self.tex_string not in REPORT["plainEquations"]:
            REPORT["plainEquations"].append(self.tex_string)
        kwargs.setdefault("font", theme.font)
        super().__init__(arg_separator.join(plain) or " ", font_size=font_size * 0.9, color=color if color is not None else theme.text, disable_ligatures=True, **kwargs)
        # Manim keeps one submobject per character of the text, spaces included.
        whole = arg_separator.join(plain) or " "
        glyphs = list(self.submobjects)
        self._whole = whole if len(glyphs) == len(whole) else ""
        parts, at = [], 0
        for index, (expression, text) in enumerate(zip(self.tex_strings, plain)):
            end = at + len(text) + (len(arg_separator) if index < len(plain) - 1 else 0)
            part = VGroup(*glyphs[at:end])
            part.tex_string = expression
            parts.append(part)
            at = end
        if self._whole and len(parts) > 1:
            self.submobjects = parts
            self._parts = parts
        else:
            self._parts = []
        for tex, tint in (tex_to_color_map or {}).items():
            self.set_color_by_tex(tex, tint)

    def get_parts_by_tex(self, tex: str, substring: bool = True, case_sensitive: bool = True) -> VGroup:
        def matches(candidate: str) -> bool:
            a, b = (tex, candidate) if case_sensitive else (tex.lower(), candidate.lower())
            return a in b if substring else a == b

        return VGroup(*[part for part in self._parts if matches(part.tex_string)])

    def get_part_by_tex(self, tex: str, **kwargs):
        parts = self.get_parts_by_tex(tex, **kwargs)
        return parts[0] if len(parts) else None

    def set_color_by_tex(self, tex: str, color, **kwargs):
        found = self.get_parts_by_tex(tex, **kwargs)
        if len(found):
            found.set_color(color)
        elif to_plain(tex).strip():
            # Not a part of its own: colour the letters where it appears in the whole expression.
            wanted = to_plain(tex).strip()
            glyphs = [glyph for part in self._parts for glyph in part.submobjects] if self._parts else list(self.submobjects)
            start = self._whole.find(wanted)
            while start >= 0:
                for glyph in glyphs[start : start + len(wanted)]:
                    glyph.set_color(color)
                start = self._whole.find(wanted, start + len(wanted))
        return self

    def set_color_by_tex_to_color_map(self, texs_to_color_map: dict, **kwargs):
        for tex, tint in texs_to_color_map.items():
            self.set_color_by_tex(tex, tint, **kwargs)
        return self

    def set_opacity_by_tex(self, tex: str, opacity: float = 0.5, remaining_opacity: float | None = None, **kwargs):
        if remaining_opacity is not None:
            self.set_opacity(remaining_opacity)
        self.get_parts_by_tex(tex).set_opacity(opacity)
        return self

    def index_of_part(self, part) -> int:
        return self._parts.index(part)


def _plain_title(*text_parts: str, include_underline: bool = True, **kwargs):
    title = PlainTex(*text_parts, **kwargs).to_edge(UP)
    if include_underline:
        line = manim.Line(LEFT, RIGHT, color=theme.text).set_width(config.frame_width - 2).next_to(title, DOWN, buff=0.25)
        return VGroup(title, line)
    return title


def _plain_list(*items: str, buff: float = 0.5, **kwargs):
    kwargs.pop("dot_scale_factor", None)
    return VGroup(*[PlainTex(f"• {item}", **kwargs) for item in items]).arrange(DOWN, aligned_edge=LEFT, buff=buff)


def _use_plain_equations() -> None:
    """
    Make everything in Manim that would call LaTeX draw plain text instead: MathTex and
    Tex themselves, and what builds on them, such as the numbers on axes and DecimalNumber.
    """
    from manim.mobject.text import tex_mobject

    originals = {tex_mobject.MathTex: PlainTex, tex_mobject.Tex: PlainTex, tex_mobject.SingleStringMathTex: PlainTex, tex_mobject.Title: _plain_title, tex_mobject.BulletedList: _plain_list}
    swap = lambda value: originals.get(value, value) if isinstance(value, type) else value  # noqa: E731

    for name, module in list(sys.modules.items()):
        if module is None or not (name == "manim" or name.startswith("manim.")) or module is tex_mobject:
            continue
        for attr, value in list(vars(module).items()):
            if isinstance(value, type) and value in originals:
                setattr(module, attr, originals[value])
            if isinstance(value, type) and getattr(value, "__module__", "").startswith("manim."):
                # Defaults such as label_constructor=MathTex were fixed when the class was defined.
                for member in vars(value).values():
                    function = getattr(member, "__func__", member)
                    if not callable(function) or not hasattr(function, "__defaults__"):
                        continue
                    if function.__defaults__:
                        function.__defaults__ = tuple(swap(d) for d in function.__defaults__)
                    if function.__kwdefaults__:
                        function.__kwdefaults__ = {k: swap(d) for k, d in function.__kwdefaults__.items()}


LATEX = latex_available()
if not LATEX:
    _use_plain_equations()
else:
    for _name in ("MathTex", "Tex"):
        getattr(manim, _name).set_default(color=theme.text)
