import fs from "node:fs";
import { getProject } from "../store/projects.js";
import type { Studio } from "../studio.js";
import { callTool, type ToolContext } from "../tools/index.js";
import type { StudioRunner, StudioRunRequest, StudioRunResult } from "./runner.js";

/**
 * Stands in for Claude: makes a small, fixed video plan by calling the same tools a real
 * run calls. For trying the whole flow, and for tests, without using your Claude plan.
 */
export class MockStudioRunner implements StudioRunner {
  readonly kind = "mock";
  /** Every tool call made, for tests. */
  readonly calls: { runId: string; tool: string; ok: boolean }[] = [];
  /** Render stills the way a real run does. Left unset, it follows whether the studio has a browser to render with. */
  stills?: boolean;
  /** Milliseconds each run takes, so tests can see runs overlap. */
  delayMs = 0;
  /** Scenes written for each chapter. Raise it to try a long video. */
  scenesPerChapter = 2;
  /** Called before every tool call. Throw a UsageLimitError from it to stand in for Claude's usage limit. */
  beforeTool?: (req: StudioRunRequest, tool: string) => void;

  async run(studio: Studio, req: StudioRunRequest): Promise<StudioRunResult> {
    const ctx: ToolContext = { studio, projectId: req.run.projectId, run: req.run, log: (m) => req.onLog("info", m) };
    const sessionId = req.resumeSessionId ?? `mock-session-${req.run.id}`;
    req.onSession(sessionId);
    const call = async (tool: string, input: unknown = {}) => {
      this.beforeTool?.(req, tool);
      req.onLog("tool", tool);
      const result = await callTool(ctx, tool, input);
      this.calls.push({ runId: req.run.id, tool, ok: result.ok });
      req.onLog("result", JSON.stringify(result.output).slice(0, 300));
      if (!result.ok) throw new Error(`${tool} failed: ${JSON.stringify(result.output)}`);
      const problems = result.output.problems as string[] | undefined;
      if (problems?.length) throw new Error(`${tool} reported problems: ${problems.join("; ")}`);
      return result.output as any;
    };
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (req.signal?.aborted) throw new Error("Cancelled");

    const project = getProject(studio, req.run.projectId);
    const notes = req.run.payload.notes;
    const info = await call("project_get");
    let text = "";

    switch (req.run.targetKind) {
      case "outline": {
        // About two minutes a chapter once the video is long; one or two chapters for a short one.
        const count = project.targetDurationSec >= 300 ? Math.min(12, Math.round(project.targetDurationSec / 120)) : project.targetDurationSec >= 90 ? 2 : 1;
        const each = Math.round(project.targetDurationSec / count);
        const chapters = Array.from({ length: count }, (_, i) => ({
          title: i === 0 ? "The question" : i === 1 ? "How it works" : `Going deeper, part ${i - 1}`,
          goal: i === 0 ? "The viewer knows what puzzle the video answers" : i === 1 ? "The viewer can explain the mechanism in a sentence" : "The viewer sees one more consequence of the idea",
          targetDurationSec: i === count - 1 ? project.targetDurationSec - each * (count - 1) : each,
        }));
        await call("document_save", {
          kind: "outline",
          markdown: `# ${project.title}\n\n${project.description}\n\n${chapters.map((c) => `## ${c.title}\n\n${c.goal}.`).join("\n\n")}${notes ? `\n\n_Revised: ${notes}_` : ""}`,
        });
        await call("chapters_propose", { chapters });
        text = `Wrote the outline with ${count} chapter(s).`;
        break;
      }
      case "bible": {
        await call("document_read", { kind: "outline" });
        for (const ref of info.references as { assetId: string }[]) await call("asset_view", { assetId: ref.assetId });
        await call("theme_set", {
          theme: {
            visualStyle: "Flat vector shapes on a deep blue background, with soft glows",
            palette: { background: "#0B1D33", surface: "#12304F", primary: "#4FC3F7", secondary: "#B39DDB", accent: "#FFB74D", text: "#F5F9FF" },
            fontFamily: "Inter",
            iconStyle: "Rounded line icons with a 3px stroke",
          },
        });
        await call("document_save", {
          kind: "bible",
          markdown: `# Bible\n\n## Voice\n\nFriendly and exact. Short sentences.\n\n## Look\n\nDeep blue backgrounds, light text, one accent colour for the thing being explained.\n\n## Motion\n\nThings fade and rise in over half a second. Backgrounds never move.\n\n## Recurring things\n\n- TopicBadge: a rounded badge that names the idea on screen.\n\n## Glossary\n\nNone yet.${notes ? `\n\n_Revised: ${notes}_` : ""}`,
        });
        await call("shared_plan", { items: [{ name: "TopicBadge", brief: "A rounded badge with a short label. Props: label, x, y, progress (0 to 1 entrance)." }] });
        text = "Wrote the bible, set the theme and planned one shared component.";
        break;
      }
      case "foundation": {
        const { shared } = await call("shared_list");
        for (const item of shared as { name: string }[]) {
          await call("shared_save", { name: item.name, code: badgeCode(item.name, notes), notes: notes ?? "First version" });
        }
        text = `Built ${shared.length} shared component(s).`;
        break;
      }
      case "chapter": {
        const chapter = (info.chapters as { id: string; title: string; position: number }[]).find((c) => c.id === req.run.targetId)!;
        const image = (await call("asset_list", { kind: "image" })).assets[0] as { id: string } | undefined;
        // A real run reads what the earlier chapters said before it writes; so does this one.
        await call("scene_list");
        const scenes = [
          { title: `${chapter.title}: opening`, type: "remotion-2d", purpose: "Hook the viewer", narration: `Here is a question worth asking. ${sentence(project.description)}`, visualIdea: "The topic's name appears as a badge and rings pulse behind it" },
          { title: `${chapter.title}: the idea`, type: "remotion-2d", purpose: "State the idea", narration: "The answer is simpler than it looks. One signal leaves, one signal arrives, and the gap between them tells the story.", visualIdea: "Two dots, a line growing from one to the other" },
          ...Array.from({ length: Math.max(0, this.scenesPerChapter - 2) }, (_, i) => ({
            title: `${chapter.title}: step ${i + 1}`,
            type: "remotion-2d",
            purpose: "Take the idea one step further",
            narration: `Step ${i + 1} follows from the last one. The same signal, seen from a slightly different side, explains a little more.`,
            visualIdea: "The two dots again, with one more line between them",
          })),
          ...(image && chapter.position === 1
            ? [{ title: `${chapter.title}: a closer look`, type: "illustration", purpose: "Show the real thing", narration: "Look closer at the picture. Every part of it has a job to do.", visualIdea: "The image, slowly zooming in" }]
            : []),
        ];
        await call("scenes_propose", { scenes });
        text = `Wrote ${scenes.length} scenes for "${chapter.title}".`;
        break;
      }
      case "scene": {
        const scene = await call("scene_get");
        await call("document_read", { kind: "bible" });
        const narration: string = scene.spec?.narration ?? scene.plan.narration;
        const words = narration.split(/\s+/).filter(Boolean);
        const phrase = (from: number) => words.slice(from, from + 3).join(" ");
        const cues = [
          { id: "first", phrase: phrase(0), action: "the first thing appears" },
          ...(words.length > 9 ? [{ id: "second", phrase: phrase(Math.floor(words.length / 2)), action: "the second thing appears" }] : []),
        ];
        const shared = (scene.sharedAssets as { name: string; version: number }[]).find((s) => s.name === "TopicBadge");
        const base = {
          type: scene.type,
          title: scene.plan.title ?? scene.spec.title,
          purpose: scene.plan.purpose ?? "",
          narration,
          visual: { description: scene.plan.visualIdea || "A badge and a growing line", elements: cues.map((c) => ({ id: c.id, kind: "shape", description: c.action })) },
          cues,
        };
        if (scene.type === "illustration") {
          const image = (await call("asset_list", { kind: "image" })).assets[0] as { id: string };
          await call("asset_view", { assetId: image.id });
          await call("scene_save_spec", {
            spec: {
              ...base,
              overlays: [{ kind: "label", text: notes ? notes.slice(0, 40) : "Look here", x: 0.5, y: 0.2, at: { cue: "first" } }],
              illustration: { shots: [{ assetId: image.id, from: { x: 0.5, y: 0.5, zoom: 1 }, to: { x: 0.5, y: 0.5, zoom: 1.4 } }] },
            },
          });
        } else {
          const saved = await call("scene_save_spec", { spec: { ...base, uses: shared ? [{ name: shared.name, version: shared.version }] : [] } });
          const second = cues.length > 1;
          const code =
            scene.type === "r3f" ? sceneCode3d(base.title, notes, second) : scene.type === "manim" ? sceneCodeManim(base.title, notes, second) : sceneCode(base.title, notes, second, Boolean(shared));
          fs.writeFileSync(saved.codeFile, code);
          req.onLog("tool", `Write ${scene.type === "manim" ? "scene.py" : "scene.tsx"}`);
        }
        await call("scene_check");
        if (this.stills ?? Boolean(studio.config.render.browserExecutable)) await call("scene_stills");
        await call("scene_submit", { summary: notes ? `Changed as asked: ${notes}` : `Built "${base.title}" with ${cues.length} cue(s).` });
        text = notes ? "Revised the scene as asked." : "Built the scene and handed it over.";
        break;
      }
    }
    req.onLog("text", text);
    return { text, sessionId, costUsd: 0, durationMs: this.delayMs };
  }
}

