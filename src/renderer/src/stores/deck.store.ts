import { create } from "zustand";
import { api } from "@renderer/lib/api";
import { IpcError } from "@shared/ipc/result";
import type { DeckDTO, DeckProgress, DeckStatus, PrewarmProgress } from "@shared/types/deck";

export type DeckEntry = {
  status: DeckStatus;
  progress: { done: number; total: number };
  deck: DeckDTO | null;
  error: string | null;
};

/** One tracked "Prepare folder/view" batch — `null` when none is running.
 *  Mirrors `PrewarmProgress` from main; the terminal statuses stay in this
 *  store just long enough for the UI to render the wrap-up before the caller
 *  clears it (`clearPrewarmBatch`). */
export type PrewarmBatchState = PrewarmProgress;

type DeckStoreState = {
  byAssetId: Record<number, DeckEntry>;
  prewarmBatch: PrewarmBatchState | null;
  /** Bumped every time any deck reaches `ready`. A counter, deliberately, and
   *  not something derived from `byAssetId`: the library grid needs to know
   *  "another deck finished, re-read the statuses", and computing that by
   *  counting entries meant an O(n) scan of the whole map on every store
   *  notification — during a folder batch, hundreds of times over hundreds of
   *  entries. */
  readyEpoch: number;

  /** Cache-only peek — never starts a conversion, so listing a playlist can't
   *  kick off work by accident. */
  peek: (assetId: number) => Promise<DeckDTO | null>;
  ensure: (assetId: number, force?: boolean) => Promise<DeckDTO | null>;
  applyProgress: (progress: DeckProgress) => void;
  /** Bumps `readyEpoch` on its own, for the case where main's answer to
   *  `deck:statuses` changed without any deck converting — the startup
   *  content-hash backfill. Nothing about `byAssetId` is affected: the
   *  decks were already cached, only main's ability to say so changed. */
  markStatusesChanged: () => void;
  markStale: (assetId: number) => void;
  /** Re-reads every entry built from `deckId`: main made one of its embedded
   *  clips playable (`deck-updated`), so its DTO now lists something new. */
  refreshDeck: (deckId: number) => void;
  /** Cancels a deck that's converting or waiting in main's background queue
   *  right now — main's own `deck-progress` push (a `stale` status) is what
   *  actually updates `byAssetId`; this just relays the request. */
  cancelConversion: (assetId: number) => void;
  /** Starts one tracked batch over `assetIds` (whatever the caller already
   *  has on screen — a library tab or a linked folder's current list). */
  startBatchPrewarm: (assetIds: number[], label: string) => Promise<void>;
  cancelBatchPrewarm: () => Promise<void>;
  applyPrewarmProgress: (progress: PrewarmProgress) => void;
  clearPrewarmBatch: () => void;
};

/** In-flight ensure() calls, so the preview effect and "GO LIVE" firing within
 *  milliseconds of each other share one request (main dedupes too, but this
 *  keeps the store from thrashing). */
const pending = new Map<number, Promise<DeckDTO | null>>();

/**
 * Which request for an asset the store still cares about.
 *
 * Cancelling only dropped the `pending` entry — the request itself stayed in
 * flight and wrote its result into `byAssetId` whenever it finally settled,
 * putting a deck the operator explicitly cancelled back to `ready` (or, worse,
 * to `failed` with an error about work nobody wanted any more) on top of the
 * `stale` status main had already pushed. A forced reconversion superseding an
 * in-flight one had the same shape.
 */
const generation = new Map<number, number>();

function supersede(assetId: number): number {
  const next = (generation.get(assetId) ?? 0) + 1;
  generation.set(assetId, next);
  return next;
}

function isCurrent(assetId: number, gen: number): boolean {
  return (generation.get(assetId) ?? 0) === gen;
}

function entryFor(deck: DeckDTO): DeckEntry {
  return {
    status: deck.status,
    progress: { done: deck.slideCount, total: deck.slideCount },
    deck,
    error: deck.error,
  };
}

