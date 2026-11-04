# 03 — Slide pipeline (every deck read by the app, nothing converted)

Every deck is read by the app itself — nothing is converted by another program, nothing has to be
installed (owner, 2026-11-03: «usar solo nuestro motor de compatibilidad… todo puro en nuestro
programa»). A presentation is read into a model per slide and drawn in the renderer; a legacy deck
made of pictures — the hymnal — is served picture by picture straight from its file; a PDF's pages
are drawn by pdf.js when a window asks for one, and kept only in memory. Nothing is written to disk
but the sound and video a `.pptx` carries. There is nothing Windows-only either: the app runs and is
validated the same way on macOS, Windows and Linux.

## The model change

Before: *remote control of a live PowerPoint slideshow* — main held a slide cursor, PowerShell
moved it, and the PNGs were an ephemeral byproduct in `os.tmpdir()`.

Now: **a deck is content**. It is read once and recorded; main no longer has a slide cursor, it has
a **cache**. That reframing alone is what deletes `ppt:next/prev/goto/currentSlide/close` — the
cursor lives in the renderer's store and it is the only copy.

## Which reader — by what the bytes are

```
source ──containerKind (magic bytes, never the extension)──┐
  binary (OLE2) ── readBinaryDeck: only pictures? ── yes ──► native deck   image_format 'native'
       │ no                                                                 (ppt-binary.ts, on main, ~1 ms)
  ooxml │ binary │ odf ── pptx-worker.ts thread ──► SlideModel per slide ──► model deck   'model'
  pdf ── pdf.js in a hidden window: page sizes ──► PDF deck   'webp'|'png' with cache_dir '' (pages drawn on request)
  no reader opens it ── sniffUnreadableDeck ──► fails: DECK_PASSWORD | DECK_OLD_FORMAT | NOT_A_PRESENTATION
```

`prepareDeck` (`deck-service.ts`) asks in that order: `nativeDeck` → `modelDeck` → `pdfDeck`
(together `sourceDeck`). There is no queue and nothing to cancel: until 2026-11-03 a PDF was
rasterized whole into the slide cache, one at a time behind a two-lane queue with preemption; that
queue, `deck:cancel` and the `slides.preemptBackground` escape hatch are gone.

## Model decks: a deck is drawn, not converted (2026-10-26)

Any presentation that isn't a legacy deck of pictures or a PDF is read into a **model of what to
paint** per slide and drawn in the renderer by `SlideView`. No PDF, no images on disk:

```
deck ──pptx-worker.ts (by container)──► SlideModel per slide ──► SQLite (deck_slides.layers)
                                                                        │
SlideView (React, components/shared/slide-view/) ◄── worship://deck/<id>/<n>/model ◄──┘
        └── pictures, metafiles (as SVG) and embedded fonts ◄── worship://deck/<id>/part|font/<part>, read from the file
```

- **The owner's decisions** (2026-10-26): what the model can't draw exactly (3D bevels, artistic
  effects, a SmartArt without its drawing) is **approximated, never refused**. The reference for
  "right" is PowerPoint, LibreOffice second. Fidelity is measured against PowerPoint's own
  rendering, slide by slide, and improved in place; `SLIDES_MODEL_VERSION` is bumped when a reader
  changes what it puts in a model, so every model deck is read again.
