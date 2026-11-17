/**
 * A slide grid re-renders on every slide change (the highlighted tile moves): each of its slides was drawn again
 * before `projection-sync` told the projector (2026-11-15 audit, A27). `SlideView` is memoized on what it draws,
 * which needs a `resolve` that is the same function at every render, and the faces a model names loaded before it
 * is handed out: a slide that never draws again must have measured its text in the right face (A41).
 */
import { afterEach, expect, test, vi } from "vitest";
import { SlideView } from "@renderer/components/shared/slide-view/SlideView";
import { loadSlideModel, partResolver, peekSlideModel } from "@renderer/lib/slide-models";
import type { SlideModel } from "@shared/types/slide-model";
import { slideModelUrl } from "@shared/urls";

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "fonts");
});

test("a deck's slides resolve their parts through one function", () => {
  expect(partResolver(slideModelUrl(7, 0))).toBe(partResolver(slideModelUrl(7, 5)));
  expect(partResolver(slideModelUrl(7, 0))).not.toBe(partResolver(slideModelUrl(8, 0)));
});

test("SlideView draws again only when what it draws changes", () => {
  const { compare } = SlideView as unknown as { compare?: (a: object, b: object) => boolean };
  expect(compare, "SlideView is memoized").toBeTypeOf("function");
  const model = { width: 1, height: 1, background: null, elements: [], fonts: [] } as unknown as SlideModel;
  const resolve = partResolver(slideModelUrl(7, 0));
  const props = { model, resolve, text: { fallbackFont: null, locale: "es" } };
  expect(compare!(props, { ...props, text: { fallbackFont: null, locale: "es" } })).toBe(true);
  expect(compare!(props, { ...props, model: { ...model } })).toBe(false);
  expect(compare!(props, { ...props, text: { fallbackFont: "Inter", locale: "es" } })).toBe(false);
  expect(compare!(props, { ...props, text: { fallbackFont: null, locale: "en" } })).toBe(false);
});

test("a model is handed out once the faces its text and charts name have loaded", async () => {
  let release = (): void => {};
  const loading = new Promise<void>((resolve) => (release = resolve));
  const load = vi.fn(() => loading);
  Object.defineProperty(document, "fonts", { configurable: true, value: { load, add: vi.fn(), addEventListener: vi.fn() } });
  const run = { kind: "text", text: "Santo", font: '"Calibri", "Carlito", sans-serif', bold: true, italic: false };
  const chart = { kind: "chart", title: { runs: [{ text: "2026", font: { face: "Open Sans", bold: false, italic: true } }] } };
  const model = { width: 1, height: 1, background: null, fonts: [], elements: [{ text: { paragraphs: [{ runs: [run] }] } }, chart] };
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(model) })));
  const url = slideModelUrl(9, 0);
  const loaded = loadSlideModel(url);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(load).toHaveBeenCalledWith('700 16px "Calibri", "Carlito", sans-serif');
  expect(load).toHaveBeenCalledWith('italic 400 16px "Open Sans"');
  expect(peekSlideModel(url), "not handed out while its faces load").toBeNull();
  release();
  expect(await loaded).toEqual(model);
});
