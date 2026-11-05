# 07 — Roadmap and known debt

## State of this migration

Completed: `electron-vite` scaffolding + strict TS, the design system (`components/ui`+
`shared`), the complete data layer (SQLite + Drizzle + FTS5, with a verified smoke test), the
end-to-end typed IPC contract, the `worship://` protocol, the slide pipeline — every deck read
by the app itself, a PDF's pages drawn on request (cross-platform, see `03-slides.md`) —, the
declarative projection window, and a working control UI for the 6 audited areas
(playlist, library, bible, PPT, black/logo, display) plus the new
saved-services module.

~~**Not implemented:** songs/lyrics with projectable sections.~~ **Implemented (2.3.0,
2026-11-04):** the song library, one size per song, live jumps, named themes and the
EasyWorship 6 import — see «Songs» in `04-renderer-state.md` and `05-data-and-persistence.md`.
Two languages at once and a video behind the lyrics came on 2026-11-05 (see «Songs» in
`04-renderer-state.md`). Left for later, by the owner's plan: other importers
(OpenLP, OpenLyrics, ProPresenter, FreeShow, SongSelect, ChordPro), the CCLI usage report, chords,
configurable keys, and checking the importer against a real EasyWorship 7 database.

## Debt consciously left for a later session

- ~~**Real drag & drop of OS files**~~ into the playlist/library: **implemented** — files dropped
  from the OS onto the schedule or the media browser go through `readOsFilesDrag` (`lib/dnd.ts`,
  `webUtils.getPathForFile` in the preload), and the internal library→schedule drag has its
  `onDrop` (`SchedulePanel.tsx`).

- **A `.pptx` drawn from its model (2026-10-26) — what was knowingly left.** The switch is total
  and what the model can't draw exactly is approximated (see «Model decks» in
  `03-slides.md`); what is still approximate or missing, measured against PowerPoint:
  text autofit (a `normAutofit` box can overflow), a SmartArt with no saved drawing, 3D text and
  shapes, artistic effects, connector arrowheads, WordArt warps, chart numbers not localised to the
  system's region, Office faces with no metric twin on macOS/Linux, a few Office fonts Chromium
  rejects (empty `prep` table), TIFF/WDP pictures (counted, not drawn) and text inside a metafile,
  which can only use system fonts
  ([`.claude/knowledge/an-svg-drawn-as-an-image-never-sees-the-pages-fonts.md`](../../.claude/knowledge/an-svg-drawn-as-an-image-never-sees-the-pages-fonts.md)).
  Sound and video embedded in a `.pptx` are still extracted to the deck's folder, as for a
  converted deck, until they can be served from the `.pptx` by range. And the slide grids mount a
  whole `SlideView` per visible tile: fine on the decks tested, not measured on a very long deck
  full of large pictures.
- ~~**Bible favorites and history UI**~~: **implemented on 2026-11-05** as the Bible tab's ⭐ list
  (favorites + recent passages, see «Favorites and recent passages» in `05-data-and-persistence.md`).
  `projection_history` (every `projection:show`, all kinds) still has no screen.
- ~~**Video embedded inside a slide**~~: **implemented on 2026-09-20** as a positioned overlay.
  One hard limit remains that isn't debt but format: legacy `.ppt`/`.pps` files lose the video
  entirely, so the feature is only for `.pptx`/`.ppsx` — measured in
  [`.claude/knowledge/an-embedded-deck-video-survives-to-the-pdf-but-never-survives-a-ppt.md`](../../.claude/knowledge/an-embedded-deck-video-survives-to-the-pdf-but-never-survives-a-ppt.md).
  What does remain open: a video whose `p:pic` doesn't carry its own `a:xfrm` (it inherits the
  geometry of a layout placeholder, which the parser doesn't resolve) is discarded instead of
  guessed; the slide still looks right: the poster frame is already rasterized in its place. A
  `.wmv`/`.avi` is extracted marked `playable: false`; since 2026-10-30 `media/deck-clips.ts` hands
  it to the media engine the first time the deck is opened each launch (a build with no engine still
  converts it in place with the bundled FFmpeg, as it did since 2026-10-18).
- ~~**Configurable projection settings** for bible/text~~: **implemented on 2026-09-20**.
  The verse's style lives in the `bible.style` key of `SettingsMap` —a global style, not a row
  per preset— with `BibleStyle` (`shared/types/bible-style.ts`), its validators/normalizers and
  the first entry of `SETTINGS_NORMALIZERS`. It's edited in Settings ▸ Verses, with the
  preview drawn by the same `OutputView` as the projector, and it's saved instantly: `App`
  mirrors it to `projection.store`, which recomputes `selectOutput` **without** touching
  `sceneEpoch`, so editing what's LIVE is an in-place patch and not a transition.
