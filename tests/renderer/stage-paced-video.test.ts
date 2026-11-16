/**
 * The stage window is a screen people watch: an engine video on it goes up on the page's clock (`FramePacer`), as on
 * the projector and NDI, and not as each frame lands, which on a 30 fps video alternated 17 and 50 ms. The panel's
 * small monitor still draws on arrival (2026-11-15 audit, A32). Only `OutputView`'s render shows it, hence the mount.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { StageView } from "@renderer/components/shared/stage-view";
import { INSTANT_TRANSITION, type ProjectionOutput, type StageOutput } from "@shared/types/projection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIDEO: ProjectionOutput = {
  kind: "video",
  url: "worship://engine/asset/7",
  epoch: 3,
  videoUnderlay: { url: "worship://engine/asset/7", epoch: 3, paused: false, startAtSeconds: 0, volume: 1, loop: false },
  slideVideo: null,
  plates: [],
  transition: INSTANT_TRANSITION,
};
const STAGE: StageOutput = {
  current: VIDEO,
  next: null,
  videoStill: { posterUrl: null, videoUrl: null },
  videoMotion: true,
  countdown: null,
  message: null,
  layout: "musicians",
  hour12: false,
  textScale: 1,
};
const MEDIA = { video: null, slideVideo: null };

let host: HTMLDivElement;
let root: Root;
let drawn: number;
let deliver: ((frame: { displayWidth: number; displayHeight: number }) => void) | null;
let frames: FrameRequestCallback[];

beforeEach(() => {
  drawn = 0;
  deliver = null;
  frames = [];
  const context = { drawImage: () => (drawn += 1) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as never);
  vi.stubGlobal("OffscreenCanvas", class { width = 1; height = 1; getContext = () => ({ drawImage: () => undefined }); });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  (window as unknown as { worship: unknown }).worship = {
    invoke: () => Promise.resolve({ ok: true, data: null }),
    on: () => () => undefined,
    onVideoFrame: (_key: string, callback: typeof deliver) => {
      deliver = callback;
      return () => undefined;
    },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const frame = { displayWidth: 1920, displayHeight: 1080 };

test("the stage window's engine video waits for an animation frame; the panel's monitor draws it as it lands", () => {
  act(() => root.render(createElement(StageView, { media: MEDIA, paced: true, stage: STAGE })));
  expect(deliver).not.toBeNull();
  deliver!(frame);
  expect(drawn).toBe(0);
  for (const callback of frames.splice(0)) callback(16);
  expect(drawn).toBe(1);

  act(() => root.unmount());
  root = createRoot(host);
  act(() => root.render(createElement(StageView, { media: MEDIA, stage: STAGE })));
  drawn = 0;
  deliver!(frame);
  expect(drawn).toBe(1);
});
