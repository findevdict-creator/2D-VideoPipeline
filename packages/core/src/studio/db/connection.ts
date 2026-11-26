import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// node:sqlite still prints an "experimental" warning on Node 22. It is stable enough for a
// local single-user database and saves every user a native build step, so hide that one line.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite is an experimental feature")) return;
  return (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

const { DatabaseSync } = await import("node:sqlite");
type DatabaseSyncType = InstanceType<typeof DatabaseSync>;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

type Param = string | number | bigint | null | Uint8Array;
export type Params = Record<string, Param | undefined> | Param[];

/**
 * A small wrapper around the SQLite file. The GUI server, the CLI and each Claude
 * run's MCP server are separate processes sharing one file, so it runs in WAL mode
 * with a busy timeout, and every multi-step change goes through tx().
 */
export class Db {
  private readonly db: DatabaseSyncType;
  private depth = 0;

  constructor(readonly file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  private migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const name of files) {
      // Two processes may start at once: take the write lock before checking.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const done = this.db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name);
        if (!done) {
          this.db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
          this.db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw new Error(`Database migration ${name} failed: ${(err as Error).message}`);
      }
    }
  }

  run(sql: string, params: Params = []) {
    const st = this.db.prepare(sql);
    return Array.isArray(params) ? st.run(...params) : st.run(clean(params));
  }

  get<T>(sql: string, params: Params = []): T | undefined {
    const st = this.db.prepare(sql);
    const row = Array.isArray(params) ? st.get(...params) : st.get(clean(params));
    return row ? ({ ...row } as T) : undefined;
  }

  all<T>(sql: string, params: Params = []): T[] {
    const st = this.db.prepare(sql);
    const rows = Array.isArray(params) ? st.all(...params) : st.all(clean(params));
    return rows.map((r) => ({ ...r }) as T);
  }

  /** Run several statements as one change. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.depth--;
    }
  }

  close() {
    this.db.close();
  }
}

function clean(params: Record<string, Param | undefined>): Record<string, Param> {
  const out: Record<string, Param> = {};
  for (const [k, v] of Object.entries(params)) out[k] = v === undefined ? null : v;
  return out;
}