- **Settings screen**: six categories (Projection, Slides, Verses, Bible, System, About) with theme,
  language, `media.volume`, the per-type folders (`files.defaultFolders`) and the `slides.*` keys
  already exposed.

## In-app updates — left out on purpose

How they work is in `01-architecture.md`. This was left out when they were built (2026-10-25),
each item with its reason:

- **Cancelling a download in progress.** Closing the app stops it. Add it if it gets in the way in
  practice.
- **Automatic updates on macOS, and its differential download.** Both need a Developer ID (see
  `01-architecture.md`). Until then the operator drags the `.dmg`.
- **Staged rollouts** (`stagingPercentage`). The emergency brake for a broken release is to mark
  the previous one as Latest again: installs that haven't updated yet stop being offered it, and
  the ones that did wait for the fixed version (`allowDowngrade` stays `false`).
- **Our own signature on `latest*.yml`** (ed25519, minisign). The real threat is a compromised
  GitHub account. 2FA and immutable releases narrow it, and paid code signing (Authenticode,
  Developer ID) closes it, so it goes with that paid decision.
- **A system notification.** The notice is a toast in the control window, and never anything on
  the projector. With the app minimized it waits there: it carries an action, so it doesn't leave
  on its own.

## Pre-launch review of 2026-10-18 — what was left open on purpose

The full review on that date (main, slides, renderer, UI and Windows) closed all of its critical,
high and medium findings. This was left open, each item with its reason:

- **A linked music track in WMA/AIFF is rejected** (`LINKABLE_AUDIO_EXTENSIONS` in
  `ipc/handlers/library.ts`). `worship://linked-audio/<id>` serves the file as-is, and the 1229
  linked audio files of the real hymnal are MP3. If it were ever needed, it gets an engine url
  (`engine-assets.ts`).
- **The clickable `ListRow` rows can't be reached with the keyboard** (Scenes, Plates, Timers,
  Overlays). Making them focusable clashes with Enter = GO LIVE: it's an interaction decision,
  not a fix.
