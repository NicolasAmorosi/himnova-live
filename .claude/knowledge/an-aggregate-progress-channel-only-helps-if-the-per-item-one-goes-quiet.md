## An aggregate progress channel only helps if the per-item one goes quiet — otherwise a background batch is a quadratic IPC storm

**Area:** slides (`src/main/slides/deck-service.ts`) | renderer (`src/renderer/src/stores/deck.store.ts`)
**Trigger:** UI jank or growing renderer memory while "Prepare folder" runs; before adding any
per-item progress emission, or before deriving a value with `Object.values(store)` in a selector.

Found on 2026-09-11 during the media-chain audit.

### What the design said, and what the code did

`prewarm-progress` was introduced *specifically* so a folder batch would not push per-deck events:
the plan says reusing `deck-progress` (which is per `assetId`) would "put 600 entries into
`deck.store.byAssetId` and a storm of re-renders during background work". The aggregate
channel was built. **And `deck-progress` kept firing anyway**, once per rasterized page, for
background jobs too — `emitProgress` never looked at `job.priority`. Adding the quiet channel did
nothing because the loud one was never silenced.

The cost compounds three times over, which is why it is worth writing down:

1. **One IPC message per page, per deck.** 600 decks × ~30 slides ≈ 18.000 messages — broadcast to
   *every* window, including the projection window and the offscreen rasterizer, neither of which
   listens to that channel.
2. **Each message is a `set()` that clones a record that keeps growing.** `applyProgress` did
   `{...s.byAssetId, [assetId]: …}`, and `byAssetId` gained an entry per deck the batch touched —
   so the copy cost rises with the number of messages. Quadratic, in the renderer, during a
   service.
3. **Each `set()` re-runs every subscriber's selector.** `media-browser.tsx` had
   `Object.values(s.byAssetId).filter(e => e.status === "ready").length` as a selector, i.e. an
   O(n) scan over that same growing map, on every one of those 18.000 notifications.

### The rules that came out of it

- **Per-item progress is for the one item the operator is waiting on.** `emitPageProgress(job, …)`
  drops page-level events when `job.priority === "background"`. State transitions
  (converting/ready/failed) still go out for every job — that is what a tile's badge and skeleton
  need, and it is one event per deck, not one per page.
- **A store map fed by background work needs an eviction rule.** `byAssetId` holds a whole
  `DeckDTO` (a url per slide) per entry, and the DTO only ever arrives through `peek`/`ensure`,
  i.e. for decks someone actually opened. `applyProgress` now only creates an entry for
  `converting`, and drops it on `ready` when it holds no DTO. The exception that has to stay: if
  an `ensure` is in flight for that asset, keep the entry — main pushes `ready` a moment *before*
  the call resolves, and deleting it in that window makes `DeckConversionStatus` flash
  "Getting ready…" over a deck that is already finished (`!entry` reads as "queued" there).
- **Never derive a "did something finish" trigger by counting a map.** A monotonic counter
  (`deck.store`'s `readyEpoch`, bumped on every `ready`) is O(1), is a primitive so it compares by
  value, and says exactly the same thing.
- `broadcast()` reaching every window is the fourth multiplier and is still unfixed — see the
  internal media-chain audit of 2026-09-11 (M17).

See also [`media-status` must be keyed per target](media-status-is-per-target-not-a-single-slot.md)
and [prewarm LRU grace](prewarm-lru-grace-and-linked-audio-full-file-read.md).

**Last updated:** 2026-09-11
