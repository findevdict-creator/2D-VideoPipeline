import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { guessAsset } from "../model/asset.js";

/**
 * Serves a folder on 127.0.0.1 so renders can load images and video by URL instead of
 * copying them into every bundle. Supports range requests, which video needs.
 */
export class FileServer {
  private constructor(
    private readonly server: http.Server,
    readonly baseUrl: string,
  ) {}

  static start(rootDir: string): Promise<FileServer> {
    const root = path.resolve(rootDir);
    const server = http.createServer((req, res) => serve(root, req, res));
    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        // Renders must not keep the process alive after everything else is done.
        server.unref();
        resolve(new FileServer(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      });
    });
  }

  close() {
    this.server.close();
    this.server.closeAllConnections?.();
  }
}

export function serve(root: string, req: http.IncomingMessage, res: http.ServerResponse, urlPath = req.url ?? "/") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(urlPath.split("?")[0]!);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = path.resolve(root, "." + path.posix.normalize("/" + relative));
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    res.writeHead(404).end("Not found");
    return;
  }
  const type = contentType(file);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-cache");
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const size = stat.size;
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    start = Math.max(0, start);
    res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Length": stat.size });
  if (req.method === "HEAD") res.end();
  else fs.createReadStream(file).pipe(res);
}

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") return "application/json";
  if (ext === ".md" || ext === ".txt" || ext === ".log" || ext === ".srt") return "text/plain; charset=utf-8";
  if (ext === ".tsx" || ext === ".ts" || ext === ".py") return "text/plain; charset=utf-8";
  return guessAsset(file).mime;
}
