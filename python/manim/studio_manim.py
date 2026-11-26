"""The studio's way into Manim. Reads one job as JSON on stdin and answers with one line:

    STUDIO_RESULT {"ok": true, ...}

Jobs:
  {"mode": "probe"}                         what is installed: Manim's version, LaTeX, the fonts' fallback
  {"mode": "check", "source", "data"}       read the code, then run it without drawing to find errors and timing
  {"mode": "render", "source", "data", "output", "width", "height", "mediaDir"}
                                            draw the scene to a silent video
"data" is the path of the scene's data file (see pipeline_manim).
"""

from __future__ import annotations

import importlib.util
import json
import os
import random
import shutil
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from scene_check import check_source  # noqa: E402


def answer(result: dict) -> None:
    sys.stdout.write("\nSTUDIO_RESULT " + json.dumps(result) + "\n")
    sys.stdout.flush()


def scene_error(err: BaseException, source: Path) -> str:
    """The error as one line an agent can act on: where in the scene file it happened, and what it was."""
    frames = [f for f in traceback.extract_tb(err.__traceback__) if Path(f.filename).resolve() == source.resolve()]
    where = f"line {frames[-1].lineno}: " if frames else ""
    if isinstance(err, SyntaxError) and err.filename and Path(err.filename).resolve() == source.resolve():
        where = f"line {err.lineno}: "
    text = str(err).strip() or type(err).__name__
    first = text.splitlines()[0]
    return f"{where}{type(err).__name__}: {first}"


def configure(job: dict, data: dict, dry: bool) -> None:
    from manim import config

    width = int(job.get("width") or data["width"])
    height = int(job.get("height") or data["height"])
    config.pixel_width = width
    config.pixel_height = height
    config.frame_rate = data["fps"]
    config.frame_height = 8.0
    config.frame_width = 8.0 * width / height
    config.background_color = data["style"]["palette"]["background"]
    config.verbosity = "ERROR"
    config.progress_bar = "none"
    config.disable_caching = True
    config.media_dir = str(job.get("mediaDir") or (Path(job["source"]).parent / ".manim"))
    config.output_file = "scene"
    if dry:
        config.dry_run = True
    else:
        config.write_to_movie = True
        config.format = "mp4"
        # Close to lossless: the studio encodes the clip again with captions on top.
        if hasattr(config, "video_encoder_options"):
            config.video_encoder_options = {"crf": "12", "preset": "fast"}


def run(job: dict, dry: bool) -> dict:
    source = Path(job["source"])
    with open(job["data"], encoding="utf8") as handle:
        data = json.load(handle)
    code = source.read_text(encoding="utf8")
    problems = check_source(code, sorted({c["id"] for c in data["cues"]}))
    if problems:
        return {"ok": False, "problems": problems}

    os.environ["STUDIO_SCENE_DATA"] = str(job["data"])
    if job.get("latex") is False:
        os.environ["STUDIO_MANIM_LATEX"] = "off"
    import numpy as np

    configure(job, data, dry)
    import pipeline_manim

    try:
        spec = importlib.util.spec_from_file_location("studio_scene", source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        main = getattr(module, "Main")
        if not (isinstance(main, type) and issubclass(main, pipeline_manim.StudioScene)):
            return {"ok": False, "problems": ["Main must extend StudioScene from pipeline_manim."]}
        # The same numbers on every run, so a preview and the final render match.
        random.seed(0)
        np.random.seed(0)
        scene = main()
        scene.render()
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "problems": [scene_error(err, source)], "trace": traceback.format_exc()[-4000:]}

    report = pipeline_manim.REPORT
    result = {
        "ok": True,
        "problems": [],
        "warnings": report["warnings"],
        "cues": report["cues"],
        "builtSec": report["builtSec"],
        "durationSec": report["durationSec"],
        "plainEquations": report["plainEquations"],
        "latex": pipeline_manim.LATEX,
        "font": pipeline_manim.theme.font,
    }
    if not dry:
        movie = Path(scene.renderer.file_writer.movie_file_path)
        output = Path(job["output"])
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(movie), str(output))
        result["output"] = str(output)
        result["frames"] = int(round(scene.renderer.time * data["fps"]))
    return result


def probe() -> dict:
    import manim

    return {"ok": True, "manim": manim.__version__, "python": sys.version.split()[0], "latex": bool(shutil.which("latex")) and bool(shutil.which("dvisvgm"))}


def main() -> None:
    job = json.load(sys.stdin)
    mode = job.get("mode")
    try:
        if mode == "probe":
            answer(probe())
        elif mode == "lint":
            answer({"ok": True, "problems": check_source(Path(job["source"]).read_text(encoding="utf8"), job.get("cues"))})
        elif mode in ("check", "render"):
            answer(run(job, dry=mode == "check"))
        else:
            answer({"ok": False, "problems": [f'Unknown mode "{mode}".']})
    except ModuleNotFoundError as err:
        answer({"ok": False, "missing": err.name, "problems": [f"The Python module {err.name} is not installed."]})
    except Exception as err:  # noqa: BLE001
        answer({"ok": False, "problems": [f"{type(err).__name__}: {err}"], "trace": traceback.format_exc()[-4000:]})


if __name__ == "__main__":
    main()