- **The readers**, all on one **worker thread** (`pptx-worker.ts`, started with the first deck
  through electron-vite's `?nodeWorker`), whose `readModel` switches on `containerKind`:
  - `ooxml` (`.pptx`, `.pptm`, `.ppsx`, `.ppsm`): `src/main/slides/pptx/` (entry `reader.ts`) for
    the model and `readPresentationMeta` for timings, transitions and media, both through
    `readZipEntries`;
  - `binary` (a legacy `.ppt`/`.pps` `readBinaryDeck` refused — text, shapes, an embedded sound):
    `readPptModelDeck` in `ppt/model-reader.ts`;
  - `odf` (`.odp`): `readOdpModel` in `odp/entry.ts`.

  The last two return the same `{ deck: PptxDeck; meta: PresentationMeta }` the OOXML path builds,
  and everything after them is shared (`recordModelDeck`). The OOXML reading parses every slide
  twice, and on a template with a 22 MB map slide the two took 11 s on the thread that answers IPC
  and serves `worship://`; on the worker it costs main only the copy of the result, each slide's
  `layers` handed back already as JSON. A worker that dies on a file fails that deck; it is never
  retried on main. The preset geometries and the built-in table styles come from
  `resources/ooxml/` (`paths.ts` → `ooxmlDir`, shipped as `extraResources`). Pictures, media and
  fonts are never read here — the model names them by part. Every reader writes colours as
  `rgb()`/`rgba()` (`css()` in `pptx/color.ts`): the painter reads gradient stops' channels back
  out of the string, and a `#rrggbb` stop paints garbage
  ([finding](../../.claude/knowledge/slide-model-colours-must-be-rgb-strings-and-a-trailing-br-opens-no-line.md)).
- **What is stored**: a `slide_decks` row with `image_format = 'model'`, `render_width = 0`,
  `converter_version = SLIDES_MODEL_VERSION`, `timings_source` = the container it was read from
  (`ooxml`/`binary`/`odf`, or `none`); one `deck_slides` row per visible slide whose `layers`
  column is the `SlideModel` JSON (median 6.5 KB, but a slide with a big table or chart can be
  megabytes — that is why it is served by url and never inlined in a DTO). `cache_dir` is `''`
  unless the deck embeds sound or video, which are extracted there (`ponytail:` until the media
  engine serves them from the file by range). `extractAudioParts`/`extractVideoParts` read a part
  by name whatever the container: a zip entry of a `.pptx` or `.odp`, or a range of a legacy
  binary's streams (`readParts` → `ppt/parts.ts`). Timings, transitions, sound
  and video are aligned with the drawn slides by visible position; when the counts disagree the
  timings go.
- **What is served**: `…/<n>/model` is the JSON; `…/part/<part>` is a picture as is, or an
  EMF/WMF (or its gzipped `.emz`/`.wmz`) as the SVG `metafileToSvg` makes of it — Chromium decodes
  neither; `…/font/<part>` is an embedded font (EOT / MicroType Express) rebuilt as TrueType by
  `decodeEmbeddedFont`. All `immutable`, and all 410 once the source is no longer the file the model
  was read from. A model slide's `url`/`thumbUrl` serve no image: `modelUrl` (on `DeckSlide`, the
  `slide` output and `DeckStatusSummary`) is what draws it, and every consumer — `OutputView`, the
  two slide grids, the library tile — checks it first.
- **In the renderer**: `lib/slide-models.ts` fetches a model once per window and hands it out only
  once the deck's embedded fonts are registered and its pictures decoded, so the projector never
  shows a fallback face or a picture arriving late; `OutputView`'s preload warms the neighbours
  through it. `ModelSlide` fits the slide into its box the way `object-contain` fitted the image.
  Faces a deck names but this machine lacks fall back to bundled metric twins (Carlito, Caladea,
  Liberation, `assets/fonts/slides/`); the open faces PowerPoint 365 fetches as cloud fonts (Open
  Sans, Montserrat, Source Sans Pro, with their per-weight family names) ship there as themselves.
  Office faces with no open twin (Candara, Agency FB…) are right on a PC with Office and a fallback
  elsewhere: the face chosen in Settings ▸ Slides (`slides.fallbackFont`, one of the faces Lumina
  ships, or the system's sans-serif by default — one for every face, owner 2026-10-28), placed after
  the file's face and its twins, never instead of them. It and `ui.locale` (the language chart
  numbers are written in — the interface's, not the system's) reach the slide as `SlideTextSettings`:
  `App` mirrors them into `projection.store`, every `slide` output carries them (the projector has
  no settings), and `SlideView` hands them down through `SlideTextContext`. Changing either restyles
  a live slide in place, with no transition.
- **What the show hides stays hidden**: a sound or video set to «Hide during show» (its media node
  in `p:timing` says `showWhenStopped="0"`) is left out of the model, as the legacy reader leaves
  out the speaker icons `fHide` marks.
- **Sounds play on their own slides** (owner, 2026-10-27): each sound is placed by
  `placeAudio` on the deck's visible slides from its media node's `numSld` — 1 when absent, which
  is «this slide only», 999 for «play across slides»; whether it loops is that node's too, never
  guessed. The one that plays from the first slide to the end is the deck's `soundtrack` (the
  clock `deck-autoplay.ts` follows); every other one is in `DeckDTO.sounds` and
  `effects/deck-sounds.ts` plays it.

## A legacy deck with text: the binary model reader (2026-11-03)

What `readBinaryDeck` refuses — text, shapes, a slide not covered by a picture — is read by
`src/main/slides/ppt/` into the same `SlideModel` (owner: no LibreOffice behind it, approximated,
never refused). The whole deck goes one way: native (pictures) or model, never half each.

