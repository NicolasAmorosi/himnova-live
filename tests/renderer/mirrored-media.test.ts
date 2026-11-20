/**
 * The full-screen video and a slide's clip drive their `<video>` through one hook, `useMirroredMedia` (2026-11-15
 * audit, X13). They had drifted apart: the clip still preloaded "metadata" on the projector and its copies, the setting
 * a 4K start had shown to leave the decoder cold after the first seek, which only the full-screen video had left.
 * Only `OutputView`'s render shows the attribute, hence the mount.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { OutputView, type OutputViewMode } from "@renderer/components/shared/output-view";
import { INSTANT_TRANSITION, type ProjectionOutput } from "@shared/types/projection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLIDE_WITH_CLIP: ProjectionOutput = {
  kind: "slide",
  deckAssetId: 1,
  url: "worship://slide/1/1",
  modelUrl: null,
  index: 1,
  total: 1,
  preload: [],
  enter: null,
  text: { fallbackFont: null, locale: "es" },
  videoUnderlay: null,
  slideVideo: {
    url: "worship://asset/9",
    epoch: 4,
    rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    aspectRatio: 16 / 9,
    loop: false,
    paused: false,
    startAtSeconds: 0,
    volume: 1,
  },
  plates: [],
  transition: INSTANT_TRANSITION,
};
const VIDEO: ProjectionOutput = {
  kind: "video",
  url: "worship://asset/7",
  epoch: 3,
  videoUnderlay: { url: "worship://asset/7", epoch: 3, paused: false, startAtSeconds: 0, volume: 1, loop: false },
  slideVideo: null,
  plates: [],
  transition: INSTANT_TRANSITION,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.load = () => undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const preloadOf = (output: ProjectionOutput, mode: OutputViewMode) => {
  act(() => root.render(createElement(OutputView, { key: mode, mode, output })));
  return host.querySelector("video")?.preload;
};

test("a slide's clip buffers like the full-screen video wherever it plays", () => {
  expect(preloadOf(VIDEO, "live")).toBe("auto");
  expect(preloadOf(VIDEO, "monitor")).toBe("auto");
  expect(preloadOf(VIDEO, "preview")).toBe("metadata");
  expect(preloadOf(SLIDE_WITH_CLIP, "live")).toBe("auto");
  expect(preloadOf(SLIDE_WITH_CLIP, "monitor")).toBe("auto");
});
