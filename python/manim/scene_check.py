"""Reads a Manim scene's code without running it and lists what the studio does not allow.

A scene may import only manim, numpy, math and pipeline_manim, may not touch files, the
network or other programs, and must define `class Main(StudioScene)` with a build()
method. This keeps a scene to drawing: the same code and narration always give the same
clip. It needs only Python's standard library.
"""

from __future__ import annotations

import ast

ALLOWED_MODULES = ("manim", "numpy", "math", "pipeline_manim")

# Calls that run other code, read input, or reach the file system.
BANNED_CALLS = {
    "open": "Scenes may not read or write files.",
    "exec": "Scenes may not run code from text.",
    "eval": "Scenes may not run code from text.",
    "compile": "Scenes may not run code from text.",
    "__import__": "Import modules with an import statement at the top of the file.",
    "input": "Scenes cannot ask for input.",
    "breakpoint": "Remove the breakpoint.",
    "globals": "Scenes may not reach into the interpreter.",
    "vars": "Scenes may not reach into the interpreter.",
    "getattr": "Use the attribute directly, so the check can see what the scene uses.",
    "setattr": "Set the attribute directly, so the check can see what the scene changes.",
    "print": "Remove print(); nothing reads a scene's output.",
}

# Attributes that read or write files, whatever object they are called on.
BANNED_ATTRIBUTES = {
    "load": "numpy.load reads a file",
    "save": "numpy.save writes a file",
    "savez": "numpy.savez writes a file",
    "savez_compressed": "numpy.savez_compressed writes a file",
    "loadtxt": "numpy.loadtxt reads a file",
    "savetxt": "numpy.savetxt writes a file",
    "genfromtxt": "numpy.genfromtxt reads a file",
    "fromfile": "numpy.fromfile reads a file",
    "tofile": "tofile writes a file",
    "memmap": "numpy.memmap opens a file",
    "add_sound": "sound is added when the video is assembled, not by a scene",
    "interactive_embed": "scenes are rendered without a window",
    "next_section": "a studio scene is one section",
}

# Names from manim that load files or change how the scene is rendered.
BANNED_NAMES = {
    "ImageMobject": "Manim scenes cannot load image files yet. Draw it with shapes, or use a scene of another type for images.",
    "SVGMobject": "Manim scenes cannot load SVG files yet. Draw it with shapes.",
    "config": "The studio sets the frame size, frame rate and background. Use `safe` and `theme` from pipeline_manim instead of manim's config.",
    "tempconfig": "The studio sets the frame size, frame rate and background.",
    "ThreeDScene": "Manim scenes are 2D here. Use a scene of type r3f for 3D.",
    "Code": "The Code mobject reads files and needs extra packages. Use Text with a monospace font.",
}


def _root(name: str) -> str:
    return name.split(".")[0]


def check_source(code: str, cue_ids: list[str] | None = None) -> list[str]:
    try:
        tree = ast.parse(code)
    except SyntaxError as err:
        return [f"line {err.lineno}: syntax error: {err.msg}"]

    problems: list[str] = []
    add = lambda node, text: problems.append(f"line {getattr(node, 'lineno', '?')}: {text}")  # noqa: E731

    main = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _root(alias.name) not in ALLOWED_MODULES:
                    add(node, f'"import {alias.name}" is not allowed. Scenes may import only: {", ".join(ALLOWED_MODULES)}.')
        elif isinstance(node, ast.ImportFrom):
            if node.level or _root(node.module or "") not in ALLOWED_MODULES:
                add(node, f'"from {"." * node.level}{node.module or ""} import ..." is not allowed. Scenes may import only: {", ".join(ALLOWED_MODULES)}.')
            for alias in node.names:
                if alias.name in BANNED_NAMES:
                    add(node, f"{alias.name}: {BANNED_NAMES[alias.name]}")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in BANNED_CALLS:
            add(node, f"{node.func.id}(): {BANNED_CALLS[node.func.id]}")
        elif isinstance(node, ast.Name) and node.id in BANNED_NAMES and isinstance(node.ctx, ast.Load):
            add(node, f"{node.id}: {BANNED_NAMES[node.id]}")
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("__") and node.attr.endswith("__") and node.attr != "__init__":
                add(node, f"{node.attr}: scenes may not reach into Python's internals.")
            elif node.attr in BANNED_ATTRIBUTES:
                add(node, f".{node.attr}: {BANNED_ATTRIBUTES[node.attr]}.")
            elif node.attr == "random" and isinstance(node.value, ast.Name) and node.value.id in ("np", "numpy"):
                pass  # numpy's random numbers are seeded by the studio, so they repeat.
        elif isinstance(node, ast.ClassDef) and node.name == "Main":
            main = node

    if main is None:
        problems.append("The file must define the scene as: class Main(StudioScene)")
    else:
        bases = [b.id if isinstance(b, ast.Name) else b.attr if isinstance(b, ast.Attribute) else "" for b in main.bases]
        if "StudioScene" not in bases:
            add(main, "Main must extend StudioScene from pipeline_manim: class Main(StudioScene)")
        methods = {n.name: n for n in main.body if isinstance(n, ast.FunctionDef)}
        if "build" not in methods:
            add(main, "Main needs a build(self) method that draws the scene.")
        if "construct" in methods:
            add(methods["construct"], "Write build(self), not construct(self): the studio's construct() sets the background and fits the scene to the narration.")

    if cue_ids is not None:
        known = set(cue_ids)
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) or isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
                continue
            name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id
            if name not in ("wait_until", "cue_time", "until", "has_cue") or not node.args:
                continue
            first = node.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str) and first.value not in known and name != "has_cue":
                listed = ", ".join(sorted(known)) or "none"
                add(node, f'{name}("{first.value}"): there is no cue with that id in the scene\'s spec. Cues: {listed}.')

    # The same line can be reported once per rule, but not twice for one rule.
    return list(dict.fromkeys(problems))
