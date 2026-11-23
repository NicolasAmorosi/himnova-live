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
import { DEFAULT_SETTINGS, type SettingsMap } from "@shared/types/settings";

const LAPTOP: DisplayInfo = {
  id: 1,
  label: "Built-in",
  operator: true,
  bounds: { x: 0, y: 0, width: 1470, height: 956 },
  scaleFactor: 2,
  fitKey: "Built-in|2940x1912",
};
const PROJECTOR: DisplayInfo = {
  id: 2,
  label: "Proyector",
  operator: false,
  bounds: { x: 1470, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
  fitKey: "Proyector|1920x1080",
};

let screens: DisplayInfo[] = [];
/** What main's settings hold. */
let mainSettings: SettingsMap = DEFAULT_SETTINGS;
const calls: string[] = [];

beforeEach(() => {
  screens = [LAPTOP];
  mainSettings = DEFAULT_SETTINGS;
  calls.length = 0;
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn((channel: string) => {
      calls.push(channel);
      const data =
        channel === "displays:list"
          ? screens
          : channel === "settings:get"
            ? mainSettings
            : channel === "projection:open"
              ? true
              : undefined;
      return Promise.resolve({ ok: true, data });
    }),
    on: () => () => {},
  };
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
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

test("moving the projector to another screen clears «Pantalla desconectada»: the new window is on a screen", async () => {
  screens = [LAPTOP, PROJECTOR];
  await useDisplayStore.getState().load();
  useProjectionStore.getState().setPresentationOpen(true);
  // Its screen went away (main hid the window), and the operator moves the projector role elsewhere: main recreates
  // the window there and never says `connected: true`, so the LIVE header kept the warning (2026-11-15 audit, U4).
  useDisplayStore.setState({ projectorHidden: true });
  await useDisplayStore.getState().setDisplayId(LAPTOP.id);
  expect(calls).toContain("projection:open");
  expect(useDisplayStore.getState().projectorHidden).toBe(false);

  useProjectionStore.getState().setPresentationOpen(false);
  useDisplayStore.setState({ projectorHidden: true });
  await useDisplayStore.getState().open();
  expect(useDisplayStore.getState().projectorHidden).toBe(false);
});

test("a role main found again under a new id reaches the control window on the next screen change", async () => {
  const STAGE: DisplayInfo = { ...PROJECTOR, id: 3, label: "Escenario", bounds: { ...PROJECTOR.bounds, x: -1920 } };
  const settings = { ...DEFAULT_SETTINGS, "projection.displayId": PROJECTOR.id, "stage.displayId": STAGE.id };
  useSettingsStore.setState({ settings });
  screens = [LAPTOP, PROJECTOR, STAGE];
  await useDisplayStore.getState().load();
  expect(useDisplayStore.getState().displayId).toBe(PROJECTOR.id);

  // Windows renumbered the screens; main recognized both (`reconcileDisplayRoles`) and rewrote the two ids.
  screens = [LAPTOP, { ...STAGE, id: 30 }, { ...PROJECTOR, id: 20 }];
  mainSettings = { ...settings, "projection.displayId": 20, "stage.displayId": 30 };
  await useDisplayStore.getState().refresh();
  expect(useSettingsStore.getState().settings["projection.displayId"]).toBe(20);
  expect(useSettingsStore.getState().settings["stage.displayId"]).toBe(30);
  // Not the first free screen, which is now the stage's.
  expect(useDisplayStore.getState().displayId).toBe(20);
});
