## The deck cache is addressed by content, but "is it converted?" is answered by row ownership — and ownership is exclusive
**Area:** slides, data, renderer
**Trigger:** any count, badge or batch built on `deck:statuses` / `statusesByAsset` — "Prepare folder", the prewarm totals, a tile's icon-vs-thumbnail, `adoptProgram`'s eviction pins. Also whenever a "pending" number refuses to reach zero.

- **Two different identities, and nobody reconciles them.** A deck is cached by
  `contentHash + renderWidth + imageFormat` (`findDeckByIdentity`, `tryCacheHit` step 2 in
  `src/main/slides/deck-service.ts`). But `statusesByAsset`
  (`src/main/db/repositories/slides.repo.ts`) answers "is this asset converted?" with
  `where media_asset_id = <asset>` — a question about *ownership of a row*, not about the cache.
  And `relinkDeck` **moves** `media_asset_id`, so a deck row has exactly one owner at a time.
- **Consequence: two byte-identical files can never both look converted.** The one opened most
  recently owns the row; the other reports "pending" forever. Preparing a folder relinks its rows
  back, which makes the *other* folder's count rise by the same amount — the number oscillates
  instead of converging. Measured on the real library on 2026-09-13: **1235 `ppt` assets, 680
  distinct content hashes, 555 assets falsely counted as pending, 0 actually needing conversion.**
  (The duplication was ordinary: `…/PPT test/Cantado/001.pps` and
  `…/PPT test/Himnario Nuevo Cantado/001.pps` are the same bytes.)
- **The most visible symptom is the grid.** A tile's thumbnail is the deck's first slide, taken
  from that same status lookup, so an asset that does not own its row paints the generic PPT icon —
  in the library above, half the grid looks unconverted while every file in it is cached.
- **It is not only a wrong number.** `adoptProgram` (`src/main/ipc/handlers/programs.ts`) pins the
  loaded service's decks against LRU eviction using the deck ids that *same* query returns — so a
  service item whose asset does not own its row is never pinned, and its slides can be evicted
  mid-service. Same class of hole as the overlay one in
  [main-cannot-know-what-is-live-under-an-overlay.md](main-cannot-know-what-is-live-under-an-overlay.md).
- **Do not "verify" conversion state by counting `slide_decks` rows per asset** — not in SQL when
  investigating, and not in code. It says 414 pending for a folder where every single file is
  already cached.

### Fixed on 2026-09-13 — and the cheap fix was measurably wrong

`media_assets` now carries `content_hash`, stamped with the `(size, mtime)` that validates it, and
`statusesByAsset` joins on it; ownership survives only as the fallback for an asset the backfill
has not stamped yet. The digest is written for free by `runConversion` (it computes one anyway) and
by a chunked background backfill 2 s after launch — 1235 files, 1.78 GB, **1.98 s**, once. Measured
on the real library: **680 → 1235 ready, 0 pending, 0 assets pointing at a deck with other
content.**

**The part worth remembering is which fix was rejected.** `(source_size_bytes, source_mtime_ms)` was
the obvious cheap answer — the row already carries both, and `tryCacheHit`'s fast path already
trusts them. On this library it resolves all 1235 with zero pending, so it *looks* correct. It is
not: **34 `(size, mtime)` pairs map to more than one content hash**, because
`Himnario Nuevo Cantado/035.pps` and `Himnario Nuevo Instrumental/035.pps` were copied together —
identical size, identical mtime, different slides. A status badge would survive that; the two things
reading the same query would not. The tile paints `worship://deck/<deckId>/1/thumb`, so it would show
the *other* hymn's first slide, and `adoptProgram` would pin the wrong deck against eviction.

The lesson generalizes past this bug: **`(size, mtime)` is a safe key for invalidating something you
already know, and an unsafe key for identifying something you don't.** `tryCacheHit` uses it
correctly — "is THIS asset's row still about THIS file?" — and the same pair used to answer "which
deck do these bytes belong to?" is a collision waiting for a hymnal. Before trusting a cheap
identity heuristic, measure its collision rate **on the user's real data**, not on fixtures: this one
looked perfect until the pairs were grouped by hash.

- Tracked as finding **`N3`** in
  the internal media-chain audit of 2026-09-11
  §5.2. Raised and deferred on 2026-09-13, fixed the same day in session 4.

**Last updated:** 2026-09-13
