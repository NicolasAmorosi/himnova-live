/**
 * A banner's ticker measures the length of its loop from the laid-out text: measured with the fallback font before
 * Noto arrived, the loop was the wrong length and the line jumped on every turn (2026-11-15 audit, A15). A font that
 * finishes loading starts the loop again from a new measure. jsdom lays nothing out and has no Web Animations, so
 * both are stubbed.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { PlateLayer } from "@renderer/components/shared/plate-layer";
import { DEFAULT_PLATE_STYLE } from "@shared/types/overlay";
import type { ProjectionPlate } from "@shared/types/projection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("a typeface that arrives after the ticker started measures its loop again", () => {
  const fonts = new EventTarget();
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  let textWidth = 800; // the fallback's
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => textWidth * 2 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1000 });
  const loops: number[] = [];
  HTMLElement.prototype.animate = vi.fn(function (keyframes: Keyframe[] | PropertyIndexedKeyframes | null) {
    const end = Array.isArray(keyframes) ? String(keyframes[1]?.transform ?? "") : "";
    const shift = /translateX\(-(\d+)px\)/.exec(end);
    if (shift) loops.push(Number(shift[1]));
    return { cancel: () => undefined, onfinish: null } as unknown as Animation;
  });

  const plate: ProjectionPlate = {
    id: 1,
    kind: "banner",
    position: "bottom-center",
    title: "Bienvenidos a la iglesia",
    subtitle: null,
    imageUrl: null,
    style: { ...DEFAULT_PLATE_STYLE, ticker: { enabled: true, speedCqw: 10 } },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(PlateLayer, { plates: [plate] })));
  expect(loops).toEqual([800]);

  textWidth = 860; // Noto arrived, wider
  act(() => {
    fonts.dispatchEvent(new Event("loadingdone"));
  });
  expect(loops).toEqual([800, 860]);
  act(() => root.unmount());
  host.remove();
});
