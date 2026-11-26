# 2D Video Pipeline

A studio for making explainer videos scene by scene. You describe the video. Claude plans it, builds every scene as its own small animation, and you review each scene by itself: approve it, or say what should change and only that scene is rebuilt.

**Status:** Phases 1 and 2 of the scene studio are complete: projects, a local database, per-scene clips, your own images and video clips, an MCP server that Claude works through, parallel scene building, a GUI, and five ways to make a scene: 2D animation, 3D with react-three-fiber (including models you made in Blender), Manim, images and video clips. Long videos, sound and finishing come next (see [Roadmap](#roadmap)). The original command-line pipeline still works and is described [further down](#the-original-pipeline).

## Quick start

You need Node 22 or later, and [Claude Code](https://code.claude.com) installed and signed in (`claude` on your PATH).

```bash
npm install
npm run setup:voice     # once: installs Kokoro for the narration
npm run setup:manim     # once, optional: installs Manim for mathematical scenes
npm run studio          # opens the studio at http://localhost:4600
```

To try the whole thing without calling Claude or installing a voice, use the stand-in runner. It writes a fixed sample plan and simple scenes, with silent narration:

```bash
npm run studio -- --runner mock
```

`setup:voice` needs Python 3.10, 3.11 or 3.12 (Kokoro does not support 3.13 yet). It creates a private environment in `.venv-voice/`, installs Kokoro, and makes a test clip. The first run downloads the Kokoro model, about 330 MB. If the test clip fails on Windows, install [espeak-ng](https://github.com/espeak-ng/espeak-ng/releases) (the `.msi`) and run it again.

`setup:manim` is only needed for scenes of type `manim`. It needs Python 3.11 or later, creates `.venv-manim/`, installs [Manim Community](https://www.manim.community/) and draws a test scene. On Windows and macOS it usually needs nothing else. On Linux, Manim's text drawing is built from source, so install a compiler and Pango first: `sudo apt install build-essential python3-dev pkg-config libcairo2-dev libpango1.0-dev`. Without Manim the studio works as before and simply does not offer that scene type. Equations are typeset when LaTeX is installed ([MiKTeX](https://miktex.org/download) on Windows, MacTeX on macOS, `texlive` on Linux); without it they are shown as plain text in the video's font, such as a² + b² = c², and the scene's check says so.

On Windows, check that `claude --version` prints a version in the same terminal. If Claude Code is installed but not on your PATH, set `CLAUDE_BIN` to its full path, for example `$env:CLAUDE_BIN = "C:\Users\you\.local\bin\claude.exe"` in PowerShell.

## How a video is made

A project moves through six stages. Claude does the work of a stage, then the studio stops and waits for you. Nothing moves on until you approve it, and at every stage you can ask for changes instead.

| Stage | What Claude does | What you review |
|---|---|---|
| 1. Outline | Splits your description into chapters, each with a length | The outline and the chapter list |
| 2. Bible | Writes the rules every scene follows: voice, look, colours, motion, and the things that recur | The bible and the colour theme |
| 3. Shared parts | Builds each recurring thing once as a component, with a preview picture | Each component |
| 4. Scene list | Writes the scenes of each chapter: narration, what the viewer sees, and the scene's type | The scenes. You can edit a scene's narration, idea or type by hand |
| 5. Scenes | Records the narration, then builds every scene, several at a time. Each scene is checked, test-rendered, and rendered to its own clip | Each scene, one by one |
| 6. Video | Joins the approved clips with the narration, and writes subtitles | The finished video |

Shared parts come before any scene on purpose. A camera, a character or a recurring diagram is drawn once, so ten scenes built at the same time all show the same camera.

### Reviewing a scene

Open a scene to watch its clip with the narration, look at its test frames, read what Claude says it built, and see when each element is cued to the voice. Then:

- **Approve this scene.** Its files are locked, so nothing can change an approved scene behind your back.
- **Ask for changes.** Describe them in your own words. Claude continues the same session that built the scene, so it remembers what it did, and writes a new version. Only that scene is built and rendered again. Every earlier version is kept, and you can go back to one with a click.

Because each scene has its own clip, joining the video takes seconds. Changing one scene of a long video costs one scene's build and render, not the whole video's.

### Scene types

Each scene has a type, which decides how it is made.

| Type | What it is | Good for |
|---|---|---|
| `remotion-2d` | A 2D animation written as code with [Remotion](https://www.remotion.dev) and the library in [`packages/lib/`](packages/lib/): shapes, icons, labels and motion timed to the narration | Most scenes. The default |
| `r3f` | A 3D scene written as code with [react-three-fiber](https://r3f.docs.pmnd.rs), drawn frame by frame inside Remotion. The camera, lights and every movement are computed from the frame number | Depth, rotation, and real objects seen from a moving camera |
| `manim` | A mathematical animation written in Python with [Manim](https://www.manim.community/). Needs `npm run setup:manim` | Equations, graphs and geometry that transform step by step |
| `illustration` | One or more of your images with a slow camera move, and labels and arrows that appear on cue | A picture you already have |
| `footage` | One of your video clips, fitted to the narration by trimming, holding the last frame, slowing down or looping, with labels on top | A clip you already have, including an AI-generated one |

Whatever its type, a scene becomes the same thing: a silent clip exactly as long as its narration, with the same captions, the same palette and font, and the same entrance. That is why scenes of different types can sit next to each other in one video and be joined without re-encoding.

Claude chooses a type for each scene when it plans a chapter. Under **Plan → Kinds of scene** you choose which types it may pick from, and you can change any scene's type by hand before it is built.

### 3D scenes, and models from Blender

A 3D scene is drawn with a real 3D engine, but it obeys the same rule as every other scene: the picture depends only on the frame number. Nothing moves by itself, so a scene rendered twice gives the same frames, and the scene's check refuses the things that would break that (`useFrame`, clocks, random numbers, anything loaded from the internet). The guide Claude follows is [`packages/lib/README-3D.md`](packages/lib/README-3D.md).

To use something you modelled in Blender, such as a camera for a video about how cameras catch light:

1. In Blender, give each part you want to move or point at its own object with a clear name (`Body`, `Lens`, `Shutter`), and export with **File → Export → glTF 2.0** as a single `.glb` file. Leave compression off.
2. Drop the `.glb` under **Assets**. The studio reads it and shows what it found: the named parts, the animations, the size, and four pictures of it. It warns about unnamed parts and very heavy meshes, and refuses files it could not show (Draco or Meshopt compression, separate `.bin` or texture files) with what to change in the export.
3. Claude sees the same list and pictures. In a 3D scene it places your model, moves, hides or recolours its named parts on cue, and plays the animations you made in Blender at the moments the narration calls for them.

The model is yours and stays as you made it; Claude arranges and animates it, and builds the rest of the scene around it.

### Manim scenes

A Manim scene is a Python file. The studio gives it the video's palette and font, the part of the frame that captions leave free, and the time of every cue, so `self.wait_until("area")` holds the picture until the narrator says that phrase. The check runs the scene once without drawing it, which takes a second or two, and reports Python errors with their line, any animation still running when its cue is spoken, and anything cut off by the end of the narration. Manim then draws the scene, and the studio adds captions and overlays on top exactly as for other scenes. The guide Claude follows is [`python/manim/README.md`](python/manim/README.md).

A Manim scene may import only `manim`, `numpy`, `math` and the studio's helper, and may not read files or start programs. This is a check on the code Claude writes, to keep scenes repeatable and self-contained; it is not a security sandbox.

### Your own files, and references

Under **Assets**, drop in images, video clips, sounds and 3D models. Claude can see them and use them in `illustration`, `footage` and `r3f` scenes, so a scene that is hard to draw in code can use a clip you made elsewhere, including an AI-generated one.

Any image or clip can also be marked as a **reference** for style, layout or motion, with a note on what to take from it. A reference is a direction, not a target: Claude looks at it and follows the note, and does not try to reproduce it.

## How Claude works on a project

Each piece of work is one Claude Code session, started in the background with `claude -p`. The session gets a role (planner, art director, foundation builder, scriptwriter or scene builder), a task, and a connection to the studio's **MCP server** in [`packages/mcp/`](packages/mcp/). Everything Claude does to a project goes through that server's tools.

| Tools | Who may call them |
|---|---|
| `project_get`, `document_read`, `scene_list`, `scene_get`, `asset_list`, `asset_view`, `shared_list`, `shared_get` | Every run. They only read |
| `document_save`, `chapters_propose` | The outline run |
| `document_save`, `theme_set`, `shared_plan` | The bible run |
| `shared_save` | The shared parts run |
| `scenes_propose` | A scene list run, for its own chapter |
| `scene_save_spec`, `scene_check`, `scene_stills`, `scene_submit`, `shared_request` | A scene run, for its own scene |

The server is started for one run and knows which run it serves, so a scene run can change its own scene and nothing else. There is no tool that approves, deletes, or runs a command. A scene run may also read files, and edit the ones in its own scene folder.

A scene run saves its plan, writes the scene file (`scene.tsx`, or `scene.py` for Manim), and calls `scene_check` until the source rules and the type checker pass. Then it renders test frames with `scene_stills`, looks at them, fixes what it sees, and hands over with `scene_submit`. If a scene needs something that should be shared, it files a `shared_request` for you instead of drawing a private copy.

### Speed

- **Scenes are built in parallel.** Three Claude runs and two renders at a time by default (`studio.lanes` in the settings). More is faster and uses your plan faster.
- **Nothing is done twice.** A scene's narration is recorded again only if its text or the voice settings change. A clip is rendered again only if the scene, its timing, the theme or a shared part it imports changes.
- **A changed shared part marks exactly the scenes that use it as out of date**, and they are rendered again when you ask.

## Command line

Everything the GUI does is also a command, which is useful for scripts.

```bash
npm run studio -- new "How noise-cancelling headphones work" --minutes 3
npm run studio -- status <project>          # where it stands and what it waits on
npm run studio -- approve <project>         # approve the current stage and start the next
npm run studio -- start <project> --notes "Open with the hum on a plane"   # ask for changes to the current stage
npm run studio -- scenes <project>
npm run studio -- revise <project> 1.3 --notes "Make the label larger"
npm run studio -- approve-scene <project> all
npm run studio -- assemble <project> --final
npm run studio -- asset add <project> photo.png --reference style --note "the colours, not the people"
npm run studio -- import examples/how-gps-works     # bring a pipeline production in as a project
npm run studio -- --help
```

A scene is named by its label, such as `1.3`, or by its id.

## Where things are kept

Projects live in a **workspace** folder outside the repository: `~/VideoStudio` by default, or `--workspace`, `STUDIO_WORKSPACE`, or `studio.workspace` in the settings.

```
<workspace>/
  studio.db                      SQLite: projects, chapters, scenes and their versions, assets, runs, reviews, clips, renders
  projects/<project>/
    assets/                      your images, clips and sounds, stored once by content
    shared/components/           the current shared parts, imported by scenes as "@shared/<Name>"
    shared/versions/, previews/  every saved version of each shared part, and its preview picture
    voice/<scene>/               the narration, one file per wording
    scenes/<scene>/v1/, v2/ ...  one folder per version: spec.json, scene.tsx or scene.py, stills/, clip-*.mp4, review-*.mp4
    renders/                     assembled videos and their .srt subtitles
    runs/                        the log of every Claude run
```

The database is the record of what exists and what state it is in. The files are the things themselves, so you can open any scene file or clip directly.

The GUI's server listens on your own computer only (`127.0.0.1`) and refuses requests that come from other websites.

### Studio settings

In [`pipeline.config.json`](pipeline.config.json), under `studio`. The voice and render settings described below apply to the studio too.

| Setting | Default | What it does |
|---|---|---|
| `studio.workspace` | `~/VideoStudio` | Where the database and projects live |
| `studio.port` | `4600` | Port of the GUI. Also `--port` or `STUDIO_PORT` |
| `studio.lanes.agents` | `3` | Claude runs at the same time |
| `studio.lanes.renders` | `2` | Scene renders at the same time. Each one runs a browser, so memory is the limit |
| `studio.lanes.light` | `1` | Short jobs, such as recording narration and joining clips |
| `studio.modelTriangleBudget` | `300000` | A 3D model with more triangles than this gets a warning when added: it renders, but slowly |
| `render.gl` | empty | How Chrome draws 3D scenes. Empty tries the graphics card (`angle`) and falls back to software (`swangle`), which is slower but works anywhere. Also `REMOTION_GL` |
| `render.manim.python` | empty | Python to run Manim with. Empty means the one `setup:manim` installed. Also `MANIM_PYTHON` |
| `render.manim.timeoutSec` | `600` | How long Manim may take to draw one scene before it is stopped |
| `render.manim.latex` | `auto` | `off` shows equations as plain text even when LaTeX is installed |
| `runner` | `claude-cli` | `mock` writes fixed samples instead of calling Claude. Also `--runner` or `PIPELINE_RUNNER` |
| `model` | `opus` | Model for every run. Also `--model` or `PIPELINE_MODEL` |

## Development

```bash
npm test            # the studio and the original pipeline
npm run typecheck   # the studio, the Remotion library and the GUI
```

Tests that render real video run only when `REMOTION_BROWSER_EXECUTABLE` points to a Chrome, and tests of Manim scenes only where Manim is installed (after `npm run setup:manim`, or with `MANIM_PYTHON` set):

```bash
REMOTION_BROWSER_EXECUTABLE=/path/to/chrome npm test
```

Code map:

- `packages/core/src/studio/`: the studio. `db/` and `store/` hold the database and everything kept in it, `model/` the scene format, `renderers/` and `scenes/` turn a scene into stills and a clip, `assemble.ts` joins clips, `tools/` are the tools Claude calls, `runs/` starts Claude and holds the prompts, and `workflow.ts` runs the stages, the queue and the approvals
- `packages/mcp/`: the MCP server that gives a Claude run its tools
- `packages/server/`: the local server behind the GUI
- `packages/web/`: the GUI, a React app that the server bundles when it starts
- `packages/cli/`: the `studio` and `pipeline` commands
- `packages/lib/`: the Remotion library scenes are written with, and its manual. `src/three/` is the 3D half
- `python/manim/`: what Manim scenes build on, the code that checks and runs them, and their manual
- `packages/core/src/` outside `studio/`: the original pipeline, and the voice and render code both share

## Roadmap

1. **Scene studio** (done): projects and database, per-scene clips, images and footage, MCP server, shared parts, parallel scene runs, GUI
2. **More ways to make a scene** (done): 3D scenes with react-three-fiber, models from Blender as glTF, and Manim
3. **Long videos**: chapters that are planned and assembled one at a time, and a queue that copes with hundreds of scenes
4. **Consistency and sound**: stronger use of references and recurring characters, sound effects and music
5. **Finishing**: comparing versions side by side, and export options

Remotion is free for individuals and companies of up to three people. Larger companies need a [Remotion company license](https://www.remotion.dev/license).

## The original pipeline

The pipeline the studio grew out of is still here. It makes a whole video in one pass from the command line, with a fixed team of agents and an approval after each stage, and keeps everything in a production folder inside the repository. The studio reuses its voice and render code, and `npm run studio -- import <production-folder>` turns a finished production into a studio project.

### How it works

```
prompt ─▶ Brief ─▶ [you approve] ─▶ Research + Script ─▶ [you approve] ─▶ Storyboard ─▶ [you approve]
            │                          │        ▲                             │      ▲
         Producer             Researcher, Scriptwriter                 Storyboard artist
                                       └─ Director review ┘                   └ Director ┘

       ─▶ Voiceover ─▶ [you approve] ─▶ Animation ─▶ [you approve] ─▶ Final render ─▶ [you approve]
              │                             │      ▲                       │
            Kokoro                     Animator: draft, check, fix      Remotion
                                         └ test frames ┘
```

Every video gets its own **production folder**. Each agent reads the files written before it and writes its own, and you review those same files. Nothing is hidden inside an agent's memory.

| Agent | Writes | Job |
|---|---|---|
| Producer | `brief.json` | Turns your prompt into a creative brief: audience, goal, tone, length, key takeaways, voice |
| Researcher | `research.md` | Searches the web and writes a fact sheet with a source for every fact |
| Scriptwriter | `script.json` | Writes narration for the ear, split into scenes of 8 to 20 seconds |
| Director | `director-notes/` | Reviews the script and the storyboard, and sends notes back for revision before you see them |
| Storyboard artist | `storyboard.json` | Plans each scene for flat 2D animation: style guide, elements, and animations cued to exact narration phrases |
| Animator | `scenes/s01.tsx`, ... | Writes each scene as a Remotion component, then checks its own test frames and fixes what it sees |

The pipeline code runs the stages in a fixed order and stops at every approval. Agents never move on by themselves. Approved stages are saved, so you can stop at any point and resume later, and a failed agent run resumes from the stage it was in.

Every file is validated against a schema in [`packages/core/src/schemas.ts`](packages/core/src/schemas.ts). If an agent writes an invalid file, it gets the errors and is asked to fix it. The storyboard is also checked against the script: the scene ids must match, and every animation cue must be a phrase the narrator actually says, so the visuals can be timed to the voice in a later phase.

### Voiceover and voice settings

After you approve the storyboard, the Voiceover stage records the narration with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), a free text-to-speech model that runs on your own computer. No AI agent is involved, so it costs nothing.

1. **Respellings.** Words listed in `pronunciations.json` are replaced with how they should be said, for example `"GPS": "G P S"`. Matching is whole-word and case-sensitive. Add your own.
2. **One audio file per scene.** `voice/s01.wav`, `voice/s02.wav` and so on, each with a short pause before and after, plus `voice/full.wav` with every scene joined so you can listen to the whole video.
3. **Timings.** `voiceover.json` records each scene's real length and when every word is spoken, and finds when each storyboard cue phrase is said. The animation stage uses this to sync visuals to the voice. A cue that cannot be found in the spoken words gets an estimated time, and the review lists it.

To pick a voice by ear:

```bash
npm run pipeline -- voices                       # writes voice-auditions/<voice>.wav for each audition voice
npm run pipeline -- voices --text "Your own sentence"
```

At the review you see each scene's real length next to the script's estimate. To change something, edit and choose **e**: the voice or pace for this video in `brief.json`, base speed and pauses in `pipeline.config.json`, respellings in `pronunciations.json`, or wording in `script.json`. Or choose **r** and describe wording changes; the Scriptwriter edits only those scenes. Only scenes whose text or voice settings changed are recorded again, and if the new wording breaks a storyboard cue, the Storyboard artist updates it.

#### Settings

All settings live in [`pipeline.config.json`](pipeline.config.json). The voice and pace in a video's `brief.json` override the defaults for that video.

| Setting | Default | What it does |
|---|---|---|
| `voice.engine` | `kokoro` | `mock` writes silent audio, for testing. `--runner mock` uses it automatically |
| `voice.voice` | `af_heart` | Default Kokoro voice. The Producer puts it in each brief unless your request asks for another |
| `voice.speed` | `1.0` | Base speaking speed |
| `voice.paceSpeed` | slow `0.9`, normal `1.0`, fast `1.1` | The brief's pace multiplies the base speed by these |
| `voice.language` | `auto` | Picked from the voice name (`af_`/`am_` American English, `bf_`/`bm_` British). Or set `en-us`, `en-gb`, or a Kokoro code |
| `voice.padBeforeSec`, `voice.padAfterSec` | `0.3`, `0.3` | Silence before and after each scene |
| `voice.sampleRate` | `24000` | Kokoro speaks at 24000 Hz; other rates are resampled |
| `voice.pronunciationsFile` | `pronunciations.json` | The respelling list |
| `voice.timing` | `kokoro` | Where word timings come from. Whisper alignment can be added if Kokoro's timings prove too rough |
| `voice.python` | empty | Python to run Kokoro with. Empty means the one `setup:voice` installed |
| `voice.auditionVoices`, `voice.auditionText` | 7 voices, one sentence | What the `voices` command plays |

The file also holds `runner`, `model` and `maxDirectorRounds`. Environment variables (`PIPELINE_RUNNER`, `PIPELINE_MODEL`, `PIPELINE_PYTHON`, `PIPELINE_VOICE_ENGINE`) and command-line flags override the file. `PIPELINE_CONFIG` points to a different config file.

### Animation and render

The video is made with [Remotion](https://www.remotion.dev): every scene is a small React component that draws flat 2D motion graphics (shapes, icons, diagrams, labels) frame by frame. The pipeline puts the scenes in order, plays each scene's narration, applies the storyboard's entrance transitions and camera moves, and burns in captions.

**The shared library** in [`packages/lib/`](packages/lib/) gives the Animator building blocks so every scene starts from tested parts: the storyboard's palette and font, 24 flat icons, self-drawing arrows, paths and rings, labels, titles, pulse rings, and timing helpers such as `useCueAppear("pin")`, which starts an animation the moment the narrator says that element's cue phrase. [`packages/lib/README.md`](packages/lib/README.md) is the Animator's manual. Remotion's own [agent skills](https://www.remotion.dev/docs/ai/skills) are installed in `.claude/skills/`, and the Animator loads them when it needs more than the library.

**Animation stage.** For each scene, the Animator writes `scenes/sNN.tsx`. Then the pipeline checks it, without any AI:

1. Source rules: only the allowed imports, no `Math.random()`, no CSS animations, nothing from the internet.
2. Type check with TypeScript.
3. Render test frames to `render/stills/`: just after each cue lands, and near the end of the scene.

If a check fails, the Animator gets the errors and fixes them. When the scene renders cleanly, the Animator opens the test frames and looks for missing elements, overlaps, text that is cut off or too small, and anything under the captions, and fixes what it finds. This repeats for up to `animator.maxFixRounds` rounds. A scene that still fails is swapped for a simple stand-in that lays out its elements, so the video always renders; the Animator's version is kept in `scenes/broken/` and the review flags it.

Then the whole video is rendered at half size to `render/preview.mp4`. The review lists each scene's result and the Animator's notes. To change things, choose **r** and describe them. Name scenes as `s03` or `scene 3` (or `scenes 2-4`) and only those scenes are redone; notes that name no scene go to every scene. You can also edit `scenes/*.tsx` yourself and choose **e**: your edits are type-checked, test-rendered and previewed.

To scrub through the video frame by frame, open it in Remotion Studio:

```bash
npm run pipeline -- studio <production-id>
```

**Final render stage.** Renders the full-size video to `final/<title>.mp4`, with the narration, burned-in captions and music if you set it, plus `final/<title>.srt` subtitles for uploading. Notes with **r** go to the Animator and the video is rendered again. To change render settings, edit `pipeline.config.json` and choose **e**.

The first render downloads a headless Chrome for Remotion (about 100 MB). To use a Chrome you already have, set `render.browserExecutable` or `REMOTION_BROWSER_EXECUTABLE`.

#### Render settings

| Setting | Default | What it does |
|---|---|---|
| `render.fps` | `30` | Frames per second |
| `render.resolution` | `1080` | Short side in pixels: 1920x1080 for 16:9, 1080x1920 for 9:16, 1080x1080 for 1:1 (from the brief) |
| `render.previewScale`, `render.stillScale` | `0.5`, `0.5` | Size of the preview and the test frames, as a fraction of full size |
| `render.codec` | `h264` | Also `h265`, `vp8`, `vp9` (WebM) or `prores` (MOV) |
| `render.crf`, `render.previewCrf` | `18`, `30` | Quality of the final video and the preview. Lower is better and bigger |
| `render.concurrency` | empty | Frames rendered at once. Empty lets Remotion choose |
| `render.browserExecutable` | empty | Chrome to render with. Empty means Remotion downloads its own |
| `render.transitionSec` | `0.4` | Length of each scene's entrance transition |
| `render.outputDir` | `final` | Where the final video goes, inside the production folder |
| `render.captions.enabled` | `true` | Burn captions into the video |
| `render.captions.fontSize`, `.position` | `54`, `bottom` | Caption size, and `bottom` or `top` |
| `render.captions.highlight` | `accent` | Colour of the word being spoken: a palette key or a hex colour |
| `render.captions.combineWithinMs` | `1200` | Words spoken within this time share a caption line |
| `render.music.file`, `render.music.volume` | empty, `0.12` | Background music file (relative to the repo root), looped under the narration. Empty means no music |
| `animator.maxFixRounds` | `3` | Check-and-fix rounds per scene after the first draft |
| `animator.stillsPerScene` | `3` | Test frames per scene for each check |
| `animator.parallelScenes` | `1` | Scenes animated at the same time. Faster, but uses your plan faster |

### Running agents: three runners

Each agent is a Claude Code session with its own role, tools and task. How those sessions run is a setting:

| Runner | Signs in with | Use it for |
|---|---|---|
| `claude-cli` (default) | Your Claude Code login (Pro or Max plan). Runs `claude -p` for each agent | Building and testing without paying per use. Your plan's usage limits apply |
| `agent-sdk` | `ANTHROPIC_API_KEY`, billed per use. Uses the Claude Agent SDK | Running unattended or at higher volume |
| `mock` | Nothing. Writes sample "How GPS works" files, and a simple generic scene for each animation | Testing the flow, approvals and file handling for free |

Choose with `--runner <name>` or the `PIPELINE_RUNNER` environment variable. Agents use the `opus` model by default; change it with `--model sonnet` or `PIPELINE_MODEL`.

### Usage

```bash
# Start a new video
npm run pipeline -- new "Explain how GPS works for curious teenagers, about 75 seconds"

# Or put a longer request in a file
npm run pipeline -- new --file my-request.md

# Resume a production you paused
npm run pipeline -- run 2026-11-18-explain-how-gps-works-for

# See where a production is
npm run pipeline -- status 2026-11-18-explain-how-gps-works-for
npm run pipeline -- list

# Try the whole flow for free, with sample files
npm run pipeline -- new "How GPS works" --runner mock
```

At each review you see a summary and the file paths, and choose:

- **a**: approve and move to the next stage
- **r**: request changes. Type your notes; the agents revise and the Director reviews again. The previous version is kept in `history/`
- **e**: edit the files yourself, then press Enter. Your edits are validated
- **q**: stop here and resume later with `run <id>`

### Example output

[`examples/how-gps-works/`](examples/how-gps-works/) holds a real pre-production run, made with the `claude-cli` runner and Opus from the prompt "Make an explainer video on how GPS works". It has the brief, research, a 7-scene script (about 79 seconds), the storyboard and the Director's reviews. The Director sent the storyboard back once, and the Storyboard artist fixed 3 scenes. The run took 8 agent runs, about 8 minutes, and Claude Code reported an equivalent API cost of about $2.

`examples/how-gps-works/scenes/` holds the Animator's 7 scenes for that storyboard, from a real run with Opus (the voice was a silent stand-in, because Kokoro could not be installed where it ran). With 4 scenes at a time, the animation stage took about 15 minutes and 21 agent runs, and Claude Code reported an equivalent API cost of about $10. The checks caught type errors in 3 scenes, and the Animator's look at its test frames led it to fix 3 more: faint signal rings, a dot cut off by the phone screen, and a tilted map leaving the safe area. `animation-status.json` has its notes.

### Production folder

```
productions/<id>/
  prompt.md          your request
  inputs/            your images and reference files (used in later phases)
  brief.json         Producer
  research.md        Researcher
  script.json        Scriptwriter
  storyboard.json    Storyboard artist
  director-notes/    Director reviews, per revision and round
  voice/             Kokoro audio: s01.wav, s02.wav, ... and full.wav
  voiceover.json     real scene lengths, word timings and cue timings
  scenes/            Animator: one Remotion component per scene, and its last self-review
  render/            generated Remotion project, test frames (stills/), preview.mp4, animation-status.json
  final/             the finished video and its .srt subtitles
  history/           earlier versions, saved before each revision
  logs/              one record per agent run, with its prompt, reply and reported cost
  state.json         which stages are approved
```
