/**
 * A face a deck names but this machine lacks falls back to its metric twin, which the app bundles
 * (`slide-fonts.css`). The twin table lived three times and drifted; one of them named «Liberation Sans Narrow» and
 * «Arimo», which the app does not ship (2026-11-15 audit, X7). A slide's text names only twins that are there.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { fontList } from "../../src/main/slides/pptx/text";

const css = fs.readFileSync(path.resolve("src/renderer/src/components/shared/slide-view/slide-fonts.css"), "utf8");
const shipped = new Set([...css.matchAll(/font-family:\s*"([^"]+)"/g)].map((m) => m[1]!));

test("a slide's text names, after the file's own face, only a twin the app ships", () => {
  const faces = ["Calibri", "Calibri Light", "Cambria", "Arial", "Times New Roman", "Courier New", "Arimo", "Tinos", "Cousine", "Arial Narrow"];
  for (const face of faces) {
    const [own, ...twins] = [...fontList(face, null).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(own).toBe(face);
    for (const twin of twins) expect(shipped, `${face} → ${twin}`).toContain(twin);
  }
  expect(fontList("Calibri Light", null)).toBe('"Calibri Light", "Carlito", sans-serif');
  expect(fontList("Tinos", null)).toBe('"Tinos", "Liberation Serif", sans-serif');
  expect(fontList("Arial Narrow", null)).toBe('"Arial Narrow", sans-serif');
});
