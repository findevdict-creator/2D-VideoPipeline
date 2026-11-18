import fs from "node:fs/promises";
import path from "node:path";
import type { Brief, DirectorNotes, Script, Storyboard } from "../schemas.js";
import type { AgentRunner, AgentRunRequest, AgentRunResult } from "./types.js";

/**
 * Writes fixed "How GPS works" files instead of calling Claude.
 * Use it to test the pipeline's flow, approvals and file handling at no cost.
 */
export class MockRunner implements AgentRunner {
  readonly kind = "mock";
  readonly calls: AgentRunRequest[] = [];

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.push(req);
    const out = req.expectedOutputs[0];
    if (!out) throw new Error(`Mock runner: agent "${req.agent}" has no expected output`);
    await fs.mkdir(path.dirname(out), { recursive: true });

    switch (req.agent) {
      case "producer":
        await writeJson(out, MOCK_BRIEF);
        break;
      case "researcher":
        await fs.writeFile(out, MOCK_RESEARCH);
        break;
      case "scriptwriter":
        await writeJson(out, MOCK_SCRIPT);
        break;
      case "storyboard-artist":
        await writeJson(out, MOCK_STORYBOARD);
        break;
      case "director": {
        // Ask for one revision on the first script review, so the review loop gets exercised.
        const firstScriptRound = path.basename(out) === "script-round-1.json";
        await writeJson(out, firstScriptRound ? MOCK_DIRECTOR_REVISE : MOCK_DIRECTOR_APPROVE);
        break;
      }
      default:
        throw new Error(`Mock runner: no fixture for agent "${req.agent}"`);
    }
    return { text: `mock ${req.agent} wrote ${path.basename(out)}`, costUsd: 0, durationMs: 0 };
  }
}

async function writeJson(file: string, data: unknown) {
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n");
}

export const MOCK_BRIEF: Brief = {
  title: "How GPS Works",
  topic: "How a GPS receiver works out where you are using signals from satellites",
  audience: "Curious adults and teens with no physics background",
  goal: "Understand that GPS is timing: distances from several satellites pin down one location",
  tone: "Friendly, curious and clear",
  targetDurationSec: 75,
  aspectRatio: "16:9",
  keyTakeaways: [
    "Satellites broadcast their position and the exact time",
    "Signal travel time gives the distance to each satellite",
    "Four satellites are needed to fix position and correct the receiver's clock",
  ],
  mustCover: ["Satellite constellation", "Timing signals", "Trilateration", "Why four satellites"],
  outOfScope: ["Signal encoding details", "History of GPS"],
  visualStyleHints: "Clean flat vector look, dark blue space background, bright signal lines",
  voice: { kokoroVoice: "af_heart", pace: "normal" },
};

export const MOCK_RESEARCH = `# Research: How GPS works

- About 31 operational GPS satellites orbit roughly 20,200 km above Earth. Source: https://www.gps.gov/systems/gps/space/
- Each satellite carries atomic clocks and broadcasts its position and the time. Source: https://www.gps.gov/systems/gps/
- A receiver measures signal travel time to compute distance (speed of light times time). Source: https://www.gps.gov/systems/gps/
- Signals from at least four satellites are needed: three for position, one to correct the receiver clock. Source: https://www.gps.gov/systems/gps/
`;

const SRC = ["https://www.gps.gov/systems/gps/"];

export const MOCK_SCRIPT: Script = {
  title: "How GPS Works",
  scenes: [
    {
      id: "s01",
      title: "The question",
      purpose: "Hook the viewer",
      narration: "Your phone knows where you are to within a few meters. But how? The answer is floating twenty thousand kilometers above your head.",
      estimatedDurationSec: 10,
      sources: SRC,
    },
    {
      id: "s02",
      title: "The satellites",
      purpose: "Introduce the constellation and the timing signal",
      narration: "About thirty GPS satellites circle the Earth. Each one carries atomic clocks and constantly broadcasts two things: where it is, and exactly what time it is.",
      estimatedDurationSec: 14,
      sources: SRC,
    },
    {
      id: "s03",
      title: "Time becomes distance",
      purpose: "Explain travel time to distance",
      narration: "Your receiver notes when each signal arrives. Radio waves travel at the speed of light, so a tiny delay tells you how far away that satellite is.",
      estimatedDurationSec: 14,
      sources: SRC,
    },
    {
      id: "s04",
      title: "Trilateration",
      purpose: "Show intersecting spheres",
      narration: "One distance puts you somewhere on a giant sphere. Add a second satellite and a third, and the spheres meet at a single point. That point is you.",
      estimatedDurationSec: 16,
      sources: SRC,
    },
    {
      id: "s05",
      title: "Why four",
      purpose: "Explain clock correction and wrap up",
      narration: "Your phone's clock is not perfect, so a fourth satellite corrects the timing error. Four signals, one precise answer: that is how GPS works.",
      estimatedDurationSec: 14,
      sources: SRC,
    },
  ],
};

