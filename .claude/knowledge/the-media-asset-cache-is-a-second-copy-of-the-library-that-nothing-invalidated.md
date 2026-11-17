## The `useMediaAsset` cache is a second copy of the library, and only `id` changes ever refreshed it

**Area:** renderer
**Trigger:** a row, a preview or a schedule item shows an asset's OLD state (its name, or worse
its `missingSince`) after something changed it — a background sweep, a relocate, an import. Or:
you are about to add another module-level cache keyed by id.

- The belief is that `library-changed` refreshes "the library". It refreshes
  `library.store` — the grids — and nothing else. Everything that stores only a
  `mediaAssetId` (the schedule rows, `usePreviewContent`, the media panel) reads instead from
  the module-level `Map` in `src/renderer/src/lib/hooks/use-media-asset.ts`, which is a
  **second, independent copy of the same rows**. Nothing invalidated it.
- The hook's fetching effect depends on `[id]`. A mounted consumer whose id has not changed
  therefore never refetches, whatever happens to the row underneath. Measured on 2026-09-14
  with the real app: an asset imported and then moved on disk was marked `missingSince` by
  `library-sweeper` and broadcast — and the preview panel went on rendering it as present, so
  the "Media not found" state (and the **Locate…** button that repairs it) never
  appeared. Then, after a successful relocate, the same staleness held the panel on the missing
  state for a file that was no longer missing. Both directions of the same bug, in the one
  feature whose whole job is to notice.
- `forgetMediaAsset(id)` existed and was not enough, for a reason its own comment got wrong: it
  deleted the entry and said "callers already touch a store, which is what actually reruns the
  consumers". A store the consumer does not subscribe to reruns nothing, and even a rerender
  would not refetch — the effect is still pinned to `[id]`.
- The fix is a generation counter every consumer subscribes to (`useSyncExternalStore`) and
  which is a dependency of the fetching effect, plus `forgetAllMediaAssets()` called from the
  `library-changed` handler in `effects/library-sync.ts`. Clearing everything is right here:
  the event does not say which rows moved, refetching is lazy and per id, and the event only
  fires on an import, a sweep that found a change, or a relocate — never in a loop (see
  [a list channel must never broadcast its own refetch signal](list-channel-must-never-broadcast-its-own-refetch-signal.md)).
- General rule: **a module-level cache of rows another process can change is not a cache, it is
  a replica — and a replica needs an invalidation channel.** The same map has a second, still
  open defect from the same blind spot (`M26` of
  the internal general audit of 2026-09-13): eviction is FIFO over 500 entries and
  a read during render does not mark an entry as used, so a mounted row can lose the asset it is
  displaying and never ask for it again.

**Last updated:** 2026-09-14
