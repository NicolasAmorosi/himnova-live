/**
 * Moving to a slide whose model is already warm drew the previous slide once more before the new one: `useSlideModel`
 * handed out its state, set only by an effect after that render (2026-11-15 audit, R25). A warm model is handed out
 * on the very render that asks for it; a cold one still keeps the last slide up until it arrives.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { loadSlideModel, useSlideModel } from "@renderer/lib/slide-models";
import { slideModelUrl } from "@shared/urls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.unstubAllGlobals());

const model = { width: 1, height: 1, background: null, elements: [], fonts: [] };

test("a warm model is handed out on the first render that asks for it", async () => {
  let release = (): void => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url === slideModelUrl(31, 2)
        ? new Promise((resolve) => (release = () => resolve({ ok: true, json: () => Promise.resolve(model) })))
        : Promise.resolve({ ok: true, json: () => Promise.resolve(model) }),
    ),
  );
  const a = slideModelUrl(31, 0);
  const b = slideModelUrl(31, 1);
  const c = slideModelUrl(31, 2);
  await loadSlideModel(a);
  await loadSlideModel(b);

  const rendered: (string | null)[] = [];
  function Probe({ url }: { url: string }) {
    rendered.push(useSlideModel(url)?.url ?? null);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe, { url: a })));
  expect(rendered).toEqual([a]);

  rendered.length = 0;
  act(() => root.render(createElement(Probe, { url: b })));
  expect(rendered, "never the previous slide's model").not.toContain(a);
  expect(rendered[0]).toBe(b);

  // A cold one keeps the last warm slide up, not the one before it.
  rendered.length = 0;
  act(() => root.render(createElement(Probe, { url: c })));
  expect(rendered.every((url) => url === b)).toBe(true);
  await act(() => Promise.resolve(release()));
  expect(rendered.at(-1)).toBe(c);
  act(() => root.unmount());
});
