# 05 — Data and persistence

**No more flat JSON.** Everything lives in SQLite (`app.getPath('userData')/worship.db`), via
`better-sqlite3` + Drizzle ORM. See `src/main/db/schema.ts` for the full DDL.

`userData` is `<appData>/worship-app` (`~/Library/Application Support/worship-app`,
`%APPDATA%\worship-app`), in dev and in the installer: Electron names it after the `name` in
`package.json`, not after `build.productName` (which electron-builder doesn't copy into the
package). That's why neither rebrand (to Lumina Live, then to Himnova Live) moved the data, and why `name` never changes.
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
`bible_verses_fts` (FTS5 external-content), `bible_favorites` + `bible_recents` (`0020`, see «Favorites and
recent passages» below), `projection_history`, `song_uses` (`0021`, the CCLI report: see «`songs`…» below),
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
startup. A SAVED program left open unedited has no draft — there is nothing unsaved to mirror —, so
the control window keeps which one is open in `settings["programs.openId"]` (`startOpenProgramMemory`; not
main's current program, which a «+» in the programs list moves too) and `App`, finding no draft, opens it again (`reopenProgram`; owner, 2026-11-06: a
restart mid-service left the schedule empty).

Its items are a **JSON blob**, not `program_items` rows, and that's deliberate: a draft has to be
able to reference an asset the operator is about to delete, which is exactly what that table's FK
`onDelete: "restrict"` exists to forbid — a draft can never be what blocks a delete.
`DraftRepo.load()` filters out on read the items whose target no longer exists —an asset deleted
from the library, a timer scene deleted from the editor—, on main's side, which is the only one
that can answer that without one IPC round-trip per item.

### The six item kinds, and why every `program_items` migration is written by hand

`kind` is `media | ppt | bible | utility | plate | song`, and the table's `CHECK` requires each one to
carry exactly its own reference and no other (`media_asset_id`, `bible_text`,
`utility_scene_id`, `overlay_plate_id`, `song_id`). That `CHECK` **doesn't exist for Drizzle**: it lives only in the SQL and the snapshot
reports it empty. Practical consequence, already paid for four times: renaming requires
`ALTER TABLE` (`0004`), dropping a column the `CHECK` names requires a hand-written rebuild
(`0009`), and **so does adding a column** (`0011`, again `0015` for `overlay_plate_id`, and `0019` for `song_id`) — there `drizzle-kit` emits an `ADD COLUMN` that SQLite
accepts, silently losing the FK's `ON DELETE restrict` and leaving the `CHECK` unaware of the new
kind. The full diagnosis is in
[`sqlite-table-rename-must-alter-not-recreate.md`](../../.claude/knowledge/sqlite-table-rename-must-alter-not-recreate.md).

`utility_scene_id` is `ON DELETE restrict` for the same reason as `media_asset_id`: deleting a scene
that a saved program uses is the operator's decision (`utility:usages` names the programs and
«Delete anyway» deletes the items and the scene in one transaction), never a row that disappears on
its own. `overlay_plate_id` repeats the same deal with `overlay:usages`.

A library file can also be drawn by a look no FK protects — the LOGO's and the verse's backgrounds
(settings), a song theme's, a time scene's (`style_json`), a bug plate's picture (`image_asset_id`,
`set null`) —, so `library:usages` (`ProgramsRepo.findUsages`) answers those too, as `looks` beside
`programs`, and removing the file asks first, naming them (owner, 2026-11-06). A confirmed removal leaves
the look pointing at the gone file, reported by the projector like any missing picture. Deleting a time
scene or a plate that is in the OPEN schedule (a draft: no FK) says so in its confirmation too.

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

## `songs`, `song_themes` and `songs_fts` (`0019`)

