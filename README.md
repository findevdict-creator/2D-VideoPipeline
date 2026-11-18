# 2D Video Pipeline

An automated pipeline that turns a prompt into a 2D animated explainer video, with a team of AI agents doing the work and a human approving each stage.

**Status:** Phase 1 (pre-production) is built. Voiceover (Kokoro) and animation and render (Remotion) come next.

## How it works

```
prompt ─▶ Brief ─▶ [you approve] ─▶ Research + Script ─▶ [you approve] ─▶ Storyboard ─▶ [you approve]
            │                          │        ▲                             │      ▲
         Producer             Researcher, Scriptwriter                 Storyboard artist
                                       └─ Director review ┘                   └ Director ┘
```

Every video gets its own **production folder**. Each agent reads the files written before it and writes its own, and you review those same files. Nothing is hidden inside an agent's memory.

| Agent | Writes | Job |
|---|---|---|
| Producer | `brief.json` | Turns your prompt into a creative brief: audience, goal, tone, length, key takeaways, voice |
| Researcher | `research.md` | Searches the web and writes a fact sheet with a source for every fact |
| Scriptwriter | `script.json` | Writes narration for the ear, split into scenes of 8 to 20 seconds |
| Director | `director-notes/` | Reviews the script and the storyboard, and sends notes back for revision before you see them |
| Storyboard artist | `storyboard.json` | Plans each scene for flat 2D animation: style guide, elements, and animations cued to exact narration phrases |

The pipeline code runs the stages in a fixed order and stops at every approval. Agents never move on by themselves. Approved stages are saved, so you can stop at any point and resume later, and a failed agent run resumes from the stage it was in.

Every file is validated against a schema in [`src/schemas.ts`](src/schemas.ts). If an agent writes an invalid file, it gets the errors and is asked to fix it. The storyboard is also checked against the script: the scene ids must match, and every animation cue must be a phrase the narrator actually says, so the visuals can be timed to the voice in a later phase.

## Running agents: three runners

Each agent is a Claude Code session with its own role, tools and task. How those sessions run is a setting:

| Runner | Signs in with | Use it for |
|---|---|---|
| `claude-cli` (default) | Your Claude Code login (Pro or Max plan). Runs `claude -p` for each agent | Building and testing without paying per use. Your plan's usage limits apply |
| `agent-sdk` | `ANTHROPIC_API_KEY`, billed per use. Uses the Claude Agent SDK | Running unattended or at higher volume |
| `mock` | Nothing. Writes sample "How GPS works" files | Testing the flow, approvals and file handling for free |

Choose with `--runner <name>` or the `PIPELINE_RUNNER` environment variable. Agents use the `opus` model by default; change it with `--model sonnet` or `PIPELINE_MODEL`.

## Setup

You need Node 20 or later, and for the default runner, [Claude Code](https://code.claude.com) installed and signed in (`claude` on your PATH).

```bash
npm install
```

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
  history/           earlier versions, saved before each revision
  logs/              one record per agent run, with its prompt, reply and reported cost
  state.json         which stages are approved
```

## Development

```bash
npm test            # pipeline flow, revisions, pause and resume, validation, claude-cli runner
npm run typecheck
```

Code map:

- `src/agents/definitions.ts`: each agent's role, rules and tools
- `src/stages/`: what each stage asks its agents to do, how it is summarised for review, and the Director review loop
- `src/pipeline.ts`: runs stages in order with approvals, revisions, and pause and resume
- `src/runners/`: the three ways to run an agent
- `src/schemas.ts`: the file formats shared between agents

## Roadmap

1. **Pre-production** (done): prompt to approved storyboard
2. **Voiceover**: Kokoro text-to-speech per scene; real audio lengths set scene durations
3. **Animation and render**: Remotion project and an Animator agent that writes, test-renders and fixes each scene; preview, captions and final MP4
