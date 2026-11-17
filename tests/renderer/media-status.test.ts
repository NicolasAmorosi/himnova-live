/**
 * `setMediaStatus`: the engine reports ~4 times a second even paused. A report equal to the one kept is no change:
 * every reader of the map (the LIVE panel whole) re-rendered 3.5 times a second under LOGO (2026-11-15 audit, R4).
 */
import { beforeEach, expect, test } from "vitest";
import { useProjectionStore } from "@renderer/stores/projection.store";
import type { MediaStatus } from "@shared/types/projection";

const initial = useProjectionStore.getState();
beforeEach(() => useProjectionStore.setState(initial, true));

const report = (overrides: Partial<MediaStatus> = {}): MediaStatus => ({
  target: { kind: "video" },
  epoch: 3,
  currentTimeSeconds: 12.5,
  durationSeconds: 60,
  paused: true,
  ended: false,
  ...overrides,
});

test("the same paused report again notifies nobody", () => {
  const { setMediaStatus } = useProjectionStore.getState();
  setMediaStatus(report());
  let notified = 0;
  const off = useProjectionStore.subscribe(() => (notified += 1));
  for (let i = 0; i < 10; i += 1) setMediaStatus(report());
  off();
  expect(notified).toBe(0);
});

test("the same playing report again still reaches subscribers (a disk stall keeps the deck's slide on the music)", () => {
  const { setMediaStatus } = useProjectionStore.getState();
  setMediaStatus(report({ paused: false }));
  let notified = 0;
  const off = useProjectionStore.subscribe(() => (notified += 1));
  for (let i = 0; i < 10; i += 1) setMediaStatus(report({ paused: false }));
  off();
  expect(notified).toBe(10);
});

test.each<[string, Partial<MediaStatus>]>([
  ["position", { currentTimeSeconds: 12.75 }],
  ["epoch", { epoch: 4 }],
  ["duration", { durationSeconds: 61 }],
  ["paused", { paused: false }],
  ["ended", { ended: true }],
  ["target", { target: { kind: "slideVideo" } }],
])("a report that moves the %s is written", (_, change) => {
  const { setMediaStatus } = useProjectionStore.getState();
  setMediaStatus(report());
  setMediaStatus(report(change));
  const kept = Object.values(useProjectionStore.getState().mediaStatus);
  expect(kept).toContainEqual(report(change));
});
