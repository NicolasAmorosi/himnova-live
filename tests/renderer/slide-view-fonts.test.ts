/**
 * A slide memoized on what it draws (A27) measured its text once: a face that finished loading after that first draw
 * (past the model's wait, a font slow to arrive) left the slide measured with the fallback for good, wrong baselines
 * and widths on the projector (2026-11-15 audit, A41). A face that finishes loading draws the slides again.
 */
import { act, createElement, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import type { SlideModel } from "@shared/types/slide-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("a face that finishes loading draws a memoized slide again", async () => {
  const fonts = new EventTarget();
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  const { SlideView } = await import("@renderer/components/shared/slide-view/SlideView");
  const model = { width: 1, height: 1, background: null, elements: [], fonts: [] } as unknown as SlideModel;
  const resolve = (part: string) => part;
  let commits = 0;
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() =>
    root.render(createElement(Profiler, { id: "slide", onRender: () => (commits += 1) }, createElement(SlideView, { model, resolve }))),
  );
  expect(commits).toBe(1);
  act(() => {
    fonts.dispatchEvent(new Event("loadingdone"));
  });
  expect(commits).toBe(2);
  act(() => root.unmount());
});
