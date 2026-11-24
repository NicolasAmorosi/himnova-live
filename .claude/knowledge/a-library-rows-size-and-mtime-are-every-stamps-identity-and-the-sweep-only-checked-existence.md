## A library row's `(size, mtime)` is the identity every stamp is checked against — and nothing kept it current
**Area:** data / slides / media (`media.repo.ts` `sweep()`, `deck-service.ts`, `conversion-service.ts`)
**Trigger:** a file edited or replaced IN PLACE (same path) still shows or projects its old content; before writing any cache keyed by a source file; touching `sweep()`, `getDeck()`, `tryCacheHit()`, `probeIsCurrent()` or `assetThumbVersion`.

- Believed: "the stamp is invalidated by size+mtime in SQL, so a file edited behind our back never
  matches" (`tryCacheHit`) and "this does not re-probe … until the sweep catches up with an edit"
  (`conversion-service.ts`). Both compare a stamp against `media_assets.size_bytes/mtime_ms` — the
  ROW — and the sweep only ran `fs.promises.access`: existence. For a library file (not a linked
  folder, whose listing re-upserts with a fresh stat) the row's `(size, mtime)` were written once,
  at import, and never again. The unit test that "proved" the invalidation updated the row by hand.
- Measured 2026-10-18 with the E2E suite: a PDF deck of 3 pages overwritten with 2 pages, then
  re-selected, previewed AND went live with the old 3 slides — `deck:ensure` returned the same
  `deckId` — and after a relaunch too. Two more holes in the renderer path: `getDeck()` (the `peek`
  every selection does first) returned the cached row without any stat, so `ensure` never ran at
  all, and `goLiveWithDeck` uses the store's cached deck and only revalidates in the background.
  The same row staleness kept a video replaced in place on its OLD converted copy.
- Fixed at the root: `sweep()` uses `fs.promises.stat` (same one syscall) and refreshes changed
  `(size, mtime)` through `refreshStat()`, reporting the kind as changed (→ `library-changed` and
  `notifyMediaChanged()`, so conversions re-probe). Between sweeps, `tryCacheHit` refreshes the row
  from its own stat before trusting the content-hash stamp, `getDeck()` refuses a row whose source
  size/mtime moved, and `setContentHash()` writes the row's `(size, mtime)` with the stamp.
- Rule: any cache keyed on a source file must be validated against a stat of the FILE, or against a
  row something demonstrably keeps current. Tests: `tests/main/data-layer.test.ts` («the sweep
  refreshes the row of a file edited in place»), `tests/e2e/decks.spec.ts` (two «edited» tests) and
  `tests/e2e/conversion.spec.ts` («a video replaced in place…»). The sweep runs ~2 s after launch,
  on focus (30 s throttle) and every 5 min, so an edit made with the app open is caught there.
- 2026-11-22 (audit RV-2, RV-3): between sweeps GO LIVE still trusted the row, so a video, an image
  or an already-read deck whose file went away cut what was on air to black, and a deck edited since
  went out with its old slides. GO LIVE now asks `library:get` with `check: true` (`MediaRepo.check`:
  one async stat per path, a second at most; an answer is written as the sweep would, a file that
  does not answer goes on as before), and `goLiveWithDeck` sends the cached deck only while its
  `sourceSizeBytes`/`sourceMtimeMs` match that check. Tests: `tests/renderer/live-file-gone.test.ts`
  and «GO LIVE's check…» in `tests/main/data-layer.test.ts`.

**Last updated:** 2026-11-22
