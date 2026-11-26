/**
 * The studio's MCP server. One is started for each Claude run, over stdio, with the run's
 * id in its environment; that id decides which tools may change what.
 *
 *   STUDIO_WORKSPACE   the workspace folder
 *   STUDIO_PROJECT_ID  the project the session works on
 *   STUDIO_RUN_ID      the run it belongs to. Without it the session can only read.
 */
import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "@studio/core/config";
import { REPO_ROOT } from "@studio/core/paths";
import { Studio } from "@studio/core/studio/studio";
import { getProject } from "@studio/core/studio/store/projects";
import { appendRunLog, getRun, type AgentRun } from "@studio/core/studio/store/runs";
import { callTool, TOOLS, type ToolContext } from "@studio/core/studio/tools/index";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

async function main() {
  const projectId = process.env.STUDIO_PROJECT_ID;
  if (!projectId) throw new Error("STUDIO_PROJECT_ID is not set. The studio starts this server; it is not meant to be run by hand.");
  const studio = new Studio(loadConfig({ rootDir: REPO_ROOT }));
  const project = getProject(studio, projectId);
  let run: AgentRun | undefined;
  if (process.env.STUDIO_RUN_ID) {
    run = getRun(studio, process.env.STUDIO_RUN_ID);
    if (run.projectId !== project.id) throw new Error("The run does not belong to this project.");
  }
  const ctx: ToolContext = {
    studio,
    projectId: project.id,
    run,
    // stdout carries the protocol, so notes go to the run's log.
    log: (message) => run && appendRunLog(studio, run, "info", message),
  };

  // A run only sees the tools it may call: reading tools, and the writing tools of its kind.
  const visible = TOOLS.filter((t) => !t.writers || (run && t.writers.includes(run.targetKind)));
  const server = new Server({ name: "studio", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visible.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as { type: "object"; [key: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callTool(ctx, request.params.name, request.params.arguments ?? {});
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
      { type: "text", text: JSON.stringify(result.images.length ? { ...result.output, images: result.images.map((i) => i.caption) } : result.output) },
    ];
    for (const image of result.images) {
      const mimeType = MIME[path.extname(image.file).toLowerCase()];
      if (!mimeType || !fs.existsSync(image.file)) continue;
      content.push({ type: "text", text: image.caption });
      content.push({ type: "image", data: fs.readFileSync(image.file).toString("base64"), mimeType });
    }
    return { content, isError: !result.ok };
  });

  await server.connect(new StdioServerTransport());
  const stop = () => {
    studio.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdin.on("close", stop);
}

main().catch((err) => {
  console.error(`studio MCP server: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
