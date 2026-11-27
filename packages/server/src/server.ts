import { z } from "zod";
/**
 * The studio's local server. It serves the GUI, answers its requests, pushes live updates,
 * and owns the queue of Claude runs and renders. It listens on this computer only.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { REPO_ROOT } from "@studio/core/paths";
import { serve } from "@studio/core/studio/media/fileServer";
import { REFERENCE_ROLES } from "@studio/core/studio/model/asset";
import { NewProjectSchema, ProjectSettingsSchema, type ProjectSettings } from "@studio/core/studio/model/project";
import type { Studio } from "@studio/core/studio/studio";
import { deleteAsset, getAsset, importAsset, setProjectReference, setSceneReference, updateAsset } from "@studio/core/studio/store/assets";
import { assetPreview } from "@studio/core/studio/assets/preview";
import type { ModelInfo } from "@studio/core/studio/assets/gltf";
import { getChapter } from "@studio/core/studio/store/chapters";
import { createProject, getProject, updateProject } from "@studio/core/studio/store/projects";
import { getRun, readRunLog } from "@studio/core/studio/store/runs";
import { chooseColours, deleteScene, getScene, moveScene, rollbackScene, setTheme, updatePlan } from "@studio/core/studio/store/scenes";
import { closeSharedRequest } from "@studio/core/studio/store/shared";
import { Orchestrator } from "@studio/core/studio/workflow";
import { exportFormat, MAX_ZOOM } from "@studio/core/studio/export";
import { recommendLength } from "@studio/core/studio/length";
import { assetKeyframes, projectList, projectSnapshot, sceneComparison, sceneDetail } from "./snapshot.js";

const WEB_DIR = path.join(REPO_ROOT, "packages", "web");
const MAX_JSON = 2 * 1024 * 1024;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

/** A mistake in the request, as opposed to a fault in the studio. Shown to the person as it is. */
class Refused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Params = Record<string, string>;
type Handler = (ctx: { params: Params; body: any; req: http.IncomingMessage; res: http.ServerResponse; url: URL }) => unknown | Promise<unknown>;

export interface StudioServer {
  url: string;
  port: number;
  orchestrator: Orchestrator;
  close(): Promise<void>;
}

