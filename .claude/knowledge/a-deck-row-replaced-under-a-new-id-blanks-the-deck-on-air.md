## A deck row replaced under a new id blanks the deck already on air
**Area:** slides
**Trigger:** anything that deletes and re-inserts `slide_decks` rows (`insertDeck`, a forced re-read, a reader version bump, GC), a library with the same file twice, or a live deck whose slides all go blank / «No se pudo reproducir el archivo» right after another file was opened.

- Believed: a deck is content-addressed (`contentHash + renderWidth + imageFormat`), so two copies of
  the same bytes share one row through `findDeckByAssetContent` + `relinkDeck`, and nothing on air
  can be affected by opening the other copy.
- True (found 2026-11-04 by an E2E written for something else): the shared lookup only hits once the
  copy's own `content_hash` is stamped, and that happens AFTER its read (`recordPdfDeck` /
  `recordModelDeck` / `recordNativeDeck` hash, then insert). A copy opened before the startup
  backfill reached it is read again, and `insertDeck` "replaced" the identical row: delete + insert,
  so a NEW id. Every window asks by id (`worship://deck/<id>/<n>`, `/model`), so the deck on the
  projector was asking for slides of a row that no longer existed — every slide not yet loaded went
  blank. Any deck kind, and the owner's real library has hundreds of duplicates.
- SQLite hid it in a one-deck unit test: without `AUTOINCREMENT` it hands a deleted LAST rowid out
  again. The regression test inserts another deck first (`data-layer.test.ts`).
- Fix: `insertDeck` keeps the replaced row's id. Ceiling: the deck's `deck_audio`/`deck_video` rows
  still get new ids, so a clip on air through that deck would lose its url — keep those too if it
  ever shows up (`ponytail:` comment in `slides.repo.ts`).
- Related trap in the same E2E: `win.destroy()` on the hidden PDF window while it draws leaves that
  task unanswered until the 30 s hang timeout, and the whole lane waits behind it. Simulate a crash
  (`forcefullyCrashRenderer()`, retried once by `retryOnce`), never a destroy.
