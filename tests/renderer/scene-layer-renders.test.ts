/**
 * A media status arrives ~4 times a second, and the LIVE monitor, the NDI copy and the stage re-render `OutputView`
 * with it: the scene under the video was drawn again each time, a model slide included. PREVIEW's hook builds a new
 * output object at every render, and each one drew its scene a second time (2026-11-15 audit, R22). Only
 * `OutputView`'s render shows it, hence the mount; the scene's picture is counted through `StageImage`.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MediaStatus } from "@shared/types/projection";

const drawn = vi.hoisted(() => ({ count: 0 }));
vi.mock("@renderer/components/shared/stage-image", async (original) => {
  const real = await original<typeof import("@renderer/components/shared/stage-image")>();
  return {
    StageImage: (props: Parameters<typeof real.StageImage>[0]) => {
      drawn.count += 1;
      return real.StageImage(props);
    },
  };
});

const { OutputView } = await import("@renderer/components/shared/output-view");
const { selectOutput, useProjectionStore } = await import("@renderer/stores/projection.store");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = () => useProjectionStore.getState();
const status = (seconds: number): MediaStatus => ({
  target: { kind: "video" },
  epoch: 1,
  currentTimeSeconds: seconds,
  durationSeconds: 60,
  paused: false,
  ended: false,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  drawn.count = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test("a media status, or the same scene in a new object, does not draw the scene again", () => {
  store().beginScene();
  store().setBase({ kind: "image", assetId: 1 });
  store().setOverlay("none");
  const output = selectOutput(store());
  const render = (props: Partial<Parameters<typeof OutputView>[0]>) =>
    act(() => root.render(createElement(OutputView, { mode: "monitor", output, ...props })));

  render({ liveVideoStatus: status(1) });
  const first = drawn.count;
  expect(first).toBeGreaterThan(0);
  render({ liveVideoStatus: status(1.25) });
  render({ liveVideoStatus: status(1.5) });
  expect(drawn.count, "a status alone").toBe(first);
  render({ liveVideoStatus: status(1.5), output: selectOutput(store()) });
  expect(drawn.count, "the same scene in a new object").toBe(first);

  store().setBase({ kind: "image", assetId: 2 });
  render({ liveVideoStatus: status(1.5), output: selectOutput(store()) });
  expect(drawn.count, "a new picture is drawn").toBeGreaterThan(first);
});
