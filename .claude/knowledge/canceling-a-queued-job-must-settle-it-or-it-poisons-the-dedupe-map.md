## Dropping a queued job without settling its promise poisons `inFlight` and makes that asset unusable for the rest of the session

**Area:** slides (`src/main/slides/deck-service.ts`)
**Trigger:** Any report of "this presentation stopped converting and now nothing happens when I
click it", a `deck:ensure` that never resolves, or before touching `cancel`, `cancelAll`,
`setVisiblePrewarm`, `cancelBackgroundJobs` — anything that removes a `Job` from a queue.

Found on 2026-09-11 while auditing the whole media chain. It is the worst defect the audit found,
and it had been latent since the two-queue rework: the cancel path looks complete, and the damage
happens somewhere else entirely.

### What was believed vs. what is true

The belief is that removing a job from its queue plus `controller.abort()` cancels it. It does
not. `cancel()` used to do exactly that and nothing else:

```ts
export function cancel(assetId: number): void {
  const job = inFlight.get(assetId);
  if (!job) return;
  job.controller.abort();
  interactiveQueue.splice(...);     // or removeFromBackground(job)
}                                    // ← no inFlight.delete, no job.reject
```

`abort()` only reaches a job that is **already running** — `runConversion` is what listens to the
signal, and `pump`'s `catch` is what does `inFlight.delete` + `reject`. A job still sitting in a
queue never runs, so **nothing** ever settles it.

Two consequences, and the second is the one that hurts:

1. The promise `deck:ensure` returned never settles. The renderer's `await` hangs forever, and
   `deck.store`'s `pending` map keeps that entry too.
2. **The zombie entry in `inFlight` makes every future `prepareDeck(assetId)` return that same
   dead promise.** Worse, it also disables the up-front cache hit, because that shortcut is
   guarded by `if (!inFlight.has(assetId))` — so even a deck that is fully converted and sitting
   in the cache can no longer be answered. That asset cannot be previewed or projected again
   until the app restarts.

Reachable from the "Cancel" button in `components/shared/deck-conversion-status.tsx` and from
force-deleting an asset (at the time; since the own readers, a deck has no conversion to cancel).

### The rule

**Every path that removes a `Job` from a queue must settle it.** In this file that means
`settleCanceledJob(job, message)`: `inFlight.delete` + `releaseBatchDirFor` + `reject(new
SlideError("CANCELED", …))`. A job that is *running* needs none of it — aborting makes
`runConversion` throw and `pump` cleans up — so the two cases must be told apart by whether the
removal from the queue actually found it:

```ts
if (wasQueued || removeFromBackground(job)) settleCanceledJob(job, "Conversión cancelada.");
```

`setVisiblePrewarm` and `cancelBackgroundJobs` already did the `inFlight.delete` + `reject` pair;
`cancel` and `cancelAll` did not. That asymmetry inside one file is exactly how this survives a
review — the correct pattern is right there, three functions up.

### Corollaries worth remembering

- `releaseBatchDirFor` belongs on the same path. It was missing from all four, so a cancelled
  prewarm left its shared batch temp dir (up to 20 PDFs) on disk until the next startup's
  `sweepCache`, plus stale entries in `precomputedPdfByAsset`/`batchDirByAsset`.
- A cancellation now surfaces to the renderer as `IpcError.code === "CANCELED"`. It is not a
  failure: `deck.store`'s `ensure` maps it to `stale`, not `failed`, or the operator gets a "couldn't
  convert" for something they cancelled on purpose. That path only became reachable at all
  once the job started settling.

### Settling is not telling: the queued path also has to PUSH `stale` (2026-10-18)

- The "maps it to `stale`" corollary above stopped being true. `cancelConversion` later began
  superseding its own request (so a late resolution cannot overwrite main's word) and waiting for
  main's `deck-progress` push instead. Only the RUNNING path pushed: `runConversion`'s catch emits
  `stale`, `settleCanceledJob` emitted nothing. A deck cancelled while it waited in line — behind
  another deck, or behind «Prepare folder» — left PREVIEW on «Getting ready to convert…» forever.
  `settleCanceledJob` now emits the same `stale` push.
- Two more holes in the same flow, all found by the E2E suite (`tests/e2e/decks.spec.ts`):
  - A cancel pressed before the request reached main (the first ~100 ms, while the panel already
    shows «Getting ready…») had nothing to cancel and got no push: the click was lost and the deck
    converted anyway. `cancelConversion` marks the entry `stale` itself, and `useDeck` does not
    ensure a deck that is `stale` with no slides (the cancelled test `DeckConversionStatus` uses).
  - A cancelled deck that a background prewarm finished later: `applyProgress` drops an entry that
    turns `ready` with no DTO and nobody awaiting it (the memory rule above), and `!entry` reads as
    "queued" — «Getting ready…» over a ready deck. `useDeck` re-peeks when its entry disappears.
  - «Retry» and «Cancel» sit in the same slot of the same `LoadingState`, so React reused one
    `<button>`: a conversion starting between press and release turned a retry into a cancel. Keyed.
- Trap for tests: right after a cancel, main is still killing `soffice` (~400 ms) and the job is
  still in `inFlight`, so a new request for that deck JOINS the dying promise and dies with it. Wait
  for main's `stale` push before asking again.

See also [prewarm LRU grace and linked-audio full-file read](prewarm-lru-grace-and-linked-audio-full-file-read.md)
for the other half of the prewarm queue's history.

**Last updated:** 2026-10-18
