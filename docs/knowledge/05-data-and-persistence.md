# 05 — Data and persistence

**No more flat JSON.** Everything lives in SQLite (`app.getPath('userData')/worship.db`), via
`better-sqlite3` + Drizzle ORM. See `src/main/db/schema.ts` for the full DDL.

`userData` is `<appData>/worship-app` (`~/Library/Application Support/worship-app`,
`%APPDATA%\worship-app`), in dev and in the installer: Electron names it after the `name` in
`package.json`, not after `build.productName` (which electron-builder doesn't copy into the
package). That's why the rebrand to Lumina Live didn't move the data, and why `name` never changes.
`--user-data-dir` overrides it (that's how every E2E test runs).

## Why `better-sqlite3` and not `node:sqlite`

Verified against the real Electron 36 runtime (Node 22.15.1) when the choice was made:
`node:sqlite` existed but was experimental and **had no FTS5** (`no such module: fts5`), a
non-starter for Bible search. (Re-checked on Electron 44 / Node 24.20.0 on 2026-10-23: its
`node:sqlite` does create an FTS5 table now; the choice has not been revisited.)
`better-sqlite3@^13` is pure Node-API and its tarball ships **8 prebuilt binaries**
(`darwin/win32/linux` × `x64/arm64`) — `npm install` compiles nothing, no `electron-rebuild`, and
the Windows installer can be built by cross-compiling from macOS. The only packaging requirement:
`asarUnpack: ["**/node_modules/better-sqlite3/**"]` in `package.json > build`
(already configured). **Don't go back to `^12`** — that version doesn't ship N-API prebuilds.

## Tables

`settings` (key/value), `media_assets` (video/image/audio/PPT in a single table — they all
share the same "the user moved the file" problem), `programs`+`program_items`
(saved playlists, polymorphic with a `CHECK` over five item kinds; renamed from `services`/`service_items` in
migration `0004_rename_programs.sql` with `ALTER TABLE ... RENAME` — a table recreate would have
lost the `CHECK`, which Drizzle doesn't materialize in the snapshot), `bible_versions`+`bible_books`+`bible_verses`+
`bible_verses_fts` (FTS5 external-content), `bible_favorites`, `projection_history`,
`slide_decks`+`deck_slides`+`deck_audio`+`deck_videos` (persistent record of every deck read,
addressed by content hash — see `03-slides.md`: a PDF's page sizes, its pages drawn on request
(until 2026-11-03 its rasterized pages, in a folder); since `0018` also the
decks read natively, `image_format = 'native'`, which own no folder and whose `deck_slides.layers`
say which pictures of the source make up each slide; and the decks drawn from their model,
`image_format = 'model'`, whose `layers` is each slide's `SlideModel`), `program_draft`,
`utility_scenes` (the saved timer scenes from Functions ▸ Timers), `overlay_plates` (the saved
plates from Functions ▸ Overlays, `0014`) and `media_conversions` (ffprobe's verdict per video/audio
asset, `0016`).

`program_draft` is **a single row** (`id = 1`), rewritten whole, holding the schedule the operator
is building and hasn't saved yet. It was the only user data without a backup: it lived only in the
renderer's `program.store`, so a reload, a close, a crash or a power cut took 15–40 minutes of work
with it. `effects/draft-autosave.ts` writes it with a 600 ms debounce and `App` recovers it at
startup.

Its items are a **JSON blob**, not `program_items` rows, and that's deliberate: a draft has to be
able to reference an asset the operator is about to delete, which is exactly what that table's FK
`onDelete: "restrict"` exists to forbid — a draft can never be what blocks a delete.
`DraftRepo.load()` filters out on read the items whose target no longer exists —an asset deleted
from the library, a timer scene deleted from the editor—, on main's side, which is the only one
that can answer that without one IPC round-trip per item.

### The five item kinds, and why every `program_items` migration is written by hand

`kind` is `media | ppt | bible | utility | plate`, and the table's `CHECK` requires each one to
carry exactly its own reference and no other (`media_asset_id`, `bible_text`,
`utility_scene_id`, `overlay_plate_id`). That `CHECK` **doesn't exist for Drizzle**: it lives only in the SQL and the snapshot
reports it empty. Practical consequence, already paid for four times: renaming requires
`ALTER TABLE` (`0004`), dropping a column the `CHECK` names requires a hand-written rebuild
(`0009`), and **so does adding a column** (`0011`, and again `0015` for `overlay_plate_id`) — there `drizzle-kit` emits an `ADD COLUMN` that SQLite
accepts, silently losing the FK's `ON DELETE restrict` and leaving the `CHECK` unaware of the new
kind. The full diagnosis is in
[`sqlite-table-rename-must-alter-not-recreate.md`](../../.claude/knowledge/sqlite-table-rename-must-alter-not-recreate.md).

`utility_scene_id` is `ON DELETE restrict` for the same reason as `media_asset_id`: deleting a scene
that a saved program uses is the operator's decision (`utility:usages` names the programs and
«Delete anyway» deletes the items and the scene in one transaction), never a row that disappears on
its own. `overlay_plate_id` repeats the same deal with `overlay:usages`.

## `utility_scenes` — `tool` in a column, the rest in JSON, and a seed that happens ONCE

`tool` is a **column** and not a `config_json` field because it's the discriminant: the list shows
an icon and a label per scene, and it can't have to parse a blob per row to do that. The rest is
split into two JSON columns with different roles: `config_json` is what the operator configured
(`TimerConfig`) and `style_json` is how it looks (`SceneStyle`, designed so that Overlays and the
Bible projection settings can reuse it). They're JSON and not thirty columns so that a change of
shape is a branch in `shared/scene-validators.ts` and not a migration.

That gives the two rules that hold the table up:

- **Main validates on WRITE** (`isUtilitySceneUpsert`), strictly: `registerHandlers` casts the
  request from `unknown`, the renderer is another process and a badly written row outlives the
  session that wrote it. It's the same argument as `SETTINGS_VALIDATORS`, over a bigger shape.
- **The repo normalizes on READ** (`normalizeSceneStyle`/`normalizeTimerConfig`), tolerantly and
  **field by field**: a row written by a future version, edited by hand or truncated must still be
  displayable, and a broken color costs the color, not the scene. Same discipline as
  `DraftRepo.load` and the Bible seed. Whatever comes out of a normalizer always passes the
  validator — there's a test that asserts it.

Seeding the four factory scenes is guarded by the `utility.seeded` flag in `settings`, **not by a
row count**. Seeding "when the table is empty" would mean the operator who deletes a scene finds it
back on Monday, and that deleting them all is impossible. With the flag, deleting is deleting: the
panel shows its empty state and offers to create one.

## "Is it converted?" is asked by CONTENT, not by row ownership

`media_assets.content_hash` (migration `0007_media_content_hash.sql`) stores the file's SHA-256 —
the same identity `slide_decks` is indexed by — together with `content_hash_size` and
`content_hash_mtime_ms`, which are the **stamp** that validates it: the hash is only used while
those two still match the row's `size_bytes`/`mtime_ms`. It's the same invalidation rule
every deck reader applies to its own row, and it's what avoids having to re-read the file to
know whether the digest still describes it.

It exists because `slide_decks.media_asset_id` is **exclusive** and `relinkDeck` moves it: asking
"does this asset own a row?" can never answer "yes" for both files of an identical pair. With the
real library that meant 555 of 1235 presentations marked as pending with no real work to do. Now
`statusesByAsset` JOINs by hash and only falls back to row ownership as a backup, for an asset the
backfill hasn't stamped yet.

The hash is written in two places, never anywhere else:

- every deck reader (`recordNativeDeck`, `recordModelDeck`, `recordPdfDeck` in `deck-service.ts`)
  stores it as soon as it computes it — it already needed it, so it's free, and it leaves a freshly
  imported deck correct right away;
- `backfillContentHashes()` (`src/main/media/content-hash.ts`) sweeps in the background, 2 s after
  startup, every `ppt` without a valid stamp, in chunks of 25 with a yield between chunks, and
  emits `deck-statuses-changed` so the grid repaints. It's idempotent: the second startup costs one
  indexed query. Measured on the real library: 1235 files, 1.78 GB, 1.98 s.

**Don't replace it with `(size, mtime)`.** It's tempting because the row already has them, but in
the user's library there are 34 `(size, mtime)` pairs that belong to different contents —
`Himnario Nuevo Cantado/035.pps` and `Himnario Nuevo Instrumental/035.pps` were copied together.
The count would still come out right; the tile's thumbnail and `adoptProgram`'s eviction pin would
point at the wrong deck. Full diagnosis in
[`.claude/knowledge/deck-cache-is-content-addressed-but-status-is-asset-owned.md`](../../.claude/knowledge/deck-cache-is-content-addressed-but-status-is-asset-owned.md).

## The order of `programs` is manual, not by recency

`programs.sort_order` (migration `0006_program_sort_order.sql`, index `ix_programs_order`) is the
order the operator builds by dragging rows in the programs modal, and it's the **only** criterion
of `ProgramsRepo.list()`. Opening a program no longer moves it: `last_opened_at` is still written
in `load()` but no longer sorts anything. Rules for the field:

- A new or duplicated program comes in with `MIN(sort_order) - 1` (can be negative) to land on top
  without rewriting the other rows; `reorder(ids)` renormalizes the whole column to `0..n-1`.
- `reorder()` receives the full list of ids in their new order and **doesn't touch `updatedAt`** —
  dragging isn't editing content, same as `setFavorite()`.
- The migration seeds `sort_order` with the ranking the list used to show
  (`last_opened_at DESC NULLS LAST, updated_at DESC, id ASC`), so nobody sees their list reordered
  when they update.
- Dragging is disabled in the renderer when a search or a filter is active: reordering a partial
  view can't be mapped onto the full list.

## FTS5 without accents

`bible_verses_fts` uses `tokenize="unicode61 remove_diacritics 2"` — searching "espiritu" finds
"Espíritu". The table is *external content* over `bible_verses` (it doesn't duplicate the ~4MB of
text) and is kept in sync with `AFTER INSERT/UPDATE/DELETE` triggers. The seed uses
`INSERT INTO bible_verses_fts(bible_verses_fts) VALUES('rebuild')` once at the end instead of
letting the triggers run 31,102 times — the full load measures ~550ms on this machine
(`npm run test`, `main` project).

## `media_conversions` — facts, never the decision

One row per video or audio already checked with ffprobe (migration `0016_media_conversions`,
`cascade` with its asset): what ffprobe said (`probe_json`, a `MediaProbe` versioned by
`MEDIA_PROBE_VERSION`), valid while `source_size` and `source_mtime_ms` are still the asset's.

**Whether the media engine plays a file is not stored.** It's recomputed on every startup
(`media/engine-assets.ts`, `playsNatively`), because one of its inputs belongs to the MACHINE:
whether the GPU decodes HEVC. A library taken to another PC doesn't keep the previous one's answer.
Clips embedded in a `.pptx` don't use this table: `media/deck-clips.ts` probes them when the deck
is opened, and keeps its answer in memory too.

Until step 1.4 of the engine plan (2026-11-02) a file Chromium couldn't decode was converted, and
`output_file` named its copy in `userData/converted-media/`. Nothing reads or writes the column
since; the table keeps its name and the column so a profile still opens in an older build. At
startup `converted-media/` is deleted, and every `deck_videos`/`deck_audio` row still on a
`<n>.playable.mp4/.m4a` copy is pointed back at its original before the copy is deleted
(`revertPlayableCopies`, from `sweepCache`).

The same sweep does `stat` (not `access`) and **refreshes `size_bytes`/`mtime_ms`** of a file
edited in place. That's not a detail: every stamp in the app — a deck's content hash, a video's
probe, the thumbnail's cache-buster — is validated against those two fields of
the ROW, and until 2026-10-18 nothing updated them for a library file: a deck or a video replaced
in place kept being previewed and projected with the old content. Any new cache that depends on a
source file is validated against a `stat` of the file, or against a row that something keeps up to
date. Diagnosis in
[`a-library-rows-size-and-mtime-are-every-stamps-identity-and-the-sweep-only-checked-existence.md`](../../.claude/knowledge/a-library-rows-size-and-mtime-are-every-stamps-identity-and-the-sweep-only-checked-existence.md).

A linked folder that isn't there (`library:listFolder`) answers `FOLDER_MISSING`, not an empty
list: the two were indistinguishable. And no import accepts a `._x.pps` (the AppleDouble that
macOS leaves on a FAT/exFAT USB stick), a `~$x.pptx` (PowerPoint's lock file) or a file whose
extension doesn't belong to its `kind` (`importable` in `library-import.ts`).

`pathKey` normalizes (`NFC` + lowercase on Windows) so that `C:\a.mp4` and `c:\A.MP4` don't get in
twice — Windows is case-insensitive and the legacy version didn't account for it.

## Legacy data migration

`src/main/services/migrate-legacy-data.ts` runs only once, on first startup: if
`settings.json`/`media_library.json` exist in `userData` (from an install of the vanilla version),
it imports `logoPath` and every library entry into SQLite (the legacy file's `lastFolder`
no longer has anywhere to go: the picker opens one folder per kind, not the last one used), and renames the original
files to `*.migrated` so they aren't processed again. Best-effort: a corrupt JSON doesn't block
startup.

## Bible seed — never written inside the bundle

`resources/bibles/rv1909.json` is packaged with `extraResources` (`build/electron-builder`) and
imported into the tables on **first startup**, not at build time — that way an app update never
overwrites the user's DB. `bible:import` does exactly the same: it parses the file in memory and
inserts rows. **It never writes a file inside the app directory** — the legacy bug of
`import-bible` writing to `data/bible/` (broken in a packaged install because of permissions) does
not exist in this design.

Idempotency by `sourceHash` (sha256 of the file) in `bible_versions` — reimporting the same file
doesn't seed anything again. A reseed **keeps the name the row already has**: the version can be
renamed from Settings (it's what the projector writes below the verse), and a corrected
`rv1909.json` in a later build can't undo that rename.

The bundled text is the **Reina-Valera 1909** (public domain), although up to 2.2.0-beta.3 it was
called «Reina-Valera 1960» and the file was `rv1960.json`. Its `code` is still `rv1960` because
that's the identity `bible_favorites` and the reseed point to; what says 1909 is the file and the
name. Migration `0017` renames the row only if it still has the old name: a name the operator set
is theirs. A real RV1960 can't be bundled (it's under copyright): it gets imported.

### The `bible.builtinSeeded` flag — and why it's only checked if the row is NOT there

`seedBuiltinBibles()` runs on every startup, so without a flag the RV1909 came back on the next
launch and «delete» didn't mean delete. But the flag **can't** just switch the seeding off, because
the seeding is also the update path. The three rules, in order:

| State | What it does |
|---|---|
| the row exists | seeds anyway — the hash short-circuit turns it into one digest per startup, and that's how a corrected `rv1909.json` reaches an existing install |
| it doesn't exist and the flag is set | the operator deleted it: that's respected |
| it doesn't exist and the flag isn't set | fresh database: seeds and sets the flag |

That's why `seedBuiltinBibles` runs **after** `initRepos()` (it needs `SettingsRepo`), just like the
timer-scene seeding and for the same reason.

## Bible formats — the BYTES decide the format

`src/main/db/seed/bible-formats/` accepts five families and `seed-bible.ts` doesn't know which one
it got:

| Format | How it's read | Book identity |
|---|---|---|
| JSON (the bundled one and any variant) | `json.ts`, tolerant of every known shape | the file's own `abbrev` |
| Zefania XML (`.xml`, `.zip`) | `fast-xml-parser`'s object model | `bnumber` (1..66) |
| USFX XML | **ordered** traversal (`xml-ordered.ts`) | `<book id="GEN">` |
| OSIS XML | the same traversal; two legal verse forms | `osisID="Gen.1.1"` |
| MyBible.zone / MySword | `better-sqlite3` in `readonly` | `book_number` (10..730) / `Book` (1..66) |

`detectBibleFormat` sniffs magic numbers (`SQLite format 3\0`, `PK\x03\x04`) and then the root
element — **never the extension**, same as `container-kind.ts` does with a presentation. A `.zip`
is opened with `readZipEntries` (not `unzipSync`) and the largest entry wins; a compressed SQLite
module is **not** supported, because it would have to be written to a temp file.

Everything that isn't the JSON goes through `BookCollector`, which deduplicates (the UNIQUE on
`bible_verses` would abort the whole transaction over a single repeated verse), drops empty verses
and reorders the books into canonical order. The testament comes from the canonical **position**,
never from a list of names — see
[`.claude/knowledge/a-book-code-namespace-is-per-format-and-testament-was-never-derived-right.md`](../../.claude/knowledge/a-book-code-namespace-is-per-format-and-testament-was-never-derived-right.md),
which also documents the 23 rows that were wrong since the first commit. Each format's traps
(milestones, Latin-1, the modules' apparatus) are in
[`.claude/knowledge/a-bible-module-is-milestoned-xml-or-latin-1-or-sqlite-and-never-what-its-name-says.md`](../../.claude/knowledge/a-bible-module-is-milestoned-xml-or-latin-1-or-sqlite-and-never-what-its-name-says.md).

## Version management

`bible:rename` / `bible:delete` / `bible:usages`. The name is the **only** editable field: the
`code` is the identity the seed compares the hash against and the key that `bible_favorites` rows
point to, so editing it would orphan favorites and duplicate the version on the next startup.

Deleting cascades to `bible_books`/`bible_verses` (and to the FTS5 indexes via trigger) and
deliberately does **not** touch two things: the `program_items` rows, whose FK is `set null` —the
saved program keeps the text and the reference and loses only the link—, and the `bible_favorites`
rows, which are keyed by CODE precisely to survive a delete-and-reimport. `force` here is informed
consent and nothing more: unlike a timer scene's, this delete can't fail on an FK.

## `SETTINGS_NORMALIZERS` — the first `settings` key that is a STRUCTURE

Until `bible.style` every key was a scalar or a `Record` of scalars: a badly written one falls back
to its default and nothing else is lost. A `BibleStyle` is different: a gradient missing a color
has to come back with the default background and the typography the operator chose, not as a
stranger. So `SettingsRepo.load()` applies a per-key normalizer when there is one
(`shared/types/settings.ts`), which is the same discipline as `utility_scenes.style_json` —
**validate on write, normalize field by field on read**— applied for the first time to a
`settings` row.

## Migrations and backup

`src/main/db/migrate.ts` makes a copy of `worship.db` in `userData/backups/` before running
`drizzle-orm`'s `migrate()`, keeping the last 3. If a migration fails, the user sees a dialog with
the backup's location instead of a blank screen.

**`VACUUM INTO`, not `copyFileSync`**, and verified with `PRAGMA integrity_check` on the copy. The
database runs in `journal_mode = WAL`: recent transactions live in `worship.db-wal`, not in the
main file, so copying only that one silently discards everything after the last checkpoint. It
usually came out complete —this function runs before the app opens the database, with the WAL
already checkpointed— and failed exactly when it was needed: after an unclean shutdown, a power
cut or a SIGKILL. Measured in `npm run test` (`tests/main/data-layer.test.ts`) with a hot 4.1 MB `-wal`:
`VACUUM INTO` captures all 5000 rows, `copyFileSync` 4977. `backupBeforeMigrate` returns a
`BackupResult` and the error dialog tells the truth: it promises a copy only if there really is one
and it passed the `integrity_check`.

The other half is the exit: `closeDatabase()` runs on `will-quit` with
`wal_checkpoint(TRUNCATE)` + `close()`. Without it the `-wal` grew between sessions, which is what
made the scenario above more likely. A clean shutdown **deletes** `-wal` and `-shm`; if they
survive an exit, that's the fastest way to tell this broke.

**Only when something is pending**, and that's correctness, not performance.
`hasPendingMigrations()` compares the newest `when` in `drizzle/meta/_journal.json` against
`MAX(created_at)` of `__drizzle_migrations`, opening the database read-only. It used to copy on
**every** startup: since migrations run only once, three normal startups after migrating filled
the three slots with post-migration copies and **rotated out the only copy this function exists to
keep**. It showed in the user's real folder: the 3 copies were from the same day and the same size,
all after the last migration.

## Defensive Bible parsing (the JSON path)

`src/main/db/seed/bible-formats/json.ts` tolerates the same variants as the legacy version:
array-of-books / `{books:[...]}` / object-by-name container; a book with `name` or `nombre`;
chapters as an array or an `{"1":...}` object; verses as string[]/`{text}`[]/`{verse}`[]/object.
Verified against the real `rv1909.json`: it **does have `name`** in all 66 books — the "shows
'Libro' 66 times" bug that the legacy version of this file documented (`.claude/knowledge/`) didn't
reproduce with the current data; no fix was ported for it.
