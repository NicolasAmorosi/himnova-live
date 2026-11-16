/**
 * The verse's auto-fit measured before the typeface arrived kept that size: a projector or NDI window that had drawn
 * no text yet measured the first long verse with the fallback font, and Noto, taller, then cut its last line and the
 * reference (2026-11-15 audit, A15). A font that finishes loading measures it again. jsdom lays nothing out, so the
 * block's height is stubbed as a function of the font size and of which typeface is "loaded".
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { BibleScene } from "@renderer/components/shared/bible-scene";
import { DEFAULT_BIBLE_STYLE } from "@shared/types/bible-style";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Block height per cqw of the verse: Noto's lines are taller than the fallback's. */
let pxPerCqw = 120;
const fonts = new EventTarget();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 500 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const verse = this.querySelector(':scope > p[dir="auto"]');
      return verse instanceof HTMLElement ? parseFloat(verse.style.fontSize) * pxPerCqw : 0;
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test("a typeface that arrives after the first measure measures the verse again", () => {
  pxPerCqw = 120; // the fallback: the default 3.5 cqw fits
  const output = { kind: "bible" as const, text: "Porque de tal manera amó Dios al mundo", reference: "Juan 3:16", versionLabel: null, parallel: null, style: DEFAULT_BIBLE_STYLE, backgroundUrl: null };
  act(() => root.render(createElement(BibleScene, { output: output as never })));
  const verse = host.querySelector<HTMLElement>('p[dir="auto"]')!;
  expect(parseFloat(verse.style.fontSize)).toBe(3.5);

  pxPerCqw = 160; // Noto arrived: 3.5 cqw no longer fits
  act(() => {
    fonts.dispatchEvent(new Event("loadingdone"));
  });
  expect(parseFloat(verse.style.fontSize)).toBeLessThan(3.5);
  expect(parseFloat(verse.style.fontSize) * pxPerCqw).toBeLessThanOrEqual(501); // the fit's 1 px tolerance
});
