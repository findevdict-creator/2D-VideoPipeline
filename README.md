# 2D Video Pipeline

An automated pipeline that turns a prompt into a 2D animated explainer video, with a team of AI agents doing the work and a human approving each stage.

**Status:** The explainer pipeline is complete from prompt to final MP4: pre-production, voiceover (Kokoro), animation and render (Remotion).

## How it works

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

Every file is validated against a schema in [`src/schemas.ts`](src/schemas.ts). If an agent writes an invalid file, it gets the errors and is asked to fix it. The storyboard is also checked against the script: the scene ids must match, and every animation cue must be a phrase the narrator actually says, so the visuals can be timed to the voice in a later phase.

## Voiceover

After you approve the storyboard, the Voiceover stage records the narration with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), a free text-to-speech model that runs on your own computer. No AI agent is involved, so it costs nothing.

1. **Respellings.** Words listed in `pronunciations.json` are replaced with how they should be said, for example `"GPS": "G P S"`. Matching is whole-word and case-sensitive. Add your own.
2. **One audio file per scene.** `voice/s01.wav`, `voice/s02.wav` and so on, each with a short pause before and after, plus `voice/full.wav` with every scene joined so you can listen to the whole video.
3. **Timings.** `voiceover.json` records each scene's real length and when every word is spoken, and finds when each storyboard cue phrase is said. The animation stage uses this to sync visuals to the voice. A cue that cannot be found in the spoken words gets an estimated time, and the review lists it.

At the review you see each scene's real length next to the script's estimate. To change something, edit and choose **e**: the voice or pace for this video in `brief.json`, base speed and pauses in `pipeline.config.json`, respellings in `pronunciations.json`, or wording in `script.json`. Or choose **r** and describe wording changes; the Scriptwriter edits only those scenes. Only scenes whose text or voice settings changed are recorded again, and if the new wording breaks a storyboard cue, the Storyboard artist updates it.

### Settings

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

## Animation and render

The video is made with [Remotion](https://www.remotion.dev): every scene is a small React component that draws flat 2D motion graphics (shapes, icons, diagrams, labels) frame by frame. The pipeline puts the scenes in order, plays each scene's narration, applies the storyboard's entrance transitions and camera moves, and burns in captions.

**The shared library** in [`remotion/lib/`](remotion/lib/) gives the Animator building blocks so every scene starts from tested parts: the storyboard's palette and font, 24 flat icons, self-drawing arrows, paths and rings, labels, titles, pulse rings, and timing helpers such as `useCueAppear("pin")`, which starts an animation the moment the narrator says that element's cue phrase. [`remotion/lib/README.md`](remotion/lib/README.md) is the Animator's manual. Remotion's own [agent skills](https://www.remotion.dev/docs/ai/skills) are installed in `.claude/skills/`, and the Animator loads them when it needs more than the library.

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

Remotion is free for individuals and companies of up to three people. Larger companies need a [Remotion company license](https://www.remotion.dev/license).

### Render settings

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

## Running agents: three runners

Each agent is a Claude Code session with its own role, tools and task. How those sessions run is a setting:

| Runner | Signs in with | Use it for |
|---|---|---|
| `claude-cli` (default) | Your Claude Code login (Pro or Max plan). Runs `claude -p` for each agent | Building and testing without paying per use. Your plan's usage limits apply |
| `agent-sdk` | `ANTHROPIC_API_KEY`, billed per use. Uses the Claude Agent SDK | Running unattended or at higher volume |
| `mock` | Nothing. Writes sample "How GPS works" files, and a simple generic scene for each animation | Testing the flow, approvals and file handling for free |

Choose with `--runner <name>` or the `PIPELINE_RUNNER` environment variable. Agents use the `opus` model by default; change it with `--model sonnet` or `PIPELINE_MODEL`.

## Setup

You need Node 20 or later, and for the default runner, [Claude Code](https://code.claude.com) installed and signed in (`claude` on your PATH).

```bash
npm install
npm run setup:voice     # once: installs Kokoro for the voiceover
```

`setup:voice` needs Python 3.10, 3.11 or 3.12 (Kokoro does not support 3.13 yet). It creates a private environment in `.venv-voice/`, installs Kokoro, and makes a test clip. The first run downloads the Kokoro model, about 330 MB. If the test clip fails on Windows, install [espeak-ng](https://github.com/espeak-ng/espeak-ng/releases) (the `.msi`) and run it again.

Then pick a voice by ear:

```bash
npm run pipeline -- voices                       # writes voice-auditions/<voice>.wav for each audition voice
npm run pipeline -- voices --text "Your own sentence"
```

On Windows, check that `claude --version` prints a version in the same terminal (PowerShell or Command Prompt). If Claude Code is installed but not on your PATH, point the pipeline at it, for example `$env:CLAUDE_BIN = "C:\Users\you\.local\bin\claude.exe"` in PowerShell.

## Usage

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

## Example output

[`examples/how-gps-works/`](examples/how-gps-works/) holds a real pre-production run, made with the `claude-cli` runner and Opus from the prompt "Make an explainer video on how GPS works". It has the brief, research, a 7-scene script (about 79 seconds), the storyboard and the Director's reviews. The Director sent the storyboard back once, and the Storyboard artist fixed 3 scenes. The run took 8 agent runs, about 8 minutes, and Claude Code reported an equivalent API cost of about $2.

`examples/how-gps-works/scenes/` holds the Animator's 7 scenes for that storyboard, from a real run with Opus (the voice was a silent stand-in, because Kokoro could not be installed where it ran). With 4 scenes at a time, the animation stage took about 15 minutes and 21 agent runs, and Claude Code reported an equivalent API cost of about $10. The checks caught type errors in 3 scenes, and the Animator's look at its test frames led it to fix 3 more: faint signal rings, a dot cut off by the phone screen, and a tilted map leaving the safe area. `animation-status.json` has its notes.

## Production folder

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

## Development

```bash
npm test            # pipeline flow, revisions, pause and resume, validation, claude-cli runner, voiceover, animation
npm run typecheck   # the pipeline and the Remotion library
```

The test that renders a full video runs only when `REMOTION_BROWSER_EXECUTABLE` points to a Chrome:

```bash
REMOTION_BROWSER_EXECUTABLE=/path/to/chrome npm test
```

Code map:

- `src/agents/definitions.ts`: each agent's role, rules and tools
- `src/stages/`: what each stage asks its agents to do, how it is summarised for review, and the Director review loop
- `src/pipeline.ts`: runs stages in order with approvals, revisions, and pause and resume
- `src/runners/`: the three ways to run an agent
- `src/schemas.ts`: the file formats shared between agents
- `src/voice/` and `voice/kokoro_tts.py`: respellings, cue timing, and the bridge to Kokoro
- `remotion/lib/`: the shared Remotion library and the Animator's manual
- `src/render/`: builds each production's Remotion project, checks scenes, runs the Animator's check-and-fix loop, and renders

## Roadmap

1. **Pre-production** (done): prompt to approved storyboard
2. **Voiceover** (done): Kokoro text-to-speech per scene; real audio lengths set scene durations
3. **Animation and render** (done): an Animator agent writes each scene in Remotion, test-renders and fixes it; preview, captions and final MP4
4. **Next**: explainers built around your own images, then episodic cartoon series