- **Path through the file**, MS-PPT: `Current User` → the newest `UserEditAtom` → persist directory
  → the document, its slide, master and notes lists → each slide's drawing. A slide sits on its
  master (a title master, itself on a main master): the scheme, the background and the master's
  objects follow the slide's `fMasterScheme`/`fMasterBackground`/`fMasterObjects`. Of the master's
  placeholders only the date, number and footer are drawn, and only as the headers/footers say.
- **Text** (`ppt/text.ts`): characters, then paragraph and character runs over the master's text
  style for that kind of text (title, body, other…) and indent level. A placeholder's text lives in
  the slide list next to the slide's persist atom, named by index from the shape; its ruler, in the
  shape. The master styles' own record layout is not the run's — LibreOffice's `svdfppt.cxx` is
  where PowerPoint 97's quirks are written down, and the reader follows it.
- **Shapes** (`ppt/escher.ts`): OfficeArt properties (with their complex data), a shape's over the
  master shape it names (`hspMaster`), booleans flag by flag. **Not** over the drawing group's own
  property table: that is PowerPoint's default for new shapes, and inheriting it painted white
  backgrounds green and filled every picture frame (measured: 38% → 27% slides wrong). Geometry is
  the file's freeform, or the shape type's built-in definition from Office's own table as
  LibreOffice carries it (`resources/ooxml/mso-shapes.json`, extracted from svx
  `EnhancedCustomShapeGeometry.cxx`, MPL-2.0), both in the same binary formula/segment encoding,
  one evaluator. WordArt is its text stretched to fill the box (`TextBody.stretch`: the painter
  measures and scales it, keeping the outline's own width), as PowerPoint draws plain WordArt.
- **Pictures, fonts and sounds are never extracted to read the deck**: a part name says where the
  bytes are (`ppt/<d|p>/<offset>/<length>/<raw|z|dib>.<ext>`, `ppt/parts.ts`) and `worship://` reads
  them from the original — a JPEG/PNG as is, a metafile inflated (then the SVG of `metafileToSvg`),
  a DIB given its file header. The protocol decides by the source's container, never by the name
  (an OOXML part also starts with `ppt/`).
- **Sounds**: the transition's (`SlideShowSlideInfoAtom`, «loop until next sound» across the deck)
  and embedded sound objects on a slide, across the slides their animation says. A linked sound is
  `linked-audio.ts`'s, as for the hymnal.
- **Autonumbered bullets** come from the PowerPoint 2000 extension (`___PPT9` tags): a character
  run names its paragraph's entry by index (`fontStyle` bits 0x3C00), the shape keeps its own and
  the document keeps the placeholders' (by slide id and text index) and the masters' levels.
- **Not drawn** (counted per slide in `unsupported`): WordArt's warps other than plain stretching; a
  two-colour bitmap pattern is its average; PICT and TIFF pictures (Chromium decodes neither); a
  linked movie.
- **Measured** (2026-11-03): the 185 binary decks of the corpus that went to LibreOffice, 0 throws,
  1.411 slides in 0.5 s; 588 broken copies of them, 0 hangs (worst 103 ms), the unreadable fail
  clean. Against PowerPoint (`tools/release-checks/pptx-render/`, references in `_ref/ppt-pdf`):
  16 church decks, 240 slides — exact 31%, close 18%, «visible» 41% (looked at: glyph smoothing),
  wrong 10% (WordArt, and the harness's known capture of the previous slide); the whole corpus of
  160 decks (mostly POI and LibreOffice test files) 26% wrong.
  `oracle.ts` compares the model with PowerPoint's own reading of the same file (PowerPoint saves it
  as `.pptx`, the `.pptx` reader reads that) text by text — how the text shadow, the system colours
  and the soft defaults above were found.

## An `.odp`: the OpenDocument reader (2026-11-03)

An `.odp` (`containerKind === "odf"`: a zip whose `mimetype` says OpenDocument presentation) is
read by `src/main/slides/odp/` (`readOdpDeck` + `readOdpMeta`, joined in `entry.ts`) into the same
`SlideModel`. Its reference is **LibreOffice Impress** — the format's own program — not PowerPoint,
and Impress draws several things differently from what the XML says
([finding](../../.claude/knowledge/an-odp-is-drawn-the-way-impress-draws-it-not-the-way-its-xml-reads.md)).

- **What is read**: `content.xml` and `styles.xml` (automatic and common styles with their
  parents, master pages and their shapes, page backgrounds, presentation placeholders — an empty
  one is not drawn), frames, text boxes, pictures, custom shapes (evaluated from
  `drawooo:enhanced-path`), rects, ellipses, lines, polylines, paths, connectors, groups, tables,
  embedded fonts (`Fonts/`, plain TTF/OTF), page transitions, auto-advance, hidden pages, titles,
  notes and embedded sounds. Pictures and media are named by zip entry, served like a `.pptx`'s.
- **Approximated** (counted in `unsupported`): hatches as the nearest pattern, transparency
  gradients over non-linear fills, line ends as the nearest of the five, unrouted elbow connectors
  drawn straight, skew and measure lines dropped, Fontwork as plain text, 3D scenes left out; an
  embedded object whose replacement is Impress's own metafile (charts) and inline or linked
  pictures are missing; a «current date» field shows its saved text.
- **Measured** against Impress's PDFs (`_ref/odp-pdf`, 287 files: LibreOffice's test data, 58
  converted from the web `.pptx`, 26 real ones): 27% exact, 23% close, 23% visible, 26% wrong; the
  real church decks are the weak spot (lyrics `.odp` barely exist online, 6 found), and part of
  «wrong» is the reference's fallback fonts.

