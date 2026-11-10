/**
 * `display.store.refresh` — what the control window does when a screen comes
 * or goes (`displays-changed`).
 *
 * Main owns the projection window's place (`windows/projector-screen.ts`): it
 * hides it when its screen goes away and puts it back, or onto a projector
 * turned on after launch, without rebuilding it. So the control window only
 * re-lists the screens, for Settings and for the next GO LIVE — and it must
 * never open or move the window itself, or the two would fight over it and a
 * rebuild would restart everything that was playing.
 */
import { beforeEach, expect, test, vi } from "vitest";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { DisplayInfo } from "@shared/types/display";

const LAPTOP: DisplayInfo = {
  id: 1,
  label: "Built-in",
  operator: true,
  bounds: { x: 0, y: 0, width: 1470, height: 956 },
  scaleFactor: 2,
};
const PROJECTOR: DisplayInfo = {
  id: 2,
  label: "Proyector",
  operator: false,
  bounds: { x: 1470, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
};

let screens: DisplayInfo[] = [];
const calls: string[] = [];

beforeEach(() => {
  screens = [LAPTOP];
  calls.length = 0;
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn((channel: string) => {
      calls.push(channel);
      return Promise.resolve({ ok: true, data: channel === "displays:list" ? screens : undefined });
    }),
    on: () => () => {},
  };
  useSettingsStore.setState({ loaded: true });
  useDisplayStore.setState({ displays: [], displayId: null, loaded: false });
});

test("a projector turned on after launch becomes the target, without opening anything", async () => {
  await useDisplayStore.getState().load();
  expect(useDisplayStore.getState().displayId).toBe(LAPTOP.id);

  screens = [LAPTOP, PROJECTOR];
  await useDisplayStore.getState().refresh();
  expect(useDisplayStore.getState().displays).toEqual([LAPTOP, PROJECTOR]);
  expect(useDisplayStore.getState().displayId).toBe(PROJECTOR.id);
  expect(calls.filter((channel) => channel.startsWith("projection:"))).toEqual([]);
});

test("losing the projector's screen while it is on air never moves or reopens the window", async () => {
  screens = [LAPTOP, PROJECTOR];
  await useDisplayStore.getState().load();
  useProjectionStore.getState().setPresentationOpen(true);

  screens = [LAPTOP];
  await useDisplayStore.getState().refresh();
  screens = [LAPTOP, PROJECTOR];
  await useDisplayStore.getState().refresh();

  expect(calls.filter((channel) => channel.startsWith("projection:"))).toEqual([]);
  expect(useProjectionStore.getState().presentationOpen).toBe(true);
});
