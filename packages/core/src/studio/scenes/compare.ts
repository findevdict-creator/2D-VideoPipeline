import type { SceneSpec } from "../model/scene.js";
import type { Studio } from "../studio.js";
import { findAsset } from "../store/assets.js";
import { getProject } from "../store/projects.js";
import { getScene, listReviews, readSource, versionByNumber, type SceneVersion } from "../store/scenes.js";
import { getVoiceTrack } from "../voice.js";

/** One piece of a comparison: text both versions have, or text only one of them has. */
export interface DiffPart {
  op: "same" | "removed" | "added";
  text: string;
}

/**
 * The difference between two lists, as runs of items that stayed, went and came.
 * A plain longest-common-subsequence table: narrations and scene files are short.
 */
export function diff(before: string[], after: string[], join = ""): DiffPart[] {
  const n = before.length;
  const m = after.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = before[i] === after[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const out: DiffPart[] = [];
  const push = (op: DiffPart["op"], text: string) => {
    const last = out.at(-1);
    if (last?.op === op) last.text += join + text;
    else out.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      push("same", before[i]!);
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) push("removed", before[i++]!);
    else push("added", after[j++]!);
  }
  while (i < n) push("removed", before[i++]!);
  while (j < m) push("added", after[j++]!);
  return out;
}

/** Word by word. Spaces are pieces of their own, so the parts joined together give the text back. */
export const diffWords = (before: string, after: string) => diff(before.match(/\s+|\S+/g) ?? [], after.match(/\s+|\S+/g) ?? []);

/** Line by line. Files past a few thousand lines are compared as a whole instead. */
export function diffLines(before: string, after: string): DiffPart[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length * b.length > 4_000_000) return before === after ? [{ op: "same", text: before }] : [{ op: "removed", text: before }, { op: "added", text: after }];
  return diff(a, b, "\n");
}

export interface VersionChange {
  /** What changed, in a few words: "Narration", "Scene type". */
  what: string;
  before: string;
  after: string;
}

export interface VersionComparison {
  sceneId: string;
  /** The two version numbers, the older first. */
  before: number;
  after: number;
  /** What differs between the two, in plain words. Empty when they are the same. */
  changes: VersionChange[];
  narration: DiffPart[];
  /** The scene file, line by line. Null when neither version has one. */
  code: { added: number; removed: number; parts: DiffPart[] } | null;
  /** What was asked for between the two versions, oldest first. */
  asked: { version: number; notes: string; createdAt: string }[];
}

const seconds = (sec: number) => `${sec.toFixed(1)} s`;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (items: string[]) => items.join(", ") || "none";

function about(spec: SceneSpec, name: (assetId: string) => string): Record<string, string> {
  const out: Record<string, string> = {
    Title: spec.title,
    "Scene type": spec.type,
    "What the viewer sees": spec.visual.description,
    Elements: list(spec.visual.elements.map((e) => e.id)),
    "Text on screen": list(spec.visual.onScreenText),
    Cues: list(spec.cues.map((c) => `${c.id} on "${c.phrase}"`)),
    Overlays: list(spec.overlays.map((o) => ("text" in o && typeof o.text === "string" ? `${o.kind} "${o.text}"` : o.kind))),
    "Sound effects": list(spec.sfx.map((s) => `${s.sound ?? name(s.assetId ?? "")} ${s.at.cue ? `on "${s.at.cue}"` : `at ${s.at.sec} s`}`)),
    "Files used": list(spec.assets.map(name)),
  };
  if (spec.type === "illustration") out.Pictures = list(spec.illustration.shots.map((shot) => name(shot.assetId)));
  if (spec.type === "footage") out.Clip = `${name(spec.footage.assetId)}, from ${spec.footage.inSec} s, fitted by "${spec.footage.fit}"`;
  return out;
}

/**
 * What differs between two versions of a scene: the plan, the narration word by word,
 * the scene file line by line, the length, and what was asked for in between.
 */
export function compareVersions(studio: Studio, sceneId: string, a: number, b: number): VersionComparison {
  const scene = getScene(studio, sceneId);
  const project = getProject(studio, scene.projectId);
  const [low, high] = a <= b ? [a, b] : [b, a];
  const before = versionByNumber(studio, sceneId, low);
  const after = versionByNumber(studio, sceneId, high);

  const changes: VersionChange[] = [];
  const name = (assetId: string) => findAsset(studio, project.id, assetId)?.label ?? assetId;
  const was = about(before.spec, name);
  const now = about(after.spec, name);
  for (const what of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if ((was[what] ?? "none") !== (now[what] ?? "none")) changes.push({ what, before: was[what] ?? "none", after: now[what] ?? "none" });
  }
  if (before.spec.narration !== after.spec.narration) {
    const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
    changes.push({ what: "Narration", before: count(words(before.spec.narration), "word"), after: count(words(after.spec.narration), "word") });
  }
  const length = (v: SceneVersion) => (v.voiceTrackId ? getVoiceTrack(studio, v.voiceTrackId)?.durationSec : undefined);
  const [lengthBefore, lengthAfter] = [length(before), length(after)];
  if (lengthBefore !== undefined && lengthAfter !== undefined && Math.abs(lengthBefore - lengthAfter) >= 0.05) {
    changes.push({ what: "Length", before: seconds(lengthBefore), after: seconds(lengthAfter) });
  }

  const codeBefore = readSource(studio, project, before);
  const codeAfter = readSource(studio, project, after);
  let code: VersionComparison["code"] = null;
  if (codeBefore !== undefined || codeAfter !== undefined) {
    const parts = diffLines(codeBefore ?? "", codeAfter ?? "");
    const lines = (op: DiffPart["op"]) => parts.filter((p) => p.op === op).reduce((n, p) => n + p.text.split("\n").length, 0);
    code = { added: lines("added"), removed: lines("removed"), parts };
    if (code.added || code.removed) changes.push({ what: "Scene file", before: `${count(code.removed, "line")} removed`, after: `${count(code.added, "line")} added` });
  }

  const asked = listReviews(studio, "scene", sceneId)
    .filter((r) => r.decision === "revise" && r.targetVersion !== null && r.targetVersion >= low && r.targetVersion < high && r.notes.trim())
    .map((r) => ({ version: r.targetVersion!, notes: r.notes, createdAt: r.createdAt }));

  return { sceneId, before: low, after: high, changes, narration: diffWords(before.spec.narration, after.spec.narration), code, asked };
}
