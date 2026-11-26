/**
 * Quick checks on a scene file's source for things the type checker does not catch
 * but that break rendering or make renders differ from run to run.
 */
const ALLOWED_IMPORTS = new Set(["@pipeline/lib", "remotion", "react"]);

export function checkSceneSource(code: string): string[] {
  const problems: string[] = [];
  if (!/export\s+default\b/.test(code)) {
    problems.push("The file must default-export the scene component (export default function Scene() {...}).");
  }
  const imports = [
    // import x from "m"; import { a, b } from "m" (also across lines); export { a } from "m"
    ...code.matchAll(/^\s*import\s[^;"'`]*?\bfrom\s*["']([^"']+)["']/gm),
    ...code.matchAll(/^\s*export\s*(?:type\s*)?(?:\*(?:\s*as\s+\w+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/gm),
    // import "m";
    ...code.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    // import("m"), require("m")
    ...code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g),
  ];
  for (const m of imports) {
    const mod = m[1]!;
    if (!ALLOWED_IMPORTS.has(mod)) {
      problems.push(`Import from "${mod}" is not allowed. Use only "@pipeline/lib", "remotion" and "react".`);
    }
  }
  if (/\bMath\.random\s*\(/.test(code)) {
    problems.push('Math.random() makes every render different. Use random("some-seed") from "remotion".');
  }
  if (/@keyframes|\b(?:transition|animation)\s*:\s*["'`][^"'`]*\d(?:\.\d+)?m?s\b/.test(code)) {
    problems.push("CSS transitions, animations and @keyframes do not render. Drive motion from useCurrentFrame() with interpolate().");
  }
  if (/\bhttps?:\/\//.test(code.replace(/(^|\s)\/\/.*$|\/\*[\s\S]*?\*\//gm, "$1"))) {
    problems.push("Nothing may be loaded from the internet. Draw it with the library's icons and SVG instead.");
  }
  if (/\b(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/.test(code)) {
    problems.push("Timers do not work in renders. Derive everything from useCurrentFrame().");
  }
  return problems;
}