A song's structure is JSON — `sections_json` (`SongSection[]`: key `v1`/`c1`/`pc1`…, type, number,
slides of lines) and `order_json` (keys with repetitions, `[]` = as written) — validated whole on write
(`isSongUpsert`; `songProblem` names the limit broken, for the editor) and normalized section by section on read.
A slide holds up to 200 lines (2026-11-06: a whole song pasted as one block is stored as it came and drawn in
pieces, see «Songs» in `04-renderer-state.md`). `lyrics_text` is every line flattened,
only for `songs_fts` (FTS5 external content over title, number, authors and lyrics, `remove_diacritics
2`, kept by triggers like the Bible's; `bm25` weighs the title most). `theme_id` is `set null`;
`program_items.song_id` is `restrict`, answered by `song:usages` and «Delete anyway».

**Linked folders** (`0022`, owner 2026-11-05: «las carpetas de la computadora, como en Media»): a song read from
a file of a folder linked in the Songs tab is a row of `songs` with `source_folder`, `source_file`, `source_index`
(which song of a ChordPro file: its `{new_song}` blocks counted, an empty or wordless one too) and `source_mtime` —
`NULL` for a library song. `song:listFolder` (`services/song-files.ts`) reads the folder's top level (a symbolic
link to a song file is that file); a file whose mtime did not change keeps its rows, one that changed is read again
INTO THE SAME ROWS (`SongsRepo.syncFile`), each song finding its row by title and place, then title, then place
(`matchRows`: a song removed above it outside the app must not shift the others, nor a saved program's song), so
its id, theme and the programs using it survive — and what the file's format cannot hold (`fromFile`: a ChordPro
file's notes) stays the app's. A file that reads as no song for a moment (emptied by an editor before it writes, a
broken XML) keeps its rows; the rows of a file no longer there go, and so do a folder's once it is unlinked (on the
next `song:list`). A row its file let go but a saved program sings becomes a library song, untied and saveable
(owner, 2026-11-06), never «changed outside» forever — and so does one the unsaved order of service sings
(`DraftRepo.songIds`: no foreign key reaches into the draft's JSON, review 2026-11-06). A text that is no song this app reads (Lyrix's dashes for a
title, another program's XML) is never listed — nor overwritten.

Saving such a song writes its file first (owner: «se edita el archivo real, siempre»), and only when the edit
changes something the file holds (owner, 2026-11-06): a theme, or notes a ChordPro file has no place for, never
touch it — asked of the file's REAL format (a `.txt` may be either kind) before anything can refuse, so such an
edit never fails because of the file (read-only, changed outside). The file is rewritten IN PLACE (`songs/song-writers.ts`, `rewrite…`): of a ChordPro file only the song's
own block is replaced — the other songs stay byte for byte, a wordless one too — and of that song what stands above
and below its words stays (`{key}`, `{capo}`, `{tempo}`, `{subtitle}`, `{meta: …}`, any other directive, remarks,
a tab or a grid after the lyrics) but for the fields the edit changed; of an OpenLyrics file every `<properties>`
child the writer does not make (alternate titles, songbooks' names, key, tempo, themes…), the authors' types while
the authors are the same, the verses of a third language or a transliteration, the languages' own codes, and all
outside `<properties>` and `<lyrics>`; of a SongSelect file the church's licence lines. A ChordPro edit that
leaves the words alone (a title, an author) leaves their lines byte for byte but for a changed field's directive.
What is still lost when the words change: what sits AMONG them — a remark, a tab or a column break between two
sections, an OpenLyrics formatting tag. The block is found by the song's title, then its place, and appended when
neither is there: a place an older build counted another way never writes over another song, and the row is tied
to the block just written — never to another song of the file, even one that reads back as no song. The file keeps the encoding it was read in
(`readText`/`encodeText`, `main/decode-text.ts`: single-byte encoders built by inverting the decoder), so untouched
text stays the same bytes and a wrong guess (a Windows-1251 file read as Windows-1252) never breaks it; only an
edit with a character that encoding cannot hold writes UTF-8 — with a byte-order mark for a text file, and an XML
declaration that names it (`withXmlEncoding`). A symbolic link's target is written (the link stays a link), through
a sibling with the file's permissions (where its file system keeps any: a share or exFAT failing to take them never
fails the save) renamed over it; a read-only file is refused (`SONG_FILE_UNWRITABLE`), a file changed outside the
app since it was read too (`SONG_FILE_CHANGED`), never overwritten. A file tied to both a library song and a linked
folder's: the save refreshes the other side's row of that song — by its block, its old title as a check, never the
title alone (two songs of a file may share one: a file's name is every untitled song's title) nor among the saved
row's own file's rows — and the mtime of every row read when the saved one was (`SongsRepo.wroteFile`), so the
other side never reads it as changed outside; a row read at another time keeps its mtime and reads the file again. What each format cannot keep is one
table, `SONG_FILE_LIMITS` (`shared/song-file-limits.ts`, by the file's name for the editor's warning). The app never
deletes a file: the editor offers no «Eliminar» for such a song.
The library view is `source_folder IS NULL`; the search is inside the view (`song:search`'s `folder`, filtered
before the `LIMIT`); an import checks repeats against the library only. Settings: `songs.linkedFolders`,
`songs.activeView`, `songs.sort`. An unreleased `0022_song_folders` (folders of the app's own) ran on the
owner's profile the same day and was replaced: its `song_folders` table and `songs.folder_id` stay there, unused.

A theme is one `SongTheme` JSON per row; every knob added after F1 (outline, footer, fade…) reads its
default from a stored row that predates it. The default theme is seeded ONCE (`songs.seeded`) from the
operator's verse style at a singer's size (6 / 2.5 cqw); the last theme cannot be deleted
(`SONG_THEME_LAST`), and deleting the default one resets `songs.defaultThemeId`. That first theme is
«Clásico» (black) since the starter look below; installs seeded earlier keep the row they have.

## The starter look — `look.seeded`, and "untouched" is equality with a factory value

`seedStarterLook` (owner, 2026-11-05: «que se vea lindo») copies the backgrounds the app ships
(`resources/backgrounds/`: 8 stills and 4 loops, drawn by `scripts/make-backgrounds.ts`) into
`<userData>/backgrounds/` under the language's names — never referenced in place: an AppImage mounts
somewhere new on every launch — and adds them to the library; then six song themes over them, three
overlays, and on a NEW install `songs.defaultThemeId` = the first new theme. It runs after the other
seeds, in one transaction, once per `look.seeded` version (a number, so a later look can be offered
again), and the E2E harness skips it with `--no-starter-look`.

Their rows hold the absolute path, the user's name inside, so a profile copied to another computer or
user found every one «No encontrado», and every look over them black. `reattachBackgrounds` (2.8.1) runs
at every launch before the look: a MISSING row whose path ends in `<profile folder>/backgrounds/<file>`
(either separator) is `relocate`d to this profile's copy of that file. When this profile has no file of
that name, one that is a factory background's name in any language is copied back from
`resources/backgrounds/` first: a copy restored on a computer in another language (2.9.0) points at
«Noche.webp» where the new profile seeded «Night.webp». The profile folder's name is part of the match on
purpose: a church's own folder called `backgrounds` is never touched, nor a file whose name is no
background of the app's.

On an existing install it only ADDS, and restyles what is still exactly as it came (owner): the verse's
style when it deep-equals `DEFAULT_BIBLE_STYLE`, a time scene's when it deep-equals a FACTORY style —
today's `DEFAULT_SCENE_STYLE` or the pre-rebrand one (`#04132b`, `#84adfc`, `#f5f5f5`). That second
value is not hypothetical: the owner's own Mac profile, seeded before 2026-10-22, had two scenes in it
untouched, which a check against today's default alone would never have dressed. A future change to a
factory default has to add the old value to that list.

Version 2 dresses LOGO without an image: `logo.background`, still the factory black, becomes «Noche» —
found in the library at the path version 1 copied it to, never added again, so a background the
operator deleted stays deleted. Each version runs once, in order, in the same transaction.

**Chords** (2026-11-05) are written inline in that text, ChordPro-style (`[G]Amazing [C]grace`, `CHORD_PATTERN`:
a word in brackets is not one), and stored APART: `SongSlide.chords`, one list of `{ at, name }` per line, so
`lines` stay the bare words everything else reads — the projector, the fit, the search, the translation.
`slideFromWritten`/`writtenLines` go between the two; a header is ONE pair of brackets around the whole
line, so `[G]Cuán grande es [D]` is a line. Since 2026-11-06 (owner) the Latin names are chords too (`[Do]`
… `[Si]`, with `m`, `7`, `maj7`, `sus`, `dim`, `aug`, `add`, `°`, a bass in either notation), `♭`/`♯` are
accidentals in both, and `[N.C.]` is one; a line of chords alone (`[G]`, `[G] [D] [Em]`) is a line of chords with
no words — a slide of only such lines is a valid instrumental slide, and every reader keeps them (ChordPro,
OpenLyrics, OpenLP), so what the app writes reads back — never a header, unless the one chord is a
section's name or short form in the INTERFACE's language (Spanish `[C]` is still the chorus, `[E1]` verse 1;
English `[E7]` ending 7). A line's chords are stored left to right (`isSongUpsert` refuses others: written back
they repeated the words between them). They survive `splitSection`, `withTranslation` and `sectionsIn`
(never over a translation), and only `stageOutputFor` puts them in an output: the musicians' screen draws
them, at 0.66 of the song's size so the measured block still fits; the projector cannot.

**The editor's text reads back to the very sections it was written from** (2026-11-06: opening a song and saving it
never changes it — the HASD hymnal's «Coro» printed at the top of a verse's slide became a section). Three rules in
`serializeLyrics`/`parseLyrics`: once a text has a bracketed header naming a known section, a bare label («Coro»,
«Verse 2:») is lyrics — bare labels are headers only in a text with no such header (EasyWorship's); a lyric line
the parser would misread — a header («[Repeat x2]»), a lone chord that names a section, a blank or a line starting
with `\` — is written after a `\`, which the parser drops; and a header carries its number («[Coro 1]») whenever
the bare name would read as another section, and always under an order of the operator's own — a numbered header
keeps its number even when a bare one is typed above it, so a new «[Puente]» never takes over that order. An order
the text can say (`followsText`: every section in written order, one sung again) is written into it as the header
once more with nothing under it, so it still follows the lyrics once reopened. Spaces at the END of a line are the
one thing the text cannot carry; the editor keeps the stored sections while the text is untouched anyway.

The lyrics text format (`shared/song-text.ts`) is shared by the editor and the EasyWorship importer
(`main/songs/`): EasyWorship's RTF (`SongWords.db`) becomes plain text whose blocks start with a label
(«Verse 1», «Chorus») — exactly what `parseLyrics` reads, in any of the four languages. Its databases
are opened read-only and never queried with `ORDER BY`/`WHERE` on text: EasyWorship 7 declares a
collation SQLite lacks.

OpenLP (`songs.sqlite`, 2.0 on) and OpenLyrics (its export, one `.xml` per song) need no text format:
both name each verse (`v1`, `c`, `v1a` a part of verse 1) and `main/songs/openlp.ts` builds the sections
straight from them — `[---]`, `[--}{--]` and each `<lines>` a slide, chords apart (`SongSlide.chords`) and
formatting tags dropped, the verse order into `order`. A `<br/>` ENDS a line: the one OpenLP writes after a
slide's last line is no line, one with nothing before it is an empty line the slide has (`cutLines`). A verse in a second language is the translation, paired by
section and slide (`withTranslation`; owner, 2026-11-05: the FIRST language met is the lyrics, a third is
dropped). A language is its primary subtag (`en-US` is `en`), a verse with no `lang` is the lyrics', a
transliteration (`translit`) is never projected, and a section only the translation has comes in as lyrics — no
words dropped (2026-11-06). Text keeps its own spaces but XML's (an ideographic space stays), and the notes
(`<comment>`) are kept as written, one `<comment>` when written back. OpenLP's hymn number is the first
`songs_songbooks.entry` (2.4) or `songs.song_number` (2.2), its `comments` the notes, and a `temporary` song (kept
only for a service) is not imported.

SongSelect's lyrics (`.txt`) and ChordPro (`main/songs/text-files.ts`) DO go through the text format: each
is rewritten as the editor's text — a bracketed label over each block — and parsed by `parseLyrics`, so a
label the app has no word for («Interlude») is a section of its own instead of a lyric line. Which one a
file is comes from its words (a directive line = ChordPro, unless a plain title line opens a text with a `CCLI`
footer: SongSelect, whatever braces a lyric holds — «{bis}»), never its extension. SongSelect's footer changed
order in 2023 (authors above «CCLI Song #»); both orders are read: the authors are the footer's first line without
«©», the copyright every other line (two in OpenLP's `TestSong.txt`), the licence words never. A SongSelect
block's first line is its label when it names a section, looks like one (a word, maybe a number) or has two blank
lines above it; otherwise it is words, a slide of the section above. In ChordPro, `{start_of_…}`/`{end_of_…}` and
a `{comment}` that names a section are labels — unless a blank line follows the comment: then it repeats that
section there (OpenLP's swing-low), like `{chorus}`, which repeats the last chorus; a line naming a section where
a paragraph starts («Verse 1», «Bridge 2:»), or with its colon on a section's first line («Verse:»), is that
block's label; a paragraph outside any section is a verse of its own; `{+settings…}` is a directive; chords come
in apart, tabs and grids are dropped, and `\[`, `\#`, `\{`, `\\` are words the writer escaped (a bracket that is
no chord, a line that would be a remark or a directive); a line of chords alone comes in, and a lone `\` is an empty
line inside a slide (a blank line starts another). Every text file — SongSelect, ChordPro, OpenLyrics, and
a bible module too — goes through `decodeText` (`main/decode-text.ts`): its byte-order mark, else its XML
`encoding`, else UTF-8 when the bytes are valid UTF-8, else Windows-1252 (OpenLP 2.0 wrote OpenLyrics as
`windows-1252`: read as UTF-8 every accent was a «�»). «Importar» is one picker for every format
(`importSongFiles`): each file read by what it is — `.xml` OpenLyrics, EasyWorship's `Songs.db`/`SongWords.db`
(their folder; EasyWorship 2009's Paradox `Songs.DB` is refused as too old, `EW_OLD`), any other
`.db`/`.sqlite` as OpenLP's, SongSelect or ChordPro text for the rest. All of it goes through `writeSongs`
(`services/song-import.ts`): one transaction, the same title with the same words skipped as repeated — and when
that library copy had no file yet it is tied to this one, first taking what the file holds (chords, authors,
CCLI…), or its next save would write them out of the file (owner, 2026-11-06); `refreshedFrom` keeps its theme
and what the file does not hold — its format has no place for it, or this file simply has none (a number, notes,
an order, a translation, chords: review 2026-11-06). The result counts apart the songs without a title or words (`problems`) and the files
that were no song file at all — another program's, broken or unreadable (`unsupported`).

`song_uses` (`0021`) is what the CCLI usage report counts (owner, 2026-11-05): `projection:show` writes a
row when a song goes live, ONE per song per local day (`SongsRepo.recordUse`), never pruned — unlike
`projection_history`, which keeps 5000 rows and so cannot hold the six months a report covers. Each row
keeps the title, authors and CCLI number it went live with (a song deleted since still reports, `song_id`
set null); a song still in the library reports under its current ones (`usesBetween` joins `songs`), so a
CCLI number filled in afterwards counts. Settings ▸ Songs ▸ «Informe CCLI» exports `[from, to)` as CSV
(`services/song-usage.ts`, `songs/usage-report.ts`): every song used — an empty CCLI column shows what is
missing — most used first, its days; a BOM for Excel and `;` as the separator except in English (`,`).

## FTS5 without accents

`bible_verses_fts` uses `tokenize="unicode61 remove_diacritics 2"` — searching "espiritu" finds
"Espíritu". The table is *external content* over `bible_verses` (it doesn't duplicate the ~4MB of
text) and is kept in sync with `AFTER INSERT/UPDATE/DELETE` triggers. A bible's load sets the
insert trigger aside inside its transaction (`DROP TRIGGER`, the saved SQL from `sqlite_master` put
back at the end) and indexes only its own rows with one `INSERT … SELECT`: the trigger firing 31 102
times was ~0.5 s of a ~0.6 s load, and the `'rebuild'` this used to run afterwards — not instead —
re-indexed every installed version. A whole bible now loads in ~0.15 s plus its parse (~0.1–0.2 s);
see [`an-fts5-rebuild-after-a-bulk-insert-does-not-replace-the-sync-triggers.md`](../../.claude/knowledge/an-fts5-rebuild-after-a-bulk-insert-does-not-replace-the-sync-triggers.md).

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

A **new profile** starts with the system's Videos, Pictures, Music and Documents folders linked in Media
(`library.linkedFolders` ← `systemLinkedFolders()` in `paths.ts`, owner 2026-11-09) — only those that exist,
never the home folder. They are listed only when their view opens; on macOS that first opening asks for the
privacy permission of that folder. Songs has no system folder and starts empty. `--no-system-folders` (the E2E
harness) keeps the library bare.

A linked folder that isn't there (`library:listFolder`) answers `FOLDER_MISSING`, not an empty
list: the two were indistinguishable. Its view offers «Buscar la carpeta…» (`library:relocateFolder`).

**One relocation follows the whole move** (owner, 2026-11-13; `services/relocate-move.ts`). «Relocalizar…» on a
missing file and «Buscar la carpeta…» on a missing linked folder both take the move from the old path to the new one:
their common trailing folder names dropped (`moveBetween`: `D:\Iglesia\Videos` → `E:\Iglesia\Videos` is `D:` →
`E:`; `C:\Users\juan\Videos` → `C:\Users\maria\Videos` is the user folder). Every path the app keeps under the old
part is then tried under the new one: library rows (any `in_library`, merged by `relocate` when the new path is a row
already), a deck's operator-chosen soundtrack (the automatic one re-resolves itself), Media's and Songs' linked folders
and the views open on them, folder songs (`source_folder`, so their ids and the programs singing them stay) and library
songs tied to a file. A path changes **only when its old place is gone and its twin is there**, so nothing that still
works is touched and nothing points at a file that does not exist. Paths are split on either separator, so a Windows
profile opened on a Mac or Linux follows too. The stats are asynchronous and in chunks (a gone drive answers slowly);
the rows move in one transaction (`relocateMany`). Song rows move before the settings: `song:list` lets go of the songs
of a folder no longer linked. A folder linked by hand at the new place keeps its own songs and is not linked twice.

And no import accepts a `._x.pps` (the AppleDouble that
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

The app ships nine Bible versions, public-domain or freely licensed classics in the interface's four
languages (2026-11-09), listed in `src/main/db/seed/bundled-bibles.ts` (`BUNDLED_BIBLES`: code, file,
name, language, credit) and packaged from `resources/bibles/` with `extraResources`:

| Code | Version | Language | File |
|---|---|---|---|
| `rv1960` | Reina-Valera 1909 | es | `rv1909.json` (see below for the code) |
| `vbl` | Versión Biblia Libre | es | `vbl.xml` |
| `kjv`, `asv`, `web` | King James Version, American Standard Version, World English Bible | en | `<code>.xml` |
| `riveduta1927`, `diodati1885` | Riveduta 1927, Diodati 1885 | it | `<code>.xml` |
| `almeida1911`, `biblialivre` | Almeida 1911, Bíblia Livre | pt | `<code>.xml` |

Every file after the RV1909 is **Zefania XML** (read by `bible-formats/zefania.ts` like any import): it
carries the version's name and language and each verse's OWN number, so a verse a text leaves out (the
ASV's 16, the WEB's 4) is a gap and never shifts the verses after it — the JSON reader numbers verses by
array index. Each holds the 66 books with the book names the text itself prints, and nothing but the
verse's words. They are built from their sources by maintainer scripts kept outside this repo, with the
plans (`../docs/plans/2026-11-09-bienvenida-y-biblias/scripts/`); `resources/bibles/NOTICE.txt` says
where each text comes from, its licence, and what was changed. A version whose licence asks for a credit
(the Versión Biblia Libre, CC BY-SA 4.0; the Bíblia Livre, CC BY 4.0 BR) carries it in the catalog, and
Settings shows it under that version.

A **new profile** (`isNewProfile` in `initDatabase`) gets every version of its interface language — the
locale set from the OS just before — in the catalog's order, and the first becomes
`bible.defaultVersionId`; the E2E suite (`--lang=es`) starts with the RV1909 and the VBL. Every other version is
installed with one click in Settings ▸ Bible (`bible:bundled`, `bible:installBundled`), no internet;
deleting one makes it «not installed» again. An existing profile is never given a version on its own.
All bundled versions are `isBuiltin`. While the first-run welcome is pending, choosing another language in its
first step swaps them: the new language's are installed (the first becomes the default) and the previous
language's go, unless a saved program cites one (`swapBundledBibles` in `welcome/HelloStep.tsx`).

Whatever the format, `BookCollector.add` stores a verse as one line: runs of spaces, tabs and line breaks
become one space (eBible's USFX wraps some verses mid-sentence).

They are copied into the tables when installed, not at build time — that way an app update never
overwrites the user's DB. `bible:import` does exactly the same: it parses the file in memory and
inserts rows. Both run **on a worker thread with a connection of its own** (`seed-bible-worker.ts`, since
2026-11-10): on main they held it ~260 ms, and every media-engine frame crosses main — a video on air froze.
The seed's transaction is `IMMEDIATE` because of that second connection (see
[`.claude/knowledge/a-second-sqlite-connection-turns-a-deferred-read-then-write-into-busy-snapshot.md`](../../.claude/knowledge/a-second-sqlite-connection-turns-a-deferred-read-then-write-into-busy-snapshot.md)).
The launch's seed (`seedBuiltinBibles`) stays on main: nothing is on air yet. **It never writes a file inside the app directory** — the legacy bug of
`import-bible` writing to `data/bible/` (broken in a packaged install because of permissions) does
not exist in this design.

Idempotency by `sourceHash` (sha256 of the file, `bibleFileHash`) in `bible_versions` — an installed
bundled version is re-seeded only when its file changed, and `bible:import` refuses a file whose hash an installed
version already has (`BIBLE_ALREADY_INSTALLED`, naming that version; owner, 2026-11-06): every import
gets a new random `code`, so the same file twice used to be two identical versions. A reseed **keeps the name the row already has**: the version can be
renamed from Settings (it's what the projector writes below the verse), and a corrected
file in a later build can't undo that rename.

A file that doesn't say its language is stored as `es` (the column's default): Settings offers an
imported version's language as a select (`bible:setLanguage`, a two-letter tag — `isBibleLanguage`),
and both the Settings list and the Bible tab's picker group the versions by it, the languages in the
order they first appear in the operator's arrangement (the picker only once there are two).

The bundled text is the **Reina-Valera 1909** (public domain), although up to 2.2.0-beta.3 it was
called «Reina-Valera 1960» and the file was `rv1960.json`. Its `code` is still `rv1960` because
that's the identity `bible_favorites` and the reseed point to; what says 1909 is the file and the
name. Migration `0017` renames the row only if it still has the old name: a name the operator set
is theirs. A real RV1960 can't be bundled (it's under copyright): it gets imported.

### The `bible.builtinSeeded` flag — and why it's only checked if the row is NOT there

`seedBuiltinBibles()` runs on every startup, so without a flag the RV1909 came back on the next
launch and «delete» didn't mean delete. But the flag **can't** just switch the seeding off, because
the seeding is also the update path. The three rules of an existing profile, in order (a new one
gets its language's versions and the flag, as above):

| State | What it does |
|---|---|
| the row exists | seeds anyway — the hash short-circuit turns it into one digest per startup, and that's how a corrected file reaches an existing install; true of every installed bundled version |
| it doesn't exist and the flag is set | the operator deleted it (or the profile started in another language): that's respected |
| it doesn't exist and the flag isn't set | a database never offered it — the legacy app's: seeds the RV1909 and sets the flag |

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
saved program keeps the text and the reference and loses only the link; the open schedule and its draft
lose the same ids (`forgetBibleVersion`, and `withLiveBibleIds` on every save and draft load, so a dead id
can never fail a save on that FK)—, and the `bible_favorites`/`bible_recents`
rows, which are keyed by CODE and abbrev precisely to survive a delete-and-reimport. `force` here is informed
consent and nothing more: unlike a timer scene's, this delete can't fail on an FK.

## Favorites and recent passages

The Bible tab's ⭐ list (2026-11-05). Both tables name a passage by **book abbrev** + chapter + verses,
never by a version's row ids, and the renderer opens it in whichever version is being browsed: the
abbrev is the same in every version (`canon.ts`). `reference` is how it read when saved, shown only
when the browsed version lacks that book. `version_code` records where it was made and nothing reads it.

- **Favorites** (`bible:favorites`, `bible:setFavorite`): one verse each, starred from the tab's
  footer on the verse in PREVIEW, listed in Bible order. Unstarring removes every row that contains
  the verse.
- **Recents** (`bible:recents`, `bible:recordRecent`): what went LIVE, newest first, at most
  `BIBLE_RECENTS_MAX` (20) rows. One row per chapter: reading on through the chapter at the top
  widens its range (`Juan 3:16-18`); another chapter goes on top, replacing an older row of itself.
  The control window records it — `projectVerse` and a program row's verse —, because the `bible`
  output carries only text: `projection_history` cannot tell which book a verse came from.

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

**And once a day** (2.8.1): a month without migrations left a month-old copy as the newest. At launch,
before the database opens, `dailyBackup` takes the same verified snapshot into `userData/backups/daily/`
when the newest copy there is 24 h old (or dated in the future: a clock set back), keeping the last 7.
Their own folder, so they never rotate out the pre-migration copies. It costs a launch about 0.45 s once a
day on a 90 MB profile with nine Bibles (measured 2026-11-13); a typical one is a fraction of that.

**Settings › Backups** (2.9.0, owner 2026-11-13: its own section; `db/backups.ts`). «Hacer una copia» takes the same
snapshot into `daily/` (it counts within the 7) on a worker thread (`backup-worker.ts`): on that 90 MB profile
`VACUUM INTO` held a thread 453 ms and `integrity_check` 486 ms, and every engine frame crosses main.
«Restaurar…» lists every kind (daily, before an update, before a restore), newest first, each with its programs
and songs counted (a read-only open, a few ms), or takes a `.db` picked anywhere («Elegir otra copia…»).

**A restore never touches the open database.** The chosen copy is STAGED at `backups/restore-pending/worship.db`
(its own folder: at the top of `backups/` it would read as a pre-migration copy and be rotated out): a fresh
snapshot of it (never the file itself: a USB stick may be gone at the next launch, and a database left open
elsewhere has its newest rows in its `-wal`), verified, with Himnova's tables and no migration newer than this
build's journal, its date kept. Refused copies stage nothing and say why (`BACKUP_REFUSED`, worded by main).
Then the app restarts: the control window asks first what a quit puts at risk (`quitRisks`, like «Restart and
update»), so main's quit skips the close guard (`releaseForUpdate`; asked again there, a «Cancel» would leave
the copy staged for whatever launch came next) and relaunches: `app.relaunch()`, except in an AppImage, where it
never came back (its relaunch helper runs from the mount that goes with the process), so a detached shell outside
the mount closes what it inherited, waits for the PID and runs `$APPIMAGE` (`startAfterExit`). At the next launch, before `openForLaunch`, `applyPendingRestore` copies what is there now to
`before-restore/` (the last 3; without it nothing is replaced), deletes the `-wal` and `-shm` (a `-wal` left next
to the restored file would be replayed onto it; the quit checkpointed it and the copy above holds it anyway) and
renames the staged file over `worship.db`. The migrations then run as on any launch: a copy from before an update
takes its pre-migration snapshot and comes up to date. The control window says it once
(`backups:launchRestore`). The relaunch was verified outside Playwright (its loader waits for a debugger, so a
relaunched E2E app never starts): the window back with the copy in place in 1.5 s on the Mac, 1.7 s with the Linux
unpacked binary and 2 s with the AppImage (2026-11-13).

## Defensive Bible parsing (the JSON path)

`src/main/db/seed/bible-formats/json.ts` tolerates the same variants as the legacy version:
array-of-books / `{books:[...]}` / object-by-name container; a book with `name` or `nombre`;
chapters as an array or an `{"1":...}` object; verses as string[]/`{text}`[]/`{verse}`[]/object.
Verified against the real `rv1909.json`: it **does have `name`** in all 66 books — the "shows
'Libro' 66 times" bug that the legacy version of this file documented (`.claude/knowledge/`) didn't
reproduce with the current data; no fix was ported for it.