export const useDeckStore = create<DeckStoreState>((set, get) => ({
  byAssetId: {},
  prewarmBatch: null,
  readyEpoch: 0,

  refreshDeck: (deckId) => {
    for (const [assetId, entry] of Object.entries(get().byAssetId)) {
      if (entry.deck?.deckId === deckId) void get().peek(Number(assetId)).catch(() => undefined);
    }
  },

  peek: async (assetId) => {
    const deck = await api.deck.get(assetId);
    if (deck) set((s) => ({ byAssetId: { ...s.byAssetId, [assetId]: entryFor(deck) } }));
    return deck;
  },

  ensure: async (assetId, force = false) => {
    const existing = pending.get(assetId);
    if (existing && !force) return existing;

    const current = get().byAssetId[assetId];
    // A deck already `ready` in the store is, by definition, not converting
    // — flipping it to `converting` here was cosmetic, not real: main's own
    // `deck:ensure` resolves such a deck via its own cache hit in
    // milliseconds and never actually does any work. Skipping the flip (and
    // still firing the IPC call below, for the `touchDeck`/relink side
    // effects) is what stops an already-prepared deck from flashing
    // "Converting slides… N of N" on its way to GO LIVE. A genuine
    // reconversion (`force`) always shows it.
    if (!force && current?.status === "ready" && current.deck) {
      // fall through to the request below without touching byAssetId
    } else {
      set((s) => ({
        byAssetId: {
          ...s.byAssetId,
          [assetId]: {
            status: "converting",
            // Never inherit a previous run's numbers — a real conversion
            // starts at 0/0 ("preparing") and grows from there; carrying
            // over an old deck's slide count is what produced the false
            // "8 of 8" for work that hadn't started.
            progress: { done: 0, total: 0 },
            deck: s.byAssetId[assetId]?.deck ?? null,
            error: null,
          },
        },
      }));
    }

    const gen = supersede(assetId);
    const request: Promise<DeckDTO | null> = api.deck
      .ensure(assetId, force)
      .then((deck) => {
        if (!isCurrent(assetId, gen)) return null;
        set((s) => ({ byAssetId: { ...s.byAssetId, [assetId]: entryFor(deck) } }));
        return deck;
      })
      .catch((error: unknown) => {
        if (!isCurrent(assetId, gen)) return null;
        const message = error instanceof Error ? error.message : String(error);
        // A cancellation is not a failure: main only cancels a read because
        // the app is quitting, so surfacing it as "couldn't convert" would be
        // a wrong error message.
        const canceled = error instanceof IpcError && error.code === "CANCELED";
        set((s) => ({
          byAssetId: {
            ...s.byAssetId,
            [assetId]: {
              status: canceled ? "stale" : "failed",
              progress: { done: 0, total: 0 },
              deck: s.byAssetId[assetId]?.deck ?? null,
              error: canceled ? null : message,
            },
          },
        }));
        return null;
      })
      .finally(() => {
        // Identity-checked: a superseded request settling later must not
        // delete the entry belonging to the one that replaced it.
        if (pending.get(assetId) !== request) return;
        pending.delete(assetId);
        // Nothing is in flight for this asset any more, and `then`/`catch`
        // have already run — so the counter has no reader left and would
        // otherwise be one entry per deck ever opened, for the whole session.
        generation.delete(assetId);
      });

    pending.set(assetId, request);
    return request;
  },

  /**
   * Folds one `deck-progress` push into the store.
   *
   * Deliberately does NOT keep an entry for every deck it ever hears about.
   * Background pre-warming reports on every deck in a folder, and this map
   * holds a whole `DeckDTO` (one url per slide) per entry — so a 600-deck
   * batch used to leave 600 entries alive for the rest of the session, each
   * one re-copied by the spread on every subsequent push. Two rules keep it
   * to what the UI can actually use:
   *
   * - An asset with no entry yet only gets one while it is `converting` (a
   *   tile needs the badge and the progress bar). A terminal status for
   *   something nobody opened is not information the renderer has any use
   *   for: a ready deck's thumbnail comes from `deck:statuses`, and its error,
   *   if any, comes back from `ensure()` the moment someone does open it.
   * - Reaching `ready` with no DTO in hand drops the entry instead of
   *   recording a body-less "ready" — the DTO only ever arrives through
   *   `peek`/`ensure`, i.e. for decks the operator actually opened. The one
   *   exception is an `ensure` still in flight for that same asset: main
   *   pushes `ready` a moment BEFORE the call resolves, and dropping the entry
   *   in that window would flash `DeckConversionStatus`'s "Getting ready…" over a
   *   deck that is in fact finished (`!entry` reads as "queued" there).
   */
  markStatusesChanged: () => {
    set((s) => ({ readyEpoch: s.readyEpoch + 1 }));
  },

  applyProgress: (progress) => {
    set((s) => {
      const current = s.byAssetId[progress.assetId];
      const readyEpoch = progress.status === "ready" ? s.readyEpoch + 1 : s.readyEpoch;
      const awaited = pending.has(progress.assetId);

      if (progress.status === "ready" && !current?.deck && !awaited) {
        if (!current) return { readyEpoch };
        const byAssetId = { ...s.byAssetId };
        delete byAssetId[progress.assetId];
        return { byAssetId, readyEpoch };
      }
      if (!current && progress.status !== "converting") return { readyEpoch };

      return {
        readyEpoch,
        byAssetId: {
          ...s.byAssetId,
          [progress.assetId]: {
            status: progress.status,
            progress: { done: progress.done, total: progress.total },
            // A "ready" push arrives before ensure() resolves; don't clobber
            // the DTO the resolved promise is about to write.
            deck: current?.deck ?? null,
            error: progress.error,
          },
        },
      };
    });
  },

  markStale: (assetId) =>
    set((s) => {
      const current = s.byAssetId[assetId];
      if (!current) return s;
      return { byAssetId: { ...s.byAssetId, [assetId]: { ...current, status: "stale" } } };
    }),

  cancelConversion: (assetId) => {
    // Main has nothing to stop — a deck is read from its source, and the read
    // finishes on its own — so this only stops waiting for it: the in-flight
    // request is retired (a late resolution must not write over the
    // cancellation) and the deck marked cancelled. `useDeck` leaves a
    // cancelled deck alone until «Retry».
    supersede(assetId);
    pending.delete(assetId);
    set((s) => ({
      byAssetId: {
        ...s.byAssetId,
        [assetId]: { status: "stale", progress: { done: 0, total: 0 }, deck: s.byAssetId[assetId]?.deck ?? null, error: null },
      },
    }));
  },

  startBatchPrewarm: async (assetIds, label) => {
    const { jobId, total } = await api.deck.prewarmBatch(assetIds, label);
    set({
      prewarmBatch: { jobId, label, total, done: 0, skipped: assetIds.length - total, failed: 0, currentAssetId: null, status: "running" },
    });
  },

  cancelBatchPrewarm: async () => {
    const jobId = get().prewarmBatch?.jobId;
    if (!jobId) return;
    await api.deck.cancelPrewarmBatch(jobId);
  },

  applyPrewarmProgress: (progress) => set({ prewarmBatch: progress }),
  clearPrewarmBatch: () => set({ prewarmBatch: null }),
}));
