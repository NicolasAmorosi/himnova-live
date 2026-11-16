/**
 * A few KB of file can ask for hundreds of MB of model (a chart's `ptCount`, an arc's sweep): that string crossed to
 * main, was written to SQLite at once and parsed by every window. The worker keeps a slide past 16 MB as an empty,
 * damaged one (2026-11-15 audit, S5, the worker's half).
 */
import { expect, test } from "vitest";
import { MAX_SLIDE_LAYERS, slideLayers } from "../../src/main/slides/pptx-worker";
import type { SlideModel } from "../../src/shared/types/slide-model";

const slide = (elements: unknown[]): SlideModel =>
  ({ width: 100, height: 50, background: { kind: "solid", color: "rgb(0, 0, 0)" }, elements, fonts: [] }) as unknown as SlideModel;

test("a slide whose model passes 16 MB comes back empty and damaged, its size and background kept", () => {
  const huge = slide(Array.from({ length: 200_000 }, (_, at) => ({ kind: "shape", id: at, path: "M 0 0 L 1 1 ".repeat(10) })));
  expect(JSON.stringify(huge).length).toBeGreaterThan(MAX_SLIDE_LAYERS);
  const kept = slideLayers(huge);
  expect(kept.length).toBeLessThan(1000);
  expect(JSON.parse(kept)).toEqual({ ...slide([]), damaged: true });
});

test("a slide under the cap is its model as is", () => {
  const small = slide([{ kind: "shape", id: 1 }]);
  expect(slideLayers(small)).toBe(JSON.stringify(small));
});