## A damaged slide in a good deck (2026-11-03)

A slide, layout or master part that is in the file but won't parse is drawn **without that part**
(`level()` in `pptx/reader.ts`): a broken slide part is its layout's and master's design and
background with nothing of its own; a broken layout or master leaves that inheritance out (the
master is still reached through the layout's relationships, which are a separate part). The slide
carries `SlideModel.damaged: true`, and only the **control window** says so — a warning mark on its
tile in both slide grids and a «Damaged slide» badge in the PREVIEW/LIVE column header while its
monitor shows it (`components/shared/damaged-slide.tsx`). The projector draws what could be read and
nothing else, by the same rule as a file it can't play. Only those three parts: a `.vml` or chart
part that won't parse is common (ActiveX decks) and costs one shape. What "won't parse" means is
narrower than it looks — see
[`fast-xml-parser-accepts-crossed-tags-so-only-a-truncated-part-is-refused.md`](../../.claude/knowledge/fast-xml-parser-accepts-crossed-tags-so-only-a-truncated-part-is-refused.md).

## A deck that won't open

When every reader declines a file (the worker threw on it or died, or all its slides are hidden),
`sniffUnreadableDeck` (`ppt-binary.ts`, pure, tested in `tests/main/container-kind.test.ts`) looks
at its bytes to say what the operator can do, and the deck fails with that `SlideError` code and a
localized reason (main's `mt()`):

| Code | What the bytes are | What the reason tells the operator |
|---|---|---|
| `DECK_PASSWORD` | an OLE file with `EncryptionInfo`/`EncryptedPackage` (an encrypted `.pptx`), or a PowerPoint 97 deck with an `EncryptedSummary` stream or the encrypted `CurrentUserAtom.headerToken` | remove the password in PowerPoint and save again |
| `DECK_OLD_FORMAT` | a `PP40` stream and no `PowerPoint Document` (PowerPoint 4), or a `Current User` too short to be the 97 atom (PowerPoint 95) | open it in a newer PowerPoint and save it as `.pptx` |
| `NOT_A_PRESENTATION` | anything else | it may be damaged or not a presentation; try saving it again from PowerPoint |

The answer is remembered by path and `(size, mtime)` (`unreadableStamp`), so a bad file isn't read
again on every open and an edited one is. The control window shows it where any failed deck shows:
the centre panel and the PREVIEW stage (`DeckConversionStatus`, main's reason as the hint, «Retry»),
and a GO LIVE that changes nothing explains itself in a toast (`explainDeckFailure` in
`lib/actions/playback.ts`). Nothing anywhere asks to install anything.

## Native decks: a legacy deck made of pictures is read, not converted (2026-10-26)

Every slide of the hymnal is an 800×600 JPEG with the lyrics drawn into it. For such a deck no
model is built at all:

```
.pps/.ppt ──ppt-binary.ts (OLE2 + PowerPoint 97 records, ~1 ms)──► layers per slide ──► SQLite
                                                                         │
worship://deck/<id>/<n> ◄── native-deck.ts: the JPEG as is, or an SVG ◄─┘  (read from the source, per request)
```

- **What is read** (`readBinaryDeck`): per VISIBLE slide (hidden ones are left out, as the show
  leaves them out), the topmost opaque JPEG that covers the whole slide is its base, and everything
  above it must be a picture drawn as is (the hymn's white logo, a PNG) or something PowerPoint does
  not show: off the slide, `fHidden`, or a sound/movie with `AnimationInfoAtom.fHide` — the speaker
  icon PowerPoint hides
  ([`libreoffice-draws-sound-icons-powerpoint-hides.md`](../../.claude/knowledge/libreoffice-draws-sound-icons-powerpoint-hides.md)).
  Pictures carry a whitelist of properties (crop and rotation 0, no recolor, line off, and fill off
  under a PNG), inherited flag by flag from the master shape they name
  ([`officeart-boolean-properties-inherit-flag-by-flag.md`](../../.claude/knowledge/officeart-boolean-properties-inherit-flag-by-flag.md));
  a master is found by its `slideId`, not a persist id
  ([`a-slides-masteridref-is-a-slideid-not-a-persist-id.md`](../../.claude/knowledge/a-slides-masteridref-is-a-slideid-not-a-persist-id.md)).
  **Anything else anywhere refuses the whole deck**, which then goes to the model reader: never
  half a deck each way, never a slide drawn wrong in silence. Measured on the hymnal: 1229 of 1231
  decks read natively, in 0.3 ms each; the two refused are `394.pps` (slide 5 leaves a 13-unit
  strip uncovered) in both folders. A refusal is remembered by `(size, mtime)` (`notNativeStamp`).
- **What is stored**: a `slide_decks` row with `image_format = 'native'`, `render_width = 0`,
  `cache_dir = ''` (it owns no folder — every path that deletes or rebases a deck's folder checks the
  format first), `timings_source = 'binary'` and `converter_version = SLIDES_NATIVE_VERSION`; one
  `deck_slides` row per slide whose `layers` column is the JSON `SlideLayers` (each picture's offset
  and length inside the `Pictures` stream, and its rect in slide units). Identity is the content
  hash, like any deck.
- **What is served**: a slide that is one picture edge to edge in its own proportions is that JPEG,
  byte for byte (~4 of 5 hymnal slides); otherwise an SVG placing each picture where PowerPoint does,
  pictures as `data:` URIs (an SVG used as an image fetches nothing). The source must still be the
  file the layers were read from — same `(size, mtime)` — or the answer is 410. `/thumb` is the base
  picture alone: composing the SVG for every tile of a library grid cost ~800 KB of base64 each.
- **The linked song** is found from the record that names it (`ExObjList` → `CString`,
  `readBinaryExternalPaths`), not by scanning the file: the scan was most of a second per hymn
  ([`linked-audio-hint-scan-was-hidden-behind-libreoffice.md`](../../.claude/knowledge/linked-audio-hint-scan-was-hidden-behind-libreoffice.md)).

## Slide transitions (2026-10-26)

Every deck carries each slide's own way in (`DeckSlide.transition`, a `SlideTransition`): from
`SlideShowSlideInfoAtom` (`effectType`/`effectDirection`/`speed`) in a binary, from `p:transition`
in OOXML. Fade and «fade through black» and random bars are drawn as themselves; any other effect is
a crossfade of its own length; a cut is `null`. Speeds are PowerPoint's: slow 1 s, medium 0.75 s,
fast 0.5 s. Decided by the owner: they play **only when the deck moves forward** (back is a cut),
and entering the deck keeps the scene transition from Settings. A PDF has none. On the projector it
is `ProjectionOutput.enter` (see `04-renderer-state.md`).

## A PDF: drawn page by page, when asked for (2026-11-03)

A `.pdf` is just another deck (`ASSET_EXTENSIONS.ppt`, `kind = "ppt"`, `ProgramItemKind` `"ppt"`) —
not an `AssetKind` of its own. Throughout the renderer `kind === "ppt"` already means "this is a
deck", so the extension is enough to inherit the dialog filter, drag & drop, folder import, the
content-addressed cache, prewarm, "Prepare folder", thumbs and badges without a single new branch.

Opening one (`pdfDeck`) hashes it and asks the hidden pdf.js window for its page sizes — ~25 ms,
measured on real slide PDFs — and records a row with `cache_dir = ''` and one `deck_slides` row per
page with no file. `worship://deck/<id>/<n>[/thumb]` then draws that page when a window asks
(`pdfPageImage` in `rasterizer.ts`): the slide at the deck's width in the `now` lane, a thumbnail at
`SLIDES_THUMB_WIDTH` in the `later` lane, one task at a time in the window, which keeps the last
three documents open. Inside `now` the newest ask goes first (`takeNewestBurst` in
`raster-order.ts`): Electron never tells main that a window gave up on a page, so skipped pages are
drawn after the one on screen, not before it. Encoded pages stay in memory (128 MB, least recently used out, keyed by the
file's stamp, never by deck id), so the projector gets at once what PREVIEW drew, and its
`preload` of the next slides is what draws them ahead. Measured on an M3 (2026-11-03): a page at
1920 px draws in 5–110 ms; encoding it as PNG takes 6–21 ms, as WebP 70–165 ms; a thumbnail 4–23 ms.

A PDF has no presentation metadata: no transitions (⇒ `timings_source = "none"`, no auto-advance)
and no media parts (⇒ no embedded soundtrack). The sibling *linked* `.mp3` is still resolved, as for
any other deck. `worship://raster/<task>` serves the window only a file the library holds, and only
while that task runs.

A page is fitted into a `targetWidth` square, not just by width: a PDF page can be portrait.
`slides.maxRenderWidth` and `slides.imageFormat` (the owner kept the choice, 2026-11-03) are part of
a PDF deck's identity, so changing either opens the PDF again under new urls on its next open
(~25 ms); they touch no other deck.
Diagnosis and measurements — including non-embedded fonts (pdf.js runs with system fonts) and the
`PDF_PASSWORD` error — in
[`.claude/knowledge/a-pdf-source-breaks-two-assumptions-the-pipeline-made-about-its-own-output.md`](../../.claude/knowledge/a-pdf-source-breaks-two-assumptions-the-pipeline-made-about-its-own-output.md).

## Why PDF pages are drawn in a hidden `BrowserWindow`

Drawing needs a real Canvas2D. The alternative (`@napi-rs/canvas` in a `utilityProcess`)
publishes its native binary as a **per-platform** `optionalDependency`: unlike `better-sqlite3`
(8 binaries in one tarball), `npm install` on macOS never downloads the Windows one, so
cross-compiling the Windows installer from a Mac — something this project does — would ship a
broken app. A hidden window is already its own OS process, so crash isolation is the same, without
that risk.

The **legacy** build of pdf.js is used (`pdfjs-dist/legacy/build/pdf.mjs`): the modern bundle uses
built-ins that Electron 36's Chromium didn't have yet and failed with
`n.toHex is not a function` (Electron 44's Chromium 152 does have `Uint8Array.prototype.toHex`;
the legacy build is still the one imported).

**That window is reused across decks and pages** (a single one, closed after 5 minutes idle, which
also drops the documents it keeps open). Consequence for any change in `slides/rasterizer.ts`:
listen on its `webContents` once per window, never per task. A `once("render-process-gone")` per
task is not enough: `once` only removes itself if the event fires, so the old per-deck job piled up
one listener per rasterized deck until Node warned
`MaxListenersExceededWarning: 11 render-process-gone listeners added to [WebContents]`. A crash
fails the page being drawn; a page that hangs for `SLIDES_RASTER_PAGE_TIMEOUT_MS` closes the window;
the next task starts a fresh one either way.

## Identity by content hash

`slide_decks` is identified by `(content_hash, render_width, image_format)`, **not** by
`media_asset_id`. Two library entries pointing to copies of the same file share one deck, and
moving the file is a cache hit instead of a new read. There is an earlier fast path by
`(size, mtime)` that doesn't even hash. A native or model deck has `render_width = 0`.

The hash does read the whole file, but through `fs/promises` and 1 MB at a time: the reads go to
the thread pool and `hash.update` is bounded by the chunk, not by the deck's size. Synchronously, a
60 MB `.pps` froze the thread that serves the projector for the whole read.

### The flip side: the row has a single owner

`media_asset_id` does exist on the row, and `relinkDeck` **moves** it when another asset resolves to
the same content. In other words: the deck is shared, but *ownership* is exclusive. Everything
that asks "is this asset ready?" by looking at `media_asset_id` —as `statusesByAsset` did, and
with it the "Prepare folder" count, the tile badges and `adoptProgram`'s eviction pins— is asking an
ownership question about a content cache, and gets it wrong as soon as there are two identical
files: one shows as ready and the other doesn't, forever.

**It was a real defect, not a theoretical subtlety:** `N3` in
the internal audit `2026-09-11-cadena-de-media`
§5.2, measured at 555 false pendings over 1235 assets with 0 real work. Fixed on 2026-09-13:
`statusesByAsset` now JOINs by the asset's `content_hash` and falls back to ownership only for an
asset not stamped yet (see `05-data-and-persistence.md`). Don't count rows per asset to find out
what's left to prepare.

## Timing alignment — the detail that matters

A deck's timings are read per slide in presentation order, hidden slides included; the slides drawn
leave hidden ones out. So timings are aligned against the **visible** slides (`!hidden`), not
against the full list: getting this wrong shifts every timing one position per hidden slide. If the
counts still don't match, **all** timings are discarded (`timings_source = 'none'`) — a silently
misaligned auto-advance is worse than no auto-advance.

## OOXML parsing

Parts are read with `readZipEntries` (`src/main/slides/zip-reader.ts`), **never** by loading the
whole file. A `.pptx` is a zip and a zip is random-access: it locates the end-of-central-directory
(with zip64), parses the central directory and reads only the requested byte ranges — a few KB, no
matter how many MB of media surround them. `unzipSync` with `filter` does **not** work for this: it
takes a buffer, so it avoids the inflate but not the `readFileSync`.

Two non-obvious details, measured in
[`.claude/knowledge/a-pptx-is-random-access-and-inflatesync-needs-its-out-buffer.md`](../../.claude/knowledge/a-pptx-is-random-access-and-inflatesync-needs-its-out-buffer.md):
the reader is **synchronous on purpose** (KB-sized reads, so nothing in the caller chain — up to
`MediaRepo.ensureLinkedAudio` and `toDeckDTO` — had to become `async`), and `inflateSync` must be
given the `out` buffer with the size the central directory already provides: without it, growing
its own output buffer costs ~16 µs per entry and makes the "fast" version 3× slower than reading
the whole file.

- `ppt/presentation.xml` → `<p:sldIdLst>` gives the **real order**. `slide1.xml, slide2.xml…` is
  creation order and diverges as soon as someone reorders.
- The `<p:transition>` is almost never at the slide root in modern decks: it lives in
  `mc:AlternateContent/mc:Choice[@Requires="p14"]`, with a copy in `mc:Fallback`. All three forms
  are checked. Looking only at the bare one is the most common way to read zero timings without
  noticing.
- `@advTm` (auto-advance ms), `@advClick`, `p:sld/@show="0"` (hidden).
- Audio: `p:pic` with `a:audioFile` + the slide's `_rels`; `p:cMediaNode` gives loop/volume and,
  by `numSld`, the slides it plays on (see *Model decks*).
- Video: `p:pic` with `a:videoFile` (or the `p14:media` in `p:extLst`), with the same resolution
  through `_rels`. Three differences from audio, and all three matter:
  1. **Geometry is mandatory.** The rect comes from `p:spPr/a:xfrm` (EMU) against `p:sldSz` and is
     stored as 0..1 fractions. A `p:pic` **without** its own `a:xfrm` inherits the layout
     placeholder's, which this parser doesn't resolve: it is dropped and noted in
     `skippedVideoParts`. A default would be a clip stuck in the wrong place mid-service, and the
     slide already draws the poster frame in its place.
  2. **`p:cMediaNode` is looked up by `spid`**, not in aggregate. A slide with narration *and* a
     clip has two nodes, and giving the video the narration's volume is a muted clip with no
     explanation. It falls back to the whole-slide aggregate only when no node declares a
     `p:tgtEl`.
  3. **A `TargetMode="External"` rel is not a part.** `parseRels` drops it: joining a
     `C:\clips\intro.mp4` to `ppt/slides/` produces a plausible part name that names nothing.
- A legacy `.ppt`/`.pps` almost never embedded a video (PowerPoint 97-2003 linked it by absolute
  path), so embedded video playback is OOXML-only.

### From OOXML to the slide: the index changes space

OOXML indices count **hidden** slides; `deck_slides.slide_index` counts the slides drawn, which
don't include them. The video is stored already translated into that space (a map built with the
same visible list that aligns the timings), and if the counts don't match **all** of the deck's
videos are dropped instead of approximated — a shifted timing advances a slide early, a shifted
video plays a clip over the wrong slide.

## A legacy binary's timings come from its own records

`ppt-binary.ts` reads `SlideShowSlideInfoAtom` from the OLE2's `PowerPoint Document` stream, in
presentation order (`Current User` → `UserEditAtom` → persist directory → instance-0
`SlideListWithText` → `SlidePersistAtom`) — `readBinaryDeck` for a native deck, and
`readBinarySlideTimings` for whatever else needs them (the binary model reader's
`PresentationMeta`). It never reads the whole file: images live in the `Pictures` stream, so it's
~45 KB of a 1.4 MB file, read sector by sector on demand. The format's traps (the `fFlags` bits
aren't consecutive; `PP97_DUALSTORAGE`) are in
[`.claude/knowledge/libreoffice-pptx-export-drops-advtm-without-a-transition-effect.md`](../../.claude/knowledge/libreoffice-pptx-export-drops-advtm-without-a-transition-effect.md),
which also records why these timings were never taken from a converted copy: a `.pps → .pptx`
round-trip through LibreOffice silently lost the auto-advance of 222 of 1226 hymnal decks.

## What older builds left behind

Until 2026-11-03 a deck no reader could open was converted by LibreOffice (→ PDF → WebP), and a
PDF was rasterized whole to WebP/PNG. At startup `sweepCache` deletes every such deck — a raster row
(`webp`/`png`) with a folder, with that `slides-cache` folder (`SlidesRepo.deleteRasterizedDecks`;
a PDF deck of this build has `cache_dir = ''`) — and LibreOffice's own `userData/soffice-profile`,
and the unknown-folder sweep takes the old `slides-cache/.tmp`; those decks are read from their
source on their next open. The settings rows those builds wrote (`slides.sofficePath`,
`slides.warnMissingSoffice`, `slides.preemptBackground`…) stay in the table and are ignored:
`SettingsRepo` only reads keys `DEFAULT_SETTINGS` still has.

## Progress: state transitions only

`deck-progress` carries a deck's state transitions (ready, failed, stale) and nothing per page: no
deck is drawn page by page ahead of time any more. A «Prepare folder» batch reports its aggregate
over `prewarm-progress`. When PDFs were rasterized, emitting per-page progress for background work
turned a 600-deck folder into ~18,000 IPC messages, each one cloning in the renderer a `Record`
that grows with every deck — see
[`.claude/knowledge/an-aggregate-progress-channel-only-helps-if-the-per-item-one-goes-quiet.md`](../../.claude/knowledge/an-aggregate-progress-channel-only-helps-if-the-per-item-one-goes-quiet.md).

## The overlay dance is over

Since a slide is now an image or a model drawn in the page, the projection window **never hides**.
BLACK and LOGO are normal `selectOutput` results, and the `projection:setOverlayVisible` channel is
gone. Since 2026-09-09 the deck's audio pauses under BLACK/LOGO (and auto-advance freezes), resuming
where it was — see
[`.claude/knowledge/deck-soundtrack-negro-logo-pause-and-autoplay-freeze.md`](../../.claude/knowledge/deck-soundtrack-negro-logo-pause-and-autoplay-freeze.md).

## Serving

`worship://deck/<deckId>/<n>[/thumb]` resolves against `deck_slides` and is served with
`Cache-Control: public, max-age=31536000, immutable` — the `(deckId, slideIndex)` pair is immutable
by construction (different content ⇒ different hash ⇒ different deckId). Without that header
Chromium would re-read every image on every slide change, live. The audio
(`worship://deck-audio/<id>`) goes without that header because it's traversed with seeks, not
replaced.

Everything `worship://` serves goes through `serveFile()`, which implements **real `Range`
semantics** (206 + `Content-Range`, `Accept-Ranges: bytes`, 416, streaming with
`fs.createReadStream({start,end})`). It used to delegate to `net.fetch(file://…)` without
forwarding the headers, which left all video/audio **without seek** and broke playback with
`PIPELINE_ERROR_DECODE (-12909)` from misaligned data — see
[`.claude/knowledge/worship-protocol-range-and-video-lifecycle.md`](../../.claude/knowledge/worship-protocol-range-and-video-lifecycle.md).

## Verification

The readers are pure and tested without Electron (`tests/main/`: `pptx-reader`, `ppt-binary`,
`container-kind`, `pptx-transition`, `pptx-audio`, `pptx-video`…). The E2E suite builds every deck
it projects in code — `.pptx` part by part (`tests/e2e/support/pptx.ts`, with timings, a WMA
soundtrack and a WMV on a slide), PDFs (`support/pdf.ts`), legacy binaries
(`tests/fixtures/legacy-ppt.ts`) and an `.odp` — so it needs nothing installed. Drawing a PDF's
pages and a model need Chromium, so they are only checked inside the app.
