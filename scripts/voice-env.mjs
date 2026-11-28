// What the voice setup scripts share: finding a Python, making an environment, running a speech job.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const windows = process.platform === "win32";

export const venvPython = (name) => (windows ? path.join(root, name, "Scripts", "python.exe") : path.join(root, name, "bin", "python"));

export function fail(message) {
  console.error(`\nSetup failed: ${message}`);
  process.exit(1);
}

export function run(cmd, args, { optional = false } = {}) {
  console.log(`> ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root });
  if (r.status !== 0 && !optional) fail(`Command failed: ${cmd} ${args.join(" ")}`);
  return r.status === 0;
}

export function pythonVersion(cmd, args = []) {
  const r = spawnSync(cmd, [...args, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return undefined;
  const [major, minor] = r.stdout.trim().split(".").map(Number);
  return { major, minor, text: r.stdout.trim() };
}

export const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};

/** A Python 3.x with x among `minors`, the first of them that is installed. */
export function findPython(minors, what) {
  const given = flag("--python");
  const candidates = given
    ? [[given, []]]
    : windows
      ? [...minors.map((m) => ["py", [`-3.${m}`]]), ["python", []], ["python3", []]]
      : [...minors.map((m) => [`python3.${m}`, []]), ["python3", []], ["python", []]];
  const tried = [];
  for (const [cmd, args] of candidates) {
    const v = pythonVersion(cmd, args);
    if (!v) continue;
    tried.push(`${[cmd, ...args].join(" ")} (${v.text})`);
    if (v.major === 3 && minors.includes(v.minor)) return { cmd, args, version: v.text };
  }
  fail(
    `${what} needs Python ${minors.map((m) => `3.${m}`).join(" or ")}. ` +
      (tried.length ? `Found only: ${tried.join(", ")}. ` : "No Python found. ") +
      `Install Python 3.12 from https://www.python.org/downloads/ and run this again, or pass --python <path-to-python>.`,
  );
}

/** Speak a job with one of the scripts in python/. Returns true when it worked. */
export function speak(python, script, job) {
  const r = spawnSync(python, [path.join(root, "python", ...script)], { input: JSON.stringify(job), encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], cwd: root });
  return r.status === 0;
}

export { existsSync, path };