export const MOCK_DIRECTOR_REVISE: DirectorNotes = {
  verdict: "revise",
  summary: "Strong structure. Tighten the hook.",
  notes: [{ sceneId: "s01", issue: "Hook is slightly long", suggestion: "Cut to two short sentences" }],
};

export const MOCK_DIRECTOR_APPROVE: DirectorNotes = {
  verdict: "approve",
  summary: "Ready for your review.",
  notes: [],
};

const palette = {
  background: "#0B1D3A",
  surface: "#14305C",
  primary: "#3DA5F5",
  secondary: "#F5C542",
  accent: "#FF6B6B",
  text: "#F4F7FB",
};

export const MOCK_STORYBOARD: Storyboard = {
  styleGuide: {
    visualStyle: "Flat vector, soft glows on signals",
    palette,
    fontFamily: "Inter",
    iconStyle: "Rounded line icons",
  },
  scenes: [
    {
      id: "s01",
      layout: "Phone centred, Earth below",
      visualDescription: "A phone shows a map pin, then the camera pulls back to reveal Earth and a satellite",
      elements: [
        { id: "phone", kind: "icon", description: "Smartphone with a map pin" },
        { id: "earth", kind: "shape", description: "Earth curve at the bottom" },
      ],
      animations: [{ elementId: "earth", action: "rises into view", cue: "floating twenty thousand kilometers" }],
      onScreenText: ["How does GPS work?"],
      transitionIn: "fade",
      camera: "slow-zoom-out",
    },
    {
      id: "s02",
      layout: "Earth centred with orbits",
      visualDescription: "Satellites orbit Earth, each pulsing a signal with a clock and coordinates",
      elements: [
        { id: "orbits", kind: "diagram", description: "Six orbital rings around Earth" },
        { id: "sat", kind: "icon", description: "Satellite icon with a small clock" },
      ],
      animations: [{ elementId: "sat", action: "pulses a signal ring", cue: "constantly broadcasts" }],
      onScreenText: ["Position", "Time"],
      transitionIn: "cut",
      camera: "static",
    },
    {
      id: "s03",
      layout: "Satellite top left, phone bottom right",
      visualDescription: "A signal travels from satellite to phone, with a timer counting",
      elements: [
        { id: "signal", kind: "arrow", description: "Wave line from satellite to phone" },
        { id: "timer", kind: "label", description: "Travel-time counter" },
      ],
      animations: [{ elementId: "signal", action: "travels along path", cue: "speed of light" }],
      onScreenText: ["distance = speed of light × time"],
      transitionIn: "slide",
      camera: "static",
    },
    {
      id: "s04",
      layout: "Three circles overlapping around a point",
      visualDescription: "Circles grow from three satellites and meet at one point that becomes a pin",
      elements: [
        { id: "circles", kind: "diagram", description: "Three range circles" },
        { id: "pin", kind: "icon", description: "Location pin at the intersection" },
      ],
      animations: [{ elementId: "pin", action: "drops in", cue: "That point is you" }],
      onScreenText: ["Trilateration"],
      transitionIn: "fade",
      camera: "slow-zoom-in",
    },
    {
      id: "s05",
      layout: "Four satellites around the pin",
      visualDescription: "A fourth satellite links in and a clock icon snaps into sync",
      elements: [
        { id: "sat4", kind: "icon", description: "Fourth satellite" },
        { id: "clock", kind: "icon", description: "Clock that corrects itself" },
      ],
      animations: [{ elementId: "clock", action: "snaps into sync", cue: "corrects the timing error" }],
      onScreenText: ["4 satellites = 1 precise fix"],
      transitionIn: "zoom",
      camera: "static",
    },
  ],
};
