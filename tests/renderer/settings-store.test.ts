/**
 * `settings.store.update` merges at once and groups its writes: LIVE's fader and the verse style's sliders wrote SQLite
 * on every step, 79 writes in one fade-out (2026-11-15 audit, R16 and R24). Nothing may be lost on the way: what waits
 * is sent before a quit and when the page goes, and a refused write still reaches every caller.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, type SettingsMap } from "@shared/types/settings";

const h = vi.hoisted(() => ({
  set: vi.fn<(partial: Partial<SettingsMap>) => Promise<void>>(),
  get: vi.fn<() => Promise<SettingsMap>>(),
}));
vi.mock("@renderer/lib/api", () => ({ api: { settings: { set: h.set, get: h.get } } }));

const { flushSettings, useSettingsStore } = await import("@renderer/stores/settings.store");

const settings = () => useSettingsStore.getState().settings;
const update = (partial: Partial<SettingsMap>) => useSettingsStore.getState().update(partial);
let clock = Date.now();

beforeEach(() => {
  vi.useFakeTimers();
  // Far from any write of an earlier test.
  clock += 60_000;
  vi.setSystemTime(clock);
  h.set.mockReset().mockResolvedValue(undefined);
  h.get.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
});

afterEach(() => {
  flushSettings();
  vi.useRealTimers();
});

test("a fade-out of 60 steps is two writes, and every step is in memory at once", async () => {
  const steps = Array.from({ length: 60 }, (_, i) => update({ "audio.live.volume": (60 - i) / 100 }));
  // The first goes at once: a lone change (a toggle, a screen) reaches main as it always did.
  expect(h.set.mock.calls).toEqual([[{ "audio.live.volume": 0.6 }]]);
  expect(settings()["audio.live.volume"]).toBe(0.01);

  await vi.advanceTimersByTimeAsync(300);
  expect(h.set.mock.calls).toEqual([[{ "audio.live.volume": 0.6 }], [{ "audio.live.volume": 0.01 }]]);
  await expect(Promise.all(steps)).resolves.toHaveLength(60);
});

test("keys from several calls go together, the last value of each", async () => {
  void update({ "bible.parallelVersionId": 2 });
  const grouped = [update({ "audio.live.volume": 0.5 }), update({ "audio.live.muted": true }), update({ "audio.live.volume": 0.4 })];
  await vi.advanceTimersByTimeAsync(300);
  expect(h.set.mock.calls[1]).toEqual([{ "audio.live.volume": 0.4, "audio.live.muted": true }]);
  await Promise.all(grouped);
});

test("what waits is sent before a quit and when the page goes, without waiting for its turn", () => {
  void update({ "audio.live.volume": 0.9 });
  void update({ "audio.live.volume": 0.8 });
  flushSettings();
  expect(h.set.mock.calls[1]).toEqual([{ "audio.live.volume": 0.8 }]);

  void update({ "audio.live.volume": 0.7 });
  window.dispatchEvent(new Event("pagehide"));
  expect(h.set.mock.calls[2]).toEqual([{ "audio.live.volume": 0.7 }]);
});

test("a refused write reaches every caller in it, and the state is main's again, with what still waits on top", async () => {
  void update({ "ui.theme": "light" }).catch(() => undefined);
  h.set.mockRejectedValueOnce(new Error("disk full"));
  const refused = [update({ "audio.live.volume": 0.5 }), update({ "audio.live.muted": true })];
  const caught = Promise.allSettled(refused);
  await vi.advanceTimersByTimeAsync(300);
  // A newer change, made while main is read again.
  void update({ "bible.parallelVersionId": 2 });
  expect((await caught).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(h.get).toHaveBeenCalledOnce();
  expect(settings()["audio.live.volume"]).toBe(DEFAULT_SETTINGS["audio.live.volume"]);
  expect(settings()["bible.parallelVersionId"]).toBe(2);
});
