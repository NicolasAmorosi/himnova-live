import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The control window's radius scale (owner, 2026-11-04, GitHub's Primer):
 * `rounded-sm` (4), `rounded-md` (6), `rounded-xl` (12, what floats) and
 * `rounded-full` (only what is not a control). This keeps the retired ones from
 * coming back one class at a time: `rounded-lg`, `rounded-2xl`, `rounded-3xl`
 * (on any side) and the bare `rounded`. An arbitrary `rounded-[…]` is the
 * logo's own shape and nothing else's.
 */
const ROOT = join(__dirname, "../../src/renderer/src");
const RETIRED = /^rounded(-(t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(-(lg|2xl|3xl))?$/;
const ARBITRARY_ALLOWED = new Set(["components/ui/brand.tsx"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Every class-looking token inside a string literal, comments stripped first
 *  (they talk ABOUT classes, e.g. «the bare `rounded`»). */
function classTokens(code: string): string[] {
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const literals = [...stripped.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? "");
  return literals.flatMap((literal) => literal.split(/\s+/)).map((token) => token.split(":").pop() ?? "");
}

function offenders(file: string): string[] {
  const rel = relative(ROOT, file);
  return classTokens(readFileSync(file, "utf8")).filter((token) => {
    if (token.startsWith("rounded-[")) return !ARBITRARY_ALLOWED.has(rel);
    return RETIRED.test(token);
  });
}

describe("radius scale", () => {
  it("flags the retired classes, and only those", () => {
    expect(classTokens('cn("rounded-lg p-2", `hover:rounded-2xl ${x}`) // rounded-lg in a comment')).toEqual([
      "rounded-lg",
      "p-2",
      "rounded-2xl",
      "${x}",
    ]);
    const retired = ["rounded", "rounded-lg", "rounded-2xl", "rounded-t-lg", "rounded-tr", "rounded-3xl"];
    const kept = ["rounded-sm", "rounded-md", "rounded-xl", "rounded-full", "rounded-none", "rounded-t-md", "rounded-tr-sm"];
    expect(retired.filter((token) => RETIRED.test(token))).toEqual(retired);
    expect(kept.filter((token) => RETIRED.test(token))).toEqual([]);
  });

  it("no source in the renderer uses a retired radius", () => {
    const found = sources(ROOT).flatMap((file) => offenders(file).map((token) => `${relative(ROOT, file)}: ${token}`));
    expect(found).toEqual([]);
  });
});