export async function startServer(studio: Studio, opts: { port?: number; orchestrator?: Orchestrator } = {}): Promise<StudioServer> {
  const o = opts.orchestrator ?? new Orchestrator(studio);
  const projectsDir = path.join(studio.workspaceDir, "projects");
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, pattern: string, handler: Handler) => {
    const keys: string[] = [];
    const source = pattern.replace(/:(\w+)/g, (_, key: string) => (keys.push(key), "([^/]+)"));
    routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
  };
  /** Start background work whose failure is reported through the scene or job it belongs to. */
  const background = (work: Promise<unknown>) => void work.catch(() => undefined);
  const notes = (body: any) => (typeof body?.notes === "string" ? body.notes.trim() : "");

  // ---------- Projects ----------
  route("GET", "/api/projects", () => ({ workspace: studio.workspaceDir, runner: studio.config.runner, projects: projectList(studio) }));
  route("POST", "/api/projects", ({ body }) => {
    const parsed = NewProjectSchema.safeParse(body);
    if (!parsed.success) throw new Refused(parsed.error.issues.map((i) => i.message).join(". "));
    const project = createProject(studio, parsed.data);
    o.startStage(project.id);
    return { slug: project.slug };
  });
  // Asked before a project exists: Claude suggests a length, and the person accepts or changes it in the form.
  route("POST", "/api/recommend-length", async ({ body }) => {
    try {
      return await recommendLength(studio, typeof body?.description === "string" ? body.description : "");
    } catch (err) {
      throw new Refused((err as Error).message);
    }
  });
  route("GET", "/api/projects/:project", ({ params }) => projectSnapshot(studio, o, params.project!));
  route("PATCH", "/api/projects/:project", ({ params, body }) => {
    const project = getProject(studio, params.project!);
    // Only what the request names is changed. A group such as the theme or the music may be sent in part, and the rest of it stays.
    const given: Record<string, unknown> | undefined = body.settings && typeof body.settings === "object" ? body.settings : undefined;
    let patch: Partial<ProjectSettings> = {};
    if (given) {
      const current = project.settings as Record<string, unknown>;
      const group = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
      const merged = Object.fromEntries(Object.entries(given).map(([key, value]) => [key, group(value) && group(current[key]) ? { ...current[key], ...value } : value]));
      const parsed = ProjectSettingsSchema.safeParse({ ...current, ...merged });
      if (!parsed.success) throw new Refused(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(". "));
      patch = Object.fromEntries(Object.entries(parsed.data).filter(([key]) => key in given)) as Partial<ProjectSettings>;
    }
    // A new look puts the scenes already drawn out of date, so it goes through the call that marks them.
    const { theme, ...rest } = patch;
    updateProject(studio, project.id, { title: body.title, description: body.description, targetDurationSec: body.targetDurationSec, settings: given ? rest : undefined });
    const stale = theme ? setTheme(studio, project.id, theme) : [];
    return { ok: true, scenesNowStale: stale.length };
  });
  // The person's own colours and font. Kept by Claude from then on, until they hand the choice back.
  route("POST", "/api/projects/:project/colours", ({ params, body }) => {
    const project = getProject(studio, params.project!);
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
    try {
      const done = chooseColours(studio, project.id, {
        scheme: text(body.scheme),
        palette: body.palette && typeof body.palette === "object" ? body.palette : undefined,
        fontFamily: text(body.fontFamily),
        locked: typeof body.locked === "boolean" ? body.locked : undefined,
      });
      return { ok: true, theme: done.theme, scenesNowStale: done.stale.length, warnings: done.warnings };
    } catch (err) {
      throw new Refused((err as Error).message);
    }
  });
  route("POST", "/api/projects/:project/stage/start", ({ params, body }) => {
    const runs = o.startStage(getProject(studio, params.project!).id, notes(body) || undefined);
    return { started: runs.length };
  });
  route("POST", "/api/projects/:project/stage/approve", ({ params, body }) => ({ stage: o.approveStage(getProject(studio, params.project!).id, notes(body)).stage }));
  route("POST", "/api/projects/:project/assemble", ({ params, body }) => {
    const project = getProject(studio, params.project!);
    background(o.assemble(project.id, { quality: body?.quality === "final" ? "final" : "preview" }).catch((err) => {
      studio.emit("notice", { projectId: project.id, data: { level: "error", message: (err as Error).message } });
    }));
    return { started: true };
  });

  route("POST", "/api/projects/:project/export", ({ params, body }) => {
    const project = getProject(studio, params.project!);
    const format = exportFormat(String(body?.format ?? "landscape"));
    const zoom = body?.zoom === undefined ? 1 : Number(body.zoom);
    if (!(zoom >= 1 && zoom <= MAX_ZOOM)) throw new Error(`The zoom is a number from 1 to ${MAX_ZOOM}.`);
    const chapterId = body?.chapterId ? getChapter(studio, String(body.chapterId)).id : undefined;
    background(o.export(project.id, { format, zoom, chapterId }).catch((err) => {
      studio.emit("notice", { projectId: project.id, data: { level: "error", message: (err as Error).message } });
    }));
    return { started: true };
  });

  route("POST", "/api/projects/:project/stale/rebuild", ({ params }) => ({ scenes: o.rebuildStale(getProject(studio, params.project!).id).length }));
  route("POST", "/api/usage/resume", () => {
    o.resumeNow();
    return { ok: true };
  });

  // ---------- Chapters and scenes ----------
  route("POST", "/api/chapters/:chapter/revise", ({ params, body }) => {
    if (!notes(body)) throw new Refused("Say what should change.");
    getChapter(studio, params.chapter!);
    return { run: o.reviseChapter(params.chapter!, notes(body)).id };
  });
  route("POST", "/api/chapters/:chapter/approve", ({ params }) => {
    const chapter = o.approveChapter(params.chapter!);
    return { status: chapter.status, stage: getProject(studio, chapter.projectId).stage };
  });
  route("POST", "/api/chapters/:chapter/build", ({ params }) => {
    o.buildChapter(params.chapter!);
    return { started: true };
  });
  route("POST", "/api/chapters/:chapter/preview", ({ params }) => {
    const chapter = getChapter(studio, params.chapter!);
    background(o.previewChapter(chapter.id).catch((err) => {
      studio.emit("notice", { projectId: chapter.projectId, data: { level: "error", message: (err as Error).message } });
    }));
    return { started: true };
  });
  route("GET", "/api/scenes/:scene", ({ params }) => sceneDetail(studio, params.scene!));
  route("PATCH", "/api/scenes/:scene/plan", ({ params, body }) => {
    const scene = getScene(studio, params.scene!);
    if (scene.currentVersionId) throw new Refused("This scene has already been built. Ask for changes instead, so the scene is rebuilt to match.");
    updatePlan(studio, scene.id, { title: body.title, narration: body.narration, visualIdea: body.visualIdea, type: body.type });
    return { ok: true };
  });
  route("PUT", "/api/scenes/:scene/references", ({ params, body }) => {
    const scene = getScene(studio, params.scene!);
    const role = body?.role ?? null;
    if (typeof body?.assetId !== "string") throw new Refused("Say which file: assetId.");
    if (role !== null && !(REFERENCE_ROLES as readonly string[]).includes(role)) throw new Refused(`A reference is one of: ${REFERENCE_ROLES.join(", ")}.`);
    const atSec = body.atSec === null || body.atSec === undefined ? null : Number(body.atSec);
    if (atSec !== null && !(atSec >= 0)) throw new Refused("atSec is a time in seconds.");
    setSceneReference(studio, scene.id, role === null ? { assetId: body.assetId, role: null } : { assetId: body.assetId, role, note: String(body.note ?? ""), atSec });
    return { ok: true };
  });
  route("POST", "/api/scenes/:scene/approve", ({ params, body }) => ({ status: o.approveScene(params.scene!, notes(body)).status }));
  route("POST", "/api/scenes/:scene/revise", ({ params, body }) => ({ run: o.reviseScene(params.scene!, notes(body)).id }));
  route("POST", "/api/scenes/:scene/build", ({ params }) => ({ run: o.buildScene(params.scene!).id }));
  route("POST", "/api/scenes/:scene/render", ({ params }) => {
    getScene(studio, params.scene!);
    background(o.renderScene(params.scene!));
    return { started: true };
  });
  route("GET", "/api/scenes/:scene/compare", ({ params, url }) => sceneComparison(studio, params.scene!, Number(url.searchParams.get("a")), Number(url.searchParams.get("b"))));
  route("POST", "/api/scenes/:scene/rollback", ({ params, body }) => ({ status: rollbackScene(studio, params.scene!, Number(body.version)).status }));
  // Changing the order or removing a scene builds nothing: clips and narration belong to each scene. Joined videos show as out of date.
  route("POST", "/api/scenes/:scene/move", ({ params, body }) => {
    if (body?.direction !== "earlier" && body?.direction !== "later") throw new Refused('Say which way: direction is "earlier" or "later".');
    const scene = moveScene(studio, params.scene!, body.direction);
    return { chapterId: scene.chapterId, position: scene.position };
  });
  route("DELETE", "/api/scenes/:scene", ({ params }) => {
    deleteScene(studio, params.scene!);
    return { ok: true };
  });
  route("POST", "/api/shared-requests/:id/close", ({ params, body }) => {
    closeSharedRequest(studio, params.id!, body?.status === "done" ? "done" : "declined");
    return { ok: true };
  });

  // ---------- Assets ----------
  route("POST", "/api/projects/:project/assets", async ({ params, req }) => {
    const project = getProject(studio, params.project!);
    const name = path.basename(decodeURIComponent(String(req.headers["x-file-name"] ?? "")));
    if (!name) throw new Refused("The upload has no file name.");
    // Streamed to a temporary file, so a large clip never sits in memory.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-upload-"));
    const tmp = path.join(tmpDir, name);
    try {
      await new Promise<void>((resolve, reject) => {
        let size = 0;
        const out = fs.createWriteStream(tmp);
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_UPLOAD) req.destroy(new Refused("That file is larger than 2 GB."));
        });
        req.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
        req.pipe(out);
      });
      const asset = await importAsset(studio, project.id, tmp, { originalName: name });
      // A model's pictures take a browser to draw, so they follow in the background. The stand-in runner goes without unless a browser is set.
      if (asset.kind === "model" && (studio.config.runner !== "mock" || studio.config.render.browserExecutable)) {
        background(
          o.lanes
            .run("renders", () => assetPreview(studio, asset.id))
            .then(() => studio.emit("asset.changed", { projectId: project.id, targetId: asset.id })),
        );
      }
      return { id: asset.id, kind: asset.kind, warnings: (asset.meta.model as ModelInfo | undefined)?.warnings ?? [] };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  route("PATCH", "/api/assets/:asset", ({ params, body }) => {
    const asset = getAsset(studio, params.asset!);
    if (body.label !== undefined || body.sourceNote !== undefined) updateAsset(studio, asset.id, { label: body.label, sourceNote: body.sourceNote });
    if (body.reference !== undefined) {
      const role = body.reference?.role ?? null;
      if (role !== null && !(REFERENCE_ROLES as readonly string[]).includes(role)) throw new Refused(`A reference is one of: ${REFERENCE_ROLES.join(", ")}.`);
      setProjectReference(studio, asset.projectId, role === null ? { assetId: asset.id, role: null } : { assetId: asset.id, role, note: String(body.reference.note ?? "") });
      studio.emit("asset.changed", { projectId: asset.projectId, targetId: asset.id });
    }
    return { ok: true };
  });
  route("GET", "/api/assets/:asset/keyframes", ({ params, url }) => assetKeyframes(studio, params.asset!, Number(url.searchParams.get("max")) || undefined));
  route("DELETE", "/api/assets/:asset", ({ params }) => {
    deleteAsset(studio, params.asset!);
    return { ok: true };
  });

  // ---------- Runs ----------
  route("GET", "/api/runs/:run/log", ({ params, url }) => {
    const run = getRun(studio, params.run!);
    return { status: run.status, error: run.error, ...readRunLog(studio, run.id, Number(url.searchParams.get("after") ?? 0)) };
  });
  route("POST", "/api/runs/:run/cancel", ({ params }) => {
    o.cancel(params.run!);
    return { ok: true };
  });

  // ---------- Live updates ----------
  const streams = new Set<http.ServerResponse>();
  let lastEvent = studio.lastEventId();
  const pump = setInterval(() => {
    if (!streams.size) {
      lastEvent = studio.lastEventId();
      return;
    }
    // Runs change the database from their own processes, so new rows are the one place every change shows up.
    const events = studio.eventsAfter(lastEvent);
    if (!events.length) return;
    lastEvent = events.at(-1)!.id;
    const data = events.map((e) => `id: ${e.id}\ndata: ${JSON.stringify({ kind: e.kind, projectId: e.projectId, targetId: e.targetId, data: e.data })}\n\n`).join("");
    for (const res of streams) res.write(data);
  }, 400);
  pump.unref();
  const beat = setInterval(() => {
    for (const res of streams) res.write(": still here\n\n");
  }, 20_000);
  beat.unref();

  // ---------- The GUI itself ----------
  let bundle: { js: string; at: number } | undefined;
  const appJs = async () => {
    const dev = Boolean(process.env.STUDIO_DEV);
    if (bundle && !dev) return bundle.js;
    const result = await build({
      entryPoints: [path.join(WEB_DIR, "src", "main.tsx")],
      bundle: true,
      write: false,
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      minify: !dev,
      sourcemap: dev ? "inline" : false,
      define: { "process.env.NODE_ENV": dev ? '"development"' : '"production"' },
      absWorkingDir: REPO_ROOT,
      logLevel: "silent",
    });
    bundle = { js: result.outputFiles[0]!.text, at: Date.now() };
    return bundle.js;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      // Only pages served from this server may talk to it: another site open in the browser must not.
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) throw new Refused("This server only answers on localhost.", 403);
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new Refused("Requests from other sites are not allowed.", 403);
      if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-studio"] !== "1") throw new Refused("Requests from other sites are not allowed.", 403);

      if (url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": connected\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        for (const r of routes) {
          const match = r.method === req.method ? r.pattern.exec(url.pathname) : null;
          if (!match) continue;
          const params = Object.fromEntries(r.keys.map((key, i) => [key, decodeURIComponent(match[i + 1]!)]));
          const isJson = (req.headers["content-type"] ?? "").includes("application/json");
          const body = isJson ? await readJson(req) : {};
          const result = await r.handler({ params, body, req, res, url });
          return json(res, 200, result ?? { ok: true });
        }
        throw new Refused("There is nothing at this address.", 404);
      }
      if (url.pathname.startsWith("/files/")) return serve(projectsDir, req, res, url.pathname.slice("/files".length), false);
      if (url.pathname === "/app.js") {
        const js = await appJs();
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
        return void res.end(js);
      }
      if (url.pathname === "/app.css") return serve(path.join(WEB_DIR, "src"), req, res, "/styles.css", false);
      // Every other address is a page of the app, which finds its own way from the URL.
      return serve(WEB_DIR, req, res, "/index.html", false);
    } catch (err) {
      const refused = err instanceof Refused;
      // Problems a person can fix, such as approving too early, are thrown as plain errors by the studio.
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, refused ? err.status : /^No (project|scene|chapter|run|asset)\b/.test(message) ? 404 : 400, { error: message });
      else res.end();
    }
  });

  const wanted = opts.port ?? studio.config.studio.port;
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EADDRINUSE" ? new Error(`Port ${wanted} is in use. Is the studio already running? Otherwise pass --port or set STUDIO_PORT.`) : err),
    );
    server.listen(wanted, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return {
    url: `http://localhost:${port}`,
    port,
    orchestrator: o,
    close: async () => {
      clearInterval(pump);
      clearInterval(beat);
      for (const res of streams) res.end();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON) {
        reject(new Refused("That request is too large."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Refused("The request is not valid JSON."));
      }
    });
  });
}
