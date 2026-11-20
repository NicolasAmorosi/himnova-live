import { create } from "zustand";
import { DEFAULT_SETTINGS, type SettingsMap } from "@shared/types/settings";
import { api } from "@renderer/lib/api";

type SettingsStoreState = {
  settings: SettingsMap;
  loaded: boolean;
  load: () => Promise<void>;
  update: (partial: Partial<SettingsMap>) => Promise<void>;
};

/** How long a burst of updates waits to be written as one: a drag of LIVE's fader is a handful of writes, not one per
 *  step. A lone change, with nothing written in the last interval, still goes at once. */
const PERSIST_EVERY_MS = 300;

/** The keys merged in memory and not yet sent to main, and the callers waiting for them. */
let pending: Partial<SettingsMap> | null = null;
let waiting: { resolve: () => void; reject: (error: unknown) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let lastWriteAt = Number.NEGATIVE_INFINITY;

function persistSettings(partial: Partial<SettingsMap>): Promise<void> {
  pending = { ...pending, ...partial };
  const written = new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
  if (timer === null) {
    const wait = lastWriteAt + PERSIST_EVERY_MS - Date.now();
    if (wait <= 0) flushSettings();
    else timer = setTimeout(flushSettings, wait);
  }
  return written;
}

/**
 * Sends what is waiting now. Called by the timer, and before anything that would lose it: a quit asked through
 * `quitRisks` (the message leaves before the close decision, so main writes it first) and the page going away (a
 * reload, the window closing).
 */
export function flushSettings(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (pending === null) return;
  const partial = pending;
  const callers = waiting;
  pending = null;
  waiting = [];
  lastWriteAt = Date.now();
  // Sent now, in this call (an async body runs up to its first await): a message the caller sends next reaches main
  // after it. A throw becomes the rejection below.
  void (async () => api.settings.set(partial))().then(
    () => callers.forEach((caller) => caller.resolve()),
    async (error: unknown) => {
      // The optimistic state is now a lie, and unpicking exactly which keys
      // this write owned would be wrong anyway: another update may have landed
      // in between. Main is the source of truth, so re-read from it. Main
      // refuses a write whole, so every caller in it hears the error.
      await useSettingsStore
        .getState()
        .load()
        .catch(() => undefined);
      callers.forEach((caller) => caller.reject(error));
    },
  );
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushSettings);

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    // What is still waiting for its grouped write is newer than main's copy: kept on top of it.
    const settings = { ...(await api.settings.get()), ...pending };
    set({ settings, loaded: true });
    document.documentElement.dataset["theme"] = settings["ui.theme"];
  },

  /**
   * Merges first, then persists.
   *
   * It used to await the write and merge afterwards, against a snapshot taken
   * before the await. Two settings changed at once (adding a folder to
   * `video` while removing one from `image`, which is a single drag away in
   * the media source bar) each merged into the state as it was *before* the
   * other landed, so whichever resolved second silently threw the first away.
   * Merging synchronously also makes the toggles in Settings behave the way
   * they already appear to: immediately.
   *
   * The write is grouped (`persistSettings`): a fader or a slider moving step by step wrote SQLite on every step
   * (2026-11-15 audit, R16 and R24). The promise settles with the write that carries this call's keys.
   */
  update: (partial) => {
    set({ settings: { ...get().settings, ...partial } });
    if (partial["ui.theme"]) document.documentElement.dataset["theme"] = partial["ui.theme"];
    return persistSettings(partial);
  },
}));

/**
 * What anything newly sent live starts at, 0..1.
 *
 * Read at the moment a track is created rather than subscribed to: changing
 * the default in Settings mid-service must not yank the level of something the
 * operator has already balanced by hand. It lives here, next to the store it
 * reads, so `projection.store` does not have to import an action module and
 * close a cycle around itself.
 */
export function defaultMediaVolume(): number {
  return useSettingsStore.getState().settings["media.volume"];
}