- **Style violations in `pages/`** (the UI review's table): the hand-written buttons of
  `media-source-bar.tsx` and of the theme selector (the rebrand to Lumina Live only changed their
  shape and focus; they're still hand-written), about 25 hand-written typography classes in
  `pages/`, and two copies of the `FieldGroup` box. They're cosmetic and each one needs a visual pass.
- **The units `s`, `px` and `%` are still written in the code.** They're typography, not words;
  the neutral color names did go through i18n.
- **The Windows package carries the better-sqlite3 prebuilds for other platforms** and their
  SQLite sources (~24 MB). Excluding them per platform is possible, but it would touch the native
  module's loading right before launch.
- **Re-seeding RV1909 with a different JSON would erase the version from the saved verses**
  (`seed-bible.ts`). It doesn't happen: the file hasn't changed since the first commit.
- **No code signing** (SmartScreen warns «Windows protected your PC») — `I1`, it costs money.
- **To check by hand on the church's PC**: Win+P on «Extend»; different scaling per monitor;
  turning the projector off and on mid-service (the window hides, the sound keeps going, and it
  comes back to full screen on its own); turning on the projector with the app already open;
  power plan; «Test video» with iPhone HEVC; audio
  output over HDMI; and the E2E suite against the installed `.exe` (`WORSHIP_E2E_EXECUTABLE`),
  with `WORSHIP_E2E_HYMNAL` pointing to that PC's hymnal folder so that `hymnal.spec.ts` runs too.
  And, since the rebrand to **Lumina Live** (2026-10-22), that the new installer REPLACES the
  WorshipApp one: a single shortcut, a single entry in «Installed apps», and that PC's schedules,
  library and Bibles present on the first start (`userData` stays in `%APPDATA%\worship-app`,
  same `appId`).
- **Scenes and plates saved before the rebrand keep the ALPS colors** (`#04132b`, `#84adfc`, the
  countdown in `#cd4900`/`#d0021b`): the Lumina Live defaults only dress what's created from
  2026-10-22 on, and the four example scenes are seeded only once. It's on purpose —they're the
  operator's content—; moving them to the new palette means editing them by hand.
- **Four E2E tests failed once in a full run on 2026-10-22 and passed on their own when
  repeated**: `bible.spec` «after clicking EN VIVO…» and «a file that is not a Bible…» (the
  Settings tab was unmounting under the click), `keyboard.spec` «↓ after clicking a library
  tile…» and `logo.spec` «L covers what is live…». In the next full run (that same day, with
  everything already committed) all four passed; nobody looked into whether any of them is a
  product bug.
- **The GO LIVE that opens the projector waits for its window to load** (since the slide 1 fix,
  2026-10-22): 0.2 s normally, up to 3 s with the machine busy. A key pressed in that interval
  doesn't move anything, because nothing is live yet. Before, it advanced a deck the projector
  hadn't shown yet. If it's a nuisance during a service, it can be queued.
- **What the E2E suite can't exercise**: dropping files from Finder/Explorer (`getPathForFile`
  requires a native `File`), two real screens, and the native dialogs — those are answered by
  replacing `dialog.showOpenDialog` in main (`answerOpenDialog`), so the button and everything
  after it are the real ones.
- ~~**31 of the 35 `Select`s have no accessible name.**~~ **Fixed on 2026-11-05:** a `FieldRow` hands
  its label's id down (`FieldLabelContext`) and a `Select` inside is `aria-labelledby` it unless the
  caller passes an `aria-label`, which the four standalone ones (the Bible tab's three pickers and
  the programs filter) now do. Every combobox of every screen was checked at run time.

## Cross-platform — solved

Nothing is Windows-only anymore. COM/PowerShell was removed completely, and since 2026-11-03 so
was LibreOffice: every presentation is read by the app itself, the same on macOS, Windows and
Linux, with nothing to install — see `03-slides.md`.

**Linux was packaged and tested for the first time on 2026-10-22**, in Docker (emulated Ubuntu
24.04 x86_64): it started, converted with the system's LibreOffice (as builds did then) and passed
`startup.spec` and `decks.spec`; the rest of the suite wasn't run there.

**Linux ships as a `.deb` and as an AppImage** (owner's decision, 2026-10-23). The `.deb` is the
one for Ubuntu, Debian and Mint: its postinst leaves `chrome-sandbox` setuid root if user
namespaces are missing and installs an AppArmor profile with `userns` on Ubuntu 24.04+, so it
opens with a double click and with the sandbox on. The AppImage can't do any of that: on Ubuntu
23.10+ it needs `--no-sandbox` (the README says so) and it's left for the other distributions.
`package:linux` installs to `/opt/lumina-live` (`-c.productName=lumina-live`): with the space in
«Lumina Live» the setuid sandbox wouldn't start, and the E2E suite doesn't see it because
Playwright adds `--no-sandbox` on Linux — see
`.claude/knowledge/a-space-in-the-linux-install-path-breaks-the-suid-sandbox-and-playwright-never-tests-it.md`.
Not yet tested on a real desktop Ubuntu (Docker has no AppArmor).

**The media engine on Linux uses the system's libmpv** (2026-11-03, `engine-2`): it is built on
Ubuntu 22.04, whose glibc 2.35 is the oldest it runs on (built on Debian 12 it needed 2.36, for
the `arc4random` of the static libstdc++), and it loads `libmpv.so.2` or `libmpv.so.1` at run time
(`native/engine/mpv-linux.cpp`) instead of linking one soname. The `.deb` depends on
`libmpv2 | libmpv1` and on `libopengl0`, which libmpv does not pull in and the engine links.
Installed with `apt` in clean Ubuntu 22.04, Debian 12 and Ubuntu 24.04 containers, it loads mpv
0.34, 0.35 and 0.37; playing needs a GPU, so that part is only tested on a real PC.

**Linux is no longer experimental from 2.2.0** (owner's decision, 2026-10-25). It was in
2.2.0-beta.4 and beta.5 because, on native x86_64 under Xvfb (a container, no GPU), the projector
and control renderers crashed with a deck on air: `render-process-gone` with `reason: crashed`,
`exitCode: 133` (SIGTRAP, a Chromium `CHECK` with no message in the official builds), with and
without `--disable-gpu` or the sandbox. On a real desktop Linux with a GPU (a CachyOS laptop, Iris
Xe, GNOME) the whole E2E suite against the package passed on 2026-11-03 — 143 tests, none failed —
and that crash never appeared. Its cause under Xvfb is still unknown; if a user reports windows
closing by themselves on Linux, start from there (a minidump with Electron's symbols).

Verified on macOS against real church decks, including a 52-slide binary `.ppt` and a fixture
with auto-advance + embedded audio. `legacy/` was removed from the repo on 2026-10-22; it's still
in the git history.

## Languages

Since 2026-10-22 the app speaks `es`, `en`, `it` and `pt` (Brazilian Portuguese). Adding another
one takes: the code in `LOCALES` (`shared/types/settings.ts`), a file in `lib/i18n/messages/` and
another in `main/i18n/messages/` (both typed against their `es`), its Bible book names in
`main/db/seed/bible-formats/book-names.ts` and its endonym in `settings.locales`. No components
touched: the dictionary maps are typed over `Locale`, so forgetting one doesn't compile.

The screenshots (`npm run screenshots`) are taken once per language since 2026-11-05
(`docs/screenshots/<locale>/`): the interface and the content, each language's public-domain hymns and
Bible (`tests/e2e/screenshots.content.ts`, every text copied from a named source). The specs drive the
app through `translate()` (`tests/e2e/support/locale.ts`), which finds a Spanish label's wording in
the other language through the app's own dictionaries, so the suite stays written in Spanish.