const sentence = (text: string) => {
  const first = text.split(/(?<=[.!?])\s/)[0]!.trim();
  return /[.!?]$/.test(first) ? first : `${first}.`;
};

const badgeCode = (name: string, notes?: string) => `import React from "react";
import { useTheme } from "@pipeline/lib";

export interface ${name}Props {
  label: string;
  x: number;
  y: number;
  /** 0 to 1: the badge's entrance. */
  progress: number;
}

/** A rounded badge that names the idea on screen.${notes ? ` Revised: ${notes.replace(/\*\//g, "")}` : ""} */
export const ${name}: React.FC<${name}Props> = ({ label, x, y, progress }) => {
  const t = useTheme();
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: \`translate(-50%, -50%) scale(\${0.8 + 0.2 * progress})\`,
        opacity: progress,
        padding: "18px 40px",
        borderRadius: 999,
        background: t.palette.surface,
        border: \`3px solid \${t.palette.primary}\`,
        color: t.palette.text,
        fontFamily: t.fontFamily,
        fontSize: 54,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </div>
  );
};

export const Demo: React.FC = () => {
  const t = useTheme();
  return (
    <div style={{ position: "absolute", inset: 0, background: t.palette.background }}>
      <${name} label="Example" x={t.width / 2} y={t.height / 2} progress={1} />
    </div>
  );
};
`;

const sceneCode = (title: string, notes: string | undefined, second: boolean, badge: boolean) => `import React from "react";
import { Background, useCueAppear, useTheme } from "@pipeline/lib";
${badge ? 'import { TopicBadge } from "@shared/TopicBadge";\n' : ""}
export default function Scene() {
  const t = useTheme();
  const first = useCueAppear("first", { durationSec: 0.5 });
  ${second ? 'const second = useCueAppear("second", { durationSec: 0.5 });' : "const second = first;"}
  const cx = t.width / 2;
  const cy = (t.safe.top + t.safe.bottom) / 2;
  return (
    <>
      <Background stars />
      ${
        badge
          ? `<TopicBadge label=${JSON.stringify((notes ?? title).slice(0, 36))} x={cx} y={cy - 120} progress={first} />`
          : `<div style={{ position: "absolute", left: cx - 300, top: cy - 160, width: 600, textAlign: "center", color: t.palette.text, fontFamily: t.fontFamily, fontSize: 54, fontWeight: 700, opacity: first }}>{${JSON.stringify((notes ?? title).slice(0, 36))}}</div>`
      }
      <div style={{ position: "absolute", left: cx - 300, top: cy + 60, width: 600 * second, height: 10, borderRadius: 5, background: t.palette.accent }} />
    </>
  );
}
`;

const sceneCodeManim = (title: string, notes: string | undefined, second: boolean) => `from manim import *
from pipeline_manim import StudioScene, safe, theme


class Main(StudioScene):
    def build(self):
        title = Text(${JSON.stringify((notes ?? title).slice(0, 36))}, font_size=44).move_to(safe.point(0.5, 0.12))
        axes = Axes(x_range=[0, 4, 1], y_range=[0, 4, 1], x_length=6, y_length=3.4, axis_config={"color": theme.text})
        axes.move_to(safe.point(0.5, 0.6))
        curve = axes.plot(lambda x: x * x / 4, x_range=[0, 4], color=theme.accent, stroke_width=6)
        dot = Dot(axes.c2p(2, 1), color=theme.primary, radius=0.12)

        self.wait_until("first")
        self.play(FadeIn(title, shift=DOWN * 0.3), Create(axes), run_time=0.8)
        ${second ? 'self.wait_until("second")' : "self.wait(0.2)"}
        self.play(Create(curve), FadeIn(dot, scale=0.5), run_time=min(1.0, max(0.3, self.remaining() - 0.1)))
`;

const sceneCode3d = (title: string, notes: string | undefined, second: boolean) => `import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { Label, useCueAppear, useTheme } from "@pipeline/lib";
import { Ground, Scene3D, orbit, useScreenPoint, type CameraSpec } from "@pipeline/lib/three";

export default function Scene() {
  const t = useTheme();
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const first = useCueAppear("first", { durationSec: 0.6 });
  ${second ? 'const second = useCueAppear("second", { durationSec: 0.6 });' : "const second = first;"}
  const camera: CameraSpec = { position: orbit(25 + 30 * (frame / durationInFrames), 11, 3.5), lookAt: [0, -0.4, 0], fov: 32 };
  const top = useScreenPoint(camera, [0, 1.9, 0]);
  return (
    <>
      <Scene3D camera={camera} shadows>
        <mesh scale={first} position={[-1.3, 0, 0]} castShadow>
          <boxGeometry args={[1.8, 1.8, 1.8]} />
          <meshStandardMaterial color={t.palette.primary} roughness={0.6} />
        </mesh>
        <mesh scale={second} position={[1.5, 0, 0]} castShadow>
          <sphereGeometry args={[1, 48, 32]} />
          <meshStandardMaterial color={t.palette.accent} roughness={0.5} />
        </mesh>
        <Ground y={-0.92} />
      </Scene3D>
      <Label x={top.x} y={top.y} progress={first} box>{${JSON.stringify((notes ?? title).slice(0, 36))}}</Label>
    </>
  );
}
`;
