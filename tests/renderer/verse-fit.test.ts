/**
 * The verse's auto-fit, measured in the window that draws it. jsdom lays nothing out, so the stage's size and the
 * block's height (a function of the font size and of which typeface is "loaded") are stubbed.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { BibleScene } from "@renderer/components/shared/bible-scene";
import { DEFAULT_BIBLE_STYLE } from "@shared/types/bible-style";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Block height per cqw of the verse: Noto's lines are taller than the fallback's. */
let pxPerCqw = 120;
/** The stage's height for a 1000 px wide stage: 562.5 is 16:9. */
let stageHeight = 500;
const fonts = new EventTarget();
const OUTPUT = {
  kind: "bible" as const,
  text: "Porque de tal manera amó Dios al mundo",
  reference: "Juan 3:16",
  versionLabel: null,
  parallel: null,
  style: DEFAULT_BIBLE_STYLE,
  backgroundUrl: null,
} as never;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  stageHeight = 500;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => stageHeight });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
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

/** A projector or NDI window that had drawn no text yet measured the first long verse with the fallback font, and
 *  Noto, taller, then cut its last line and the reference (2026-11-15 audit, A15). */
test("a typeface that arrives after the first measure measures the verse again", () => {
  pxPerCqw = 120; // the fallback: the default 3.5 cqw fits
  act(() => root.render(createElement(BibleScene, { output: OUTPUT })));
  const verse = host.querySelector<HTMLElement>('p[dir="auto"]')!;
  expect(parseFloat(verse.style.fontSize)).toBe(3.5);

  pxPerCqw = 160; // Noto arrived: 3.5 cqw no longer fits
  act(() => {
    fonts.dispatchEvent(new Event("loadingdone"));
  });
  expect(parseFloat(verse.style.fontSize)).toBeLessThan(3.5);
  expect(parseFloat(verse.style.fontSize) * pxPerCqw).toBeLessThanOrEqual(501); // the fit's 1 px tolerance
});

/** The monitors are 16:9: a 16:10 or 4:3 projector measured against its own height chose a bigger size, with other
 *  line breaks, than the LIVE monitor, the NDI and the stage showed (2026-11-15 audit, A14). */
test("a projector taller than 16:9 sizes the verse as the 16:9 monitor does", () => {
  pxPerCqw = 180; // too tall at the default 3.5 cqw either way
  const sizeAt = (height: number) => {
    stageHeight = height;
    act(() => root.render(createElement(BibleScene, { key: height, output: OUTPUT })));
    return parseFloat(host.querySelector<HTMLElement>('p[dir="auto"]')!.style.fontSize);
  };
  const monitor = sizeAt(562.5);
  expect(monitor).toBeLessThan(3.5);
  expect(sizeAt(625)).toBe(monitor); // 16:10
  expect(sizeAt(750)).toBe(monitor); // 4:3
});
