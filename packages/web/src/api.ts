import type { assetKeyframes, projectList, projectSnapshot, sceneComparison, sceneDetail } from "../../server/src/snapshot";

export type Snapshot = ReturnType<typeof projectSnapshot>;
export type SceneCard = Snapshot["scenes"][number];
export type SceneDetail = Awaited<ReturnType<typeof sceneDetail>>;
export type Keyframes = Awaited<ReturnType<typeof assetKeyframes>>;
export type Comparison = ReturnType<typeof sceneComparison>;
export type ProjectSummary = ReturnType<typeof projectList>[number];
export type Run = Snapshot["runs"][number];
export type Asset = Snapshot["assets"][number];
export type Stage = Snapshot["project"]["stage"];

export interface LogLine {
  at: string;
  kind: "text" | "tool" | "result" | "info" | "error";
  text: string;
}

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const isFile = body instanceof Blob;
  const res = await fetch(url, {
    method,
    headers: { "x-studio": "1", ...(body !== undefined && !isFile ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : isFile ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `The studio answered with ${res.status}.` }));
  if (!res.ok) throw new Error(data.error ?? `The studio answered with ${res.status}.`);
  return data as T;
}

export const api = {
  projects: () => request<{ workspace: string; runner: string; projects: ProjectSummary[] }>("GET", "/api/projects"),
  createProject: (input: { description: string; title?: string; targetDurationSec: number; aspect: string }) => request<{ slug: string }>("POST", "/api/projects", input),
  project: (slug: string) => request<Snapshot>("GET", `/api/projects/${encodeURIComponent(slug)}`),
  updateSettings: (slug: string, settings: { sceneTypes?: string[]; captions?: boolean; theme?: { look?: string }; music?: Record<string, unknown>; sfx?: Record<string, unknown> }) => request("PATCH", `/api/projects/${encodeURIComponent(slug)}`, { settings }),
  startStage: (slug: string, notes?: string) => request("POST", `/api/projects/${encodeURIComponent(slug)}/stage/start`, { notes }),
  approveStage: (slug: string) => request<{ stage: Stage }>("POST", `/api/projects/${encodeURIComponent(slug)}/stage/approve`, {}),
  assemble: (slug: string, quality: "preview" | "final") => request("POST", `/api/projects/${encodeURIComponent(slug)}/assemble`, { quality }),
  rebuildStale: (slug: string) => request<{ scenes: number }>("POST", `/api/projects/${encodeURIComponent(slug)}/stale/rebuild`, {}),
  resumeUsage: () => request("POST", "/api/usage/resume", {}),
  reviseChapter: (id: string, notes: string) => request("POST", `/api/chapters/${id}/revise`, { notes }),
  approveChapter: (id: string) => request<{ status: string; stage: Stage }>("POST", `/api/chapters/${id}/approve`, {}),
  buildChapter: (id: string) => request("POST", `/api/chapters/${id}/build`, {}),
  previewChapter: (id: string) => request("POST", `/api/chapters/${id}/preview`, {}),
  scene: (id: string) => request<SceneDetail>("GET", `/api/scenes/${id}`),
  editPlan: (id: string, plan: { title?: string; narration?: string; visualIdea?: string; type?: string }) => request("PATCH", `/api/scenes/${id}/plan`, plan),
  approveScene: (id: string) => request("POST", `/api/scenes/${id}/approve`, {}),
  reviseScene: (id: string, notes: string) => request("POST", `/api/scenes/${id}/revise`, { notes }),
  buildScene: (id: string) => request("POST", `/api/scenes/${id}/build`, {}),
  renderScene: (id: string) => request("POST", `/api/scenes/${id}/render`, {}),
  compare: (id: string, a: number, b: number) => request<Comparison>("GET", `/api/scenes/${id}/compare?a=${a}&b=${b}`),
  exportVideo: (slug: string, options: { format: string; zoom?: number; chapterId?: string }) => request("POST", `/api/projects/${encodeURIComponent(slug)}/export`, options),
  rollbackScene: (id: string, version: number) => request("POST", `/api/scenes/${id}/rollback`, { version }),
  closeSharedRequest: (id: string, status: "done" | "declined") => request("POST", `/api/shared-requests/${id}/close`, { status }),
  upload: (slug: string, file: File) => request<{ id: string }>("POST", `/api/projects/${encodeURIComponent(slug)}/assets`, file, { "x-file-name": encodeURIComponent(file.name), "content-type": "application/octet-stream" }),
  editAsset: (id: string, patch: { label?: string; reference?: { role: string | null; note?: string } }) => request("PATCH", `/api/assets/${id}`, patch),
  keyframes: (id: string) => request<Keyframes>("GET", `/api/assets/${id}/keyframes`),
  setSceneReference: (sceneId: string, ref: { assetId: string; role: string | null; note?: string; atSec?: number | null }) => request("PUT", `/api/scenes/${sceneId}/references`, ref),
  deleteAsset: (id: string) => request("DELETE", `/api/assets/${id}`),
  runLog: (id: string, after: number) => request<{ status: string; error: string | null; lines: LogLine[]; next: number }>("GET", `/api/runs/${id}/log?after=${after}`),
  cancelRun: (id: string) => request("POST", `/api/runs/${id}/cancel`, {}),
};

export interface StudioEvent {
  kind: string;
  projectId: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
}

/** Listen to the studio's live updates. Returns a function that stops listening. */
export function listen(onEvent: (event: StudioEvent) => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data));
    } catch {
      // A line that is not an event is not worth stopping for.
    }
  };
  return () => source.close();
}
