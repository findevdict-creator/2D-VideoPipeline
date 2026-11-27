import fs from "node:fs";
import { getProject } from "../store/projects.js";
import type { Studio } from "../studio.js";
import { callTool, type ToolContext } from "../tools/index.js";
import type { StudioRunner, StudioRunRequest, StudioRunResult } from "./runner.js";

/** Sentences with few words in common, so the sample chapters do not repeat one another. */
const OWN_LINES = [
  "Picture a lighthouse sweeping its beam across dark water every night.",
  "Bakers knead dough until gluten strands stretch like elastic threads.",
  "Mountain climbers ration oxygen carefully above eight thousand metres.",
  "Honeybees dance in figure eights to share flower locations.",
  "Old sailors read weather from cloud shapes before barometers existed.",
  "Glaciers carve valleys slowly, grinding bedrock into fine pale flour.",
  "Violin makers tap spruce boards, listening for a bright ringing tone.",
  "Desert foxes hunt at dusk, when sand finally cools enough.",
  "Printers once set metal letters backwards, line after patient line.",
  "Coral polyps build limestone reefs grain upon tiny grain.",
  "Telegraph clerks tapped dots and dashes along copper wires overnight.",
  "Chess engines prune millions of losing branches each second.",
  "Potters centre wet clay with steady palms on spinning wheels.",
  "Migrating geese trade the lead position to save energy.",
  "Astronomers stack hundreds of faint exposures to reveal galaxies.",
  "Blacksmiths judge temperature by colour glowing in the forge.",
  "River deltas fan outward wherever currents drop their silt.",
  "Librarians shelve returned books using decimal numbers on spines.",
  "Surfers wait beyond breakers, watching swells rise far offshore.",
  "Weavers pass shuttles through warp threads thousands of times daily.",
  "Volcanic ash fertilises farmland decades after an eruption ends.",
  "Cartographers once left unexplored regions blank on parchment maps.",
  "Owls fly silently thanks to soft fringed feather edges.",
  "Engineers test bridges with loaded trucks parked across every span.",
  "Tea pickers pluck only two leaves plus a bud.",
  "Divers equalise ear pressure every few metres going down.",
  "Clockmakers poise balance wheels using screws smaller than seeds.",
  "Salmon smell their home stream across open ocean distances.",
  "Typesetters called capital letters upper case after wooden drawers.",
  "Snowflakes grow six arms because water molecules bond hexagonally.",
  "Jugglers watch the peak of each arc, never their hands.",
  "Miners carried canaries underground as living gas alarms.",
  "Orchards need winter chill hours before blossoms open properly.",
  "Radio operators bounce shortwave signals off the ionosphere nightly.",
  "Sculptors rough out marble with point chisels before rasping.",
  "Tide pools shelter anemones, limpets, crabs and darting gobies.",
];

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
  /** Put sound effects on the cues of every scene. */
  sfx = true;
  /** Give the video a recurring character. Left unset, it follows whether the description asks for one. */
  character?: boolean;
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
        for (const ref of info.references as { assetId: string; kind?: string }[]) await call(ref.kind === "video" ? "reference_keyframes" : "asset_view", { assetId: ref.assetId });
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
        const withCharacter = this.character ?? /\b(character|mascot|presenter)\b/i.test(project.description);
        await call("shared_plan", {
          items: [
            { name: "TopicBadge", brief: "A rounded badge with a short label. Props: label, x, y, progress (0 to 1 entrance)." },
            ...(withCharacter
              ? [{ name: "Guide", kind: "character", brief: "The video's guide: a round-headed figure in a jacket of the primary colour. Poses: stand, point, wave. Expressions: calm, happy, surprised." }]
              : []),
          ],
        });
        text = `Wrote the bible, set the theme and planned ${withCharacter ? "a shared component and a character" : "one shared component"}.`;
        break;
      }
      case "foundation": {
        const { shared } = await call("shared_list");
        for (const item of shared as { name: string; kind?: string }[]) {
          await call("shared_save", { name: item.name, code: item.kind === "character" ? characterCode(item.name, notes) : badgeCode(item.name, notes), notes: notes ?? "First version" });
        }
        text = `Built ${shared.length} shared component(s).`;
        break;
      }
      case "chapter": {
        const chapter = (info.chapters as { id: string; title: string; position: number }[]).find((c) => c.id === req.run.targetId)!;
        const image = (await call("asset_list", { kind: "image" })).assets[0] as { id: string } | undefined;
        // A real run reads what the earlier chapters said before it writes; so does this one.
        await call("scene_list");
        // Each chapter says something of its own, as a real one does: a list that repeats another chapter is refused.
        const own = (part: number) => OWN_LINES[((chapter.position - 1) * 3 + part) % OWN_LINES.length]!;
        const scenes = [
          { title: `${chapter.title}: opening`, type: "remotion-2d", purpose: "Hook the viewer", narration: `Here is a question worth asking. ${sentence(project.description)} ${own(0)}`, visualIdea: "The topic's name appears as a badge and rings pulse behind it" },
          { title: `${chapter.title}: the idea`, type: "remotion-2d", purpose: "State the idea", narration: `The answer is simpler than it looks. One signal leaves, one signal arrives, and the gap between them tells the story. ${own(1)}`, visualIdea: "Two dots, a line growing from one to the other" },
          ...Array.from({ length: Math.max(0, this.scenesPerChapter - 2) }, (_, i) => ({
            title: `${chapter.title}: step ${i + 1}`,
            type: "remotion-2d",
            purpose: "Take the idea one step further",
            narration: `Step ${i + 1} follows from the last one. The same signal, seen from a slightly different side, explains a little more. ${OWN_LINES[(chapter.position * 7 + i * 5 + 2) % OWN_LINES.length]!}`,
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
      case "thumbnail": {
        await call("document_read", { kind: "outline" });
        const word = (notes ?? project.title).split(/\s+/).filter(Boolean).slice(0, 2).join(" ").toUpperCase();
        const saved = await call("thumbnail_save", { code: thumbnailCode(word), text: word, idea: "A sample thumbnail from the stand-in runner: the first words of the title, large, on the video's colours." });
        text = `Designed thumbnail version ${saved.version}.`;
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
        const guide = (scene.sharedAssets as { name: string; version: number; kind?: string; poses?: string[]; expressions?: string[] }[]).find((s) => s.kind === "character");
        // References attached to the scene are looked at, and written down as followed.
        const references = (scene.references as { assetId: string; kind?: string; role: string; note: string }[]).map((r) => ({ assetId: r.assetId, role: r.role, note: r.note }));
        for (const ref of scene.references as { assetId: string; kind?: string }[]) await call(ref.kind === "video" ? "reference_keyframes" : "asset_view", { assetId: ref.assetId });
        const base = {
          type: scene.type,
          title: scene.plan.title ?? scene.spec.title,
          purpose: scene.plan.purpose ?? "",
          narration,
          visual: { description: scene.plan.visualIdea || "A badge and a growing line", elements: cues.map((c) => ({ id: c.id, kind: "shape", description: c.action })) },
          cues,
          references,
          // A pop as the first thing appears, and a small bell on the second.
          sfx: this.sfx ? [{ sound: "pop", at: { cue: "first" } }, ...(cues.length > 1 ? [{ sound: "ding", at: { cue: "second" }, volume: 0.4 }] : [])] : [],
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
          const draws2d = scene.type === "remotion-2d";
          const uses = [shared, draws2d ? guide : undefined].filter((u) => u !== undefined).map((u) => ({ name: u.name, version: u.version }));
          const saved = await call("scene_save_spec", { spec: { ...base, uses } });
          // The guide stands somewhere else, at another size and in another pose, in each scene.
          const turn = Number(String(scene.label).split(".").pop()) || 1;
          const placed = guide && draws2d
            ? { name: guide.name, pose: guide.poses?.[turn % (guide.poses.length || 1)] ?? "stand", expression: guide.expressions?.[turn % (guide.expressions.length || 1)] ?? "calm", side: turn % 2 ? 0.14 : 0.86, size: 0.3 + 0.06 * (turn % 3) }
            : undefined;
          const second = cues.length > 1;
          const code =
            scene.type === "r3f" ? sceneCode3d(base.title, notes, second) : scene.type === "manim" ? sceneCodeManim(base.title, notes, second) : sceneCode(base.title, notes, second, Boolean(shared), placed);
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

interface Placed {
  name: string;
  pose: string;
  expression: string;
  /** Where it stands across the frame, 0 to 1, and how tall it is as a share of the frame's height. */
  side: number;
  size: number;
}

const sceneCode = (title: string, notes: string | undefined, second: boolean, badge: boolean, who?: Placed) => `import React from "react";
import { Background, useCueAppear, useTheme } from "@pipeline/lib";
${badge ? 'import { TopicBadge } from "@shared/TopicBadge";\n' : ""}${who ? `import { ${who.name} } from "@shared/${who.name}";\n` : ""}
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
      ${who ? `<${who.name} x={t.width * ${who.side}} y={t.safe.bottom} height={t.height * ${who.size.toFixed(2)}} pose="${who.pose}" expression="${who.expression}" facing="${who.side > 0.5 ? "left" : "right"}" progress={first} talking />` : ""}
    </>
  );
}
`;

/** A small figure with three poses and three expressions, made the way a real character is. */
const characterCode = (name: string, notes?: string) => `import React from "react";
import { defineCharacter } from "@pipeline/lib";

/** The video's guide.${notes ? ` Revised: ${notes.replace(/\*\//g, "")}` : ""} */
export const ${name} = defineCharacter({
  width: 200,
  height: 420,
  poses: ["stand", "point", "wave"],
  expressions: ["calm", "happy", "surprised"],
  colors: { skin: "#F2C6A0", hair: "#3B2A20", jacket: "primary", trousers: "#22314D" },
  draw: ({ pose, expression, colors, blink, mouth }) => {
    const arm = pose === "point" ? "M130 190 L196 170" : pose === "wave" ? "M130 190 L178 96" : "M130 190 L146 290";
    return (
      <>
        <rect x={72} y={290} width={24} height={130} rx={10} fill={colors.trousers} />
        <rect x={104} y={290} width={24} height={130} rx={10} fill={colors.trousers} />
        <rect x={60} y={160} width={80} height={150} rx={26} fill={colors.jacket} />
        <path d="M70 190 L54 290" stroke={colors.jacket} strokeWidth={22} strokeLinecap="round" />
        <path d={arm} stroke={colors.jacket} strokeWidth={22} strokeLinecap="round" />
        <circle cx={100} cy={96} r={58} fill={colors.skin} />
        <path d="M44 86 Q100 0 156 86 Q100 52 44 86 Z" fill={colors.hair} />
        {[82, 122].map((x) => (blink ? <rect key={x} x={x - 7} y={98} width={14} height={3} fill={colors.hair} /> : <circle key={x} cx={x} cy={98} r={expression === "surprised" ? 9 : 6} fill={colors.hair} />))}
        {expression === "happy" ? (
          <path d={\`M82 122 Q102 \${140 + mouth * 10} 122 122\`} stroke={colors.hair} strokeWidth={5} fill="none" strokeLinecap="round" />
        ) : (
          <ellipse cx={102} cy={128} rx={expression === "surprised" ? 9 : 12} ry={(expression === "surprised" ? 10 : 2) + mouth * 8} fill={colors.hair} />
        )}
      </>
    );
  },
});
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

/** A plain thumbnail: two words, huge, with a block of the accent colour beside them. */
function thumbnailCode(words: string): string {
  return `import React from "react";
import { useTheme } from "@pipeline/lib";

export default function Thumbnail() {
  const t = useTheme();
  return (
    <div style={{ position: "absolute", inset: 0, background: \`radial-gradient(circle at 70% 45%, \${t.palette.surface}, \${t.palette.background})\`, fontFamily: t.fontFamily }}>
      <div style={{ position: "absolute", right: t.width * 0.08, top: t.height * 0.2, width: t.height * 0.6, height: t.height * 0.6, borderRadius: "50%", background: t.palette.accent }} />
      <div style={{ position: "absolute", left: t.width * 0.06, top: t.height * 0.28, width: t.width * 0.55, fontSize: t.height * 0.2, fontWeight: 900, lineHeight: 1, color: t.palette.text }}>${words.replace(/[`$\\{}<>]/g, "")}</div>
    </div>
  );
}
`;
}
