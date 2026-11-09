# 04 — Renderer state

The global `state` object (20 fields) and the `els` map of ~45 hardcoded IDs are gone. In
their place, **Zustand** in per-domain slices (`src/renderer/src/stores/`):

| Store | What it holds |
|---|---|
| `program.store.ts` | current program (`items`, name, notes, date), `selectedIndex` (highlight), `activeIndex` (live), `dirty` |
| `preview.store.ts` | **what is being looked at** (`target`: program item \| verse \| library asset) + `slideIndex`, the preview cursor, independent of the projection one |
| `projection.store.ts` | `base` (what was chosen to project) + `overlay` ('none'\|'black'\|'logo') + `logoUrl` + `logoScene` (LOGO's two modes, `logo.mode` «image» \| «name» — unset: the image when there is one —, resolved by `logoLook` in `shared/types/settings.ts` for `App.tsx` and the Settings preview alike: the image's url, or `logo.name` over `logo.background` carried dressed in the `logo` output and drawn by `LogoScene`) + `presentationOpen` |
| `bible.store.ts` | active version/book/chapter, loaded verses, current verse index |
| `library.store.ts` | media library by type, active tab, selection |
| `settings.store.ts` | in-memory mirror of the `settings` table, applies `data-theme` to `<html>` |
| `display.store.ts` | available screens, which one is chosen (persisted in `settings['projection.displayId']`), `open()/close()` of the projection window |

Each store touches only what belongs to it — the PPT polling (previously every 800ms over the
whole global `state`) no longer re-renders components that don't read that slice.

## `selectOutput` replaces `restorePrevious()`

The legacy arbiter (`app.js:408-418`, hardcoded priority PPT > video > image > bible > logo)
is gone. `projection.store.ts` exposes:

```ts
function selectOutput(state): ProjectionOutput {
  if (state.overlay === "black") return { kind: "black" };
  if (state.overlay === "logo") return { kind: "logo", url: ... };
  if (state.base === null) return { kind: "logo", url: ... };
  switch (state.base.kind) { /* exhaustive — TS forces you to handle every variant */ }
}
```

Leaving BLACK/LOGO is `setOverlay('none')` — there is nothing to "restore", because `base` already
*is* the last thing chosen. Adding a new content type to `BaseContent`
(`shared/types/projection.ts`) without handling it in the `switch` is a **compile error**, not a
"it got stuck showing the logo" bug discovered in production.

### A slide's own way in rides in the output, with its own identity

`setSlideIndex` records the transition of the slide it moves to (`slideEntry`) only when the index
grows; any move back, and any new scene (`setBase`, `setLiveDeck`), records `null`. `selectOutput`
hands it to the projector as the `slide` variant's `enter`, with `seq` = `slideVideoEpoch` — the
counter that already advances with every change of slide and nothing else. `OutputView` animates
when `enter.seq` is one it has not seen and the epoch did not change (a new scene plays the scene
fade instead): a push that re-sends the same slide (a plate, a volume, BLACK coming off) carries
the same `seq` and plays nothing, and a projector rebuilt from main's snapshot mounts with no
previous slide to fade from. Random bars are drawn as one strip per bar, each the size of its bar
with `overflow: hidden` (`RandomBars` in `output-view.tsx`), never full-stage copies clipped by
`clip-path` — sixty of those at 4K would be two gigabytes of GPU memory.

### `selectOutput` loses information, and that defines what main can decide

Look at the first three lines above: with a deck as `base`, BLACK returns `{kind:"black"}` and
LOGO returns `{kind:"logo"}` — the `deckAssetId` doesn't travel. And `base === null` **also**
returns `{kind:"logo"}`. In other words: "there is a deck live, covered" and "there is nothing
live" reach main as the same value.

`ProjectionOutput` is all main has (`services/projection-state.ts`), so main **cannot** answer
"what is live". The only exception is `videoUnderlay`, and it survives the overlay because the
projector itself needs it so as not to unmount the `<video>`, not because main asked for it.

Two rules follow from that:

- A main decision about live content is only correct if the data travels inside the output
  for a reason the projection window needs. Otherwise, the decision belongs to the control
  (`lib/actions/*`), which reads `base` and `overlay` directly — that is the case of the guard
  that refuses to reconvert the deck that is on the projector (`lib/actions/deck.ts`).
- What main *can* do is **not let go** of what it already knew: `projection:show` keeps the
  deck's eviction pin across BLACK/LOGO and releases it only on an output that actually replaces
  the content.

Full diagnosis in
[`.claude/knowledge/main-cannot-know-what-is-live-under-an-overlay.md`](../../.claude/knowledge/main-cannot-know-what-is-live-under-an-overlay.md).

## The effects layer

`src/renderer/src/effects/projection-sync.ts` connects the store to main: it subscribes to
`selectOutputMemo` and sends each output over `projection:show`, and wires up the incoming events
(`media-status`, `media-error`, `deck-progress`). The PowerPoint overlay dance that used to live
here **no longer exists** — slides are images, the projection window is never hidden.

`selectOutput` returns a new object on every call and `preload` makes it nested, so
`selectOutputMemo` memoizes identity in **a single place**; without it, each consumer needed
its own patch for the same problem (an `equalityFn` with `JSON.stringify` here, a `useShallow`
in `LiveMonitorPanel` there).

The memoization compares **by reference the 8 fields `selectOutput` reads**, not the serialized
result. It is the difference between O(1) and building-plus-serializing the whole output on every
store notification — and by far the most frequent notifier is `setMediaStatus` (~4 Hz per
playing element), which affects none of those 8 fields. Since all of them are replaced
immutably, comparing references is correct; and as a bonus, two states that differ only in
`mediaStatus` yield the same tuple, so two subscribers cannot fight over the single slot (the
pattern React documents as a cause of loops with `useSyncExternalStore`).

### Projector errors

`mediaErrors` (in `projection.store.ts`, keyed by `mediaErrorKey`: `"scene"`, `"video"`,
`"audio:<id>"`) holds what the projection window reported it couldn't load or decode.
Two rules keep it honest without any timer or explicit cleanup:

- **An entry is only shown while its `url` is still what is live.** Moving to the next slide
  or sending something else to air makes it invisible on its own.
- **`beginScene()` clears the `scene` and `video` entries.** That is what makes re-sending the
  *same* file a real retry, instead of dragging along the warning about a file the operator
  already replaced. Audio entries are not cleared: they belong to the lifecycle of the track
  list and are removed by `pruneMediaStatus`, in the same pass as the dead `mediaStatus` entries.

`src/renderer/src/effects/deck-autoplay.ts` is the only thing with time-based logic. Two modes:

- **synced**: while there is a soundtrack and nobody has touched anything, the slide index is a
  function of the `<audio>`'s time. Each `media-status` re-derives which slide applies and
  re-arms a single `setTimeout` — the timer is a latency optimization, not the clock, so a
  ten-minute track cannot accumulate drift.
- **detached**: as soon as the operator navigates by hand, the music **keeps going where it was**
  (product decision) and auto-advance continues with a monotonic chain of deadlines from the
  chosen slide. An incrementing `navEpoch` discards any in-flight `media-status` so that a late
  response cannot overwrite the slide that was just chosen.

`src/renderer/src/effects/deck-sounds.ts` plays the live deck's other sounds (`LiveDeck.sounds`:
everything in the file but its soundtrack) on their own slides, as tracks of their own
(`deck-sound:<deck_audio.id>`, `source: "deck"`, so BLACK/LOGO pauses them with the soundtrack).
The rule is the pure `deckSoundChanges` (owner, 2026-10-27): a sound starts from the top when the
live slide is one of its slides — reached in order, by a jump, or by GO LIVE — stops once the slide
is past its last, and keeps playing when the operator goes back before its first. A new scene (a
GO LIVE, even of the same deck) and the transport's restart start them all over. It reads the
sounds from the deck store, not from `liveDeck`: `liveDeck` is the deck as it went live, and a WMA
the media engine takes afterwards only reaches the deck store (`deck-updated`).

`src/renderer/src/effects/stage-sync.ts` builds the musicians' screen (`stageOutputFor`,
`lib/stage-output.ts`) while one is chosen: the live content with nothing covering it, the slide or
verse → would bring (`stepSong` for a song, the Bible tab's cursor for a verse — a program's verse
hands its chapter to the tab as it goes live, `handLiveItemToTab`), and BLACK, LOGO or hidden lyrics named as a `notice` rather than shown (owner,
2026-11-05: the band still needs the words). It rebuilds only when an input changes by reference,
like `selectOutputMemo`.

`src/renderer/src/effects/end-of-playback.ts` takes off the air, on its own, a video or an
auto-advancing deck that finished playing by itself, leaving the logo scene
(`clearBaseContent()`) — the congregation is never left staring at the last frame or the last
slide because the operator forgot to clear. A deck counts as finished when it has reached
`autoplay: "finished"` **and**, if it has a soundtrack, that track has also reported `ended` —
whichever ends last wins; music longer than the sum of the timings is not cut off midway.
No manual deck (without `advanceAfterMs`) ever ends by itself.

A deck's end is the operator's choice since 2026-11-09 (`projection.deckEnd`, Settings ▸ Projection, the
same five values as a video's, read straight from `settings.store`): `endLiveContent()` (`lib/actions/playback.ts`)
runs both when an auto-advancing deck finishes and when the operator steps past its last slide
(`advanceSlide`, never on a held key's repeat, so «Siguiente» stays enabled on the last slide unless the
choice is «hold»). «logo»/«black» clear as a video does, «loop» is `restartDeck()`, «hold» does nothing and
«next» is `goLiveWithNextScheduleItem` — except under BLACK/LOGO, where it only clears: going live would lift
the cover nobody asked to lift. A song has its own copy of the choice (`projection.songEnd`, same values,
same `endLiveContent()`): a song never advances by itself, so only `advanceSong` stepping past the end of its
order ends it (a detour off the last slide returns to it first), and «loop» is its first slide.

A standalone audio's end has its own setting (`projection.audioEnd`, 2026-11-09: «stop» · «loop» · «next»,
`AUDIO_END_ACTIONS` — it is sound, so no logo/black/hold). «stop» is the old rule (`projection-sync.ts`'s
`ended` handler removes the track). «loop» is folded into `AudioTrackPush.loop` when the tracks are pushed
(`toAudioTrackPush`, re-pushed on a change of the setting), so the `<audio>` and the engine session start over
by themselves, also the one already sounding. «next» (`goLiveWithNextScheduleAudio`) plays the schedule row right
after the ended track's `fromItemId` (the row it was sent from: an id, since every schedule edit copies the rows,
and found by its audio after a save renumbers them), plates skipped, only when that row
is an audio too and at the ended track's volume (owner): the offertory's music further down never starts on its own.
A deck's own soundtrack and sounds are never touched by it.

A video's end is the operator's choice since 2026-11-05 (`projection.videoEnd`, Settings ▸ Projection,
mirrored into `projection.store` by `App.tsx` like the transition): «logo» clears as above, «black» clears
under BLACK (`clearBaseContentUnder`), «hold» only marks it paused (`setVideoPaused`) — the element, or
mpv's `keep-open`, holds the last frame, the LIVE row offers «Reproducir», and lifting BLACK/LOGO does not
replay it (`LiveVideo` never calls `play()` on an ended element it uncovers) — and «loop» never ends at all:
`VideoUnderlay.loop` travels in the output, so the `<video>` and the engine session (`setLoop`) start over
by themselves, seamlessly, and a rebuilt projector loops too. «next» (`goLiveWithNextScheduleItem`) sends the schedule's next row that changes the picture — a plate
or an audio is skipped — from the row on the rail; a video that was not a schedule row, the last one, or a
next row that cannot go live (a deck that won't open) falls back to «logo». A deck still clears.

The point to respect when touching this file: `MediaStatus.ended` is *sticky* on the DOM
element and is re-emitted on mount (`use-media-status-reporter.ts` calls `report()` without
waiting for an event), and the deck's track always reuses the same key
(`audio:deck-soundtrack`, `audio.store.ts`). Without comparing `status.epoch` against the
current epoch (`base.epoch` for the video, `soundtrackEpoch` for the deck), an `ended: true` from
a previous video or deck could clear the one playing now. Any new consumer of `mediaStatus`
that looks at `ended` has to do the same comparison.

## Cross-window synchronization

The control is the single source of truth; the projection window has no state of its own (see
`01-architecture.md` on the replay on `did-finish-load`). There is no Context or React state
shared between windows — they are two separate renderer processes, and the only channel is IPC.

The NDI® output (`01-architecture.md`) is a second, offscreen `ProjectionApp`: `projection.html?role=ndi` draws the
same output, and `IS_NDI_OUTPUT` keeps it from reporting `media-status`/`media-error` (the panel would see every
video twice) and from mounting audio tracks (main mutes it too). The projector stays the only window that reports.

## The actions layer

`lib/actions/` is where everything that crosses stores lives, and it is split along
EasyWorship's two-stage flow:

- `preview.ts` — selection and preview cursor. **It never touches `projection.store`.** A click
  in the program, on a verse or on an asset always ends up here.
- `playback.ts` — `goLive()` is the **only** path from preview to projector, shared by the
  GO LIVE button, Enter, and double-clicking a row, a tile or a verse, so the four cannot
  diverge. Also `clearLive()` (CLEAR), `advanceSlide`/`gotoSlide` and `toggleOverlay`. It orders
  things so that a deck is **ready before** `base` changes: hitting GO LIVE on a deck not read yet
  leaves the projector as it is instead of cutting to black while it is read; one that won't open
  changes nothing there and says why in a toast (`explainDeckFailure`).
- `bible.ts` — `projectVerse`/`advanceVerse` (live), `previewSearchHit` and
  `addVerseToSchedule`.

## Songs

A song goes live RESOLVED in `base` (`{ kind: "song", song: ResolvedSong, slideIndex, detour,
lyricsHidden, enterSeq, theme, sizeCqw }`): its order expanded into slides and split to the theme's
lines per slide (`resolveSong`, `stores/song.store.ts`), its theme, and its **one size**.

- **What is projected is never nothing** (owner, 2026-11-06, `songDeckSlides`): an empty order, or one
  that names only sections that are gone, sings the sections as written — the editor's callouts say so
  from the same slides (what `preview.slides` projects, never the chips alone). A block pasted with no
  blank line is stored whole and drawn in pieces (`splitSection`/`linesPerSlide`): the theme's «lines
  per slide», or 4 by 4 past 40 lines when the theme sets none; the editor's caret ↔ slide link cuts it
  the same way. A slide of chords alone (an instrumental intro) is a slide: the projector draws the
  theme's background with no words, the stage its chords — found by position (`slideAt`), not by words.

- **The size is measured once, in the control window, and travels in the output.** `lib/song-fit.tsx`
  draws every distinct slide of its sections — not only the order's: a detour is drawn at the same
  size — off screen through the very `SongScene` the projector uses, at the
  projector's proportion — or 16:9 when the monitors are the shorter stage, so what fits the projector
  never overflows a monitor —, and bisects the largest size at which all of them fit (floor: the
  theme's minimum). Cached per (slides, theme, proportion). `SongScene` itself measures nothing: the
  projector, the monitors and every tile draw `sizeCqw` as given, so they cannot disagree and the
  letters never change size between slides. `goLiveWithSong` measures BEFORE `base` changes, under
  the live intent like a deck.
- **Moving inside the song is a cut or the theme's fade, never a new scene.** `setSongPosition` bumps
  `enterSeq`, which `selectOutput` turns into the output's `enter` (the `slide` variant's mechanism);
  T (`setLyricsHidden`) is a cut and any move shows the lyrics again.
- **Jumps** are `shared/song-jump.ts` (pure): the next time a section is sung, Shift the previous one;
  a section not ahead (or behind) is a **detour** whose last slide → leaves at the slide after the one
  it left. During a detour no slide of the order is on air.
- **Saving the live song, its theme, or a song setting re-dresses it in place** (`refreshLiveSong` →
  `setLiveSong`): re-resolved, re-measured, on the same slide of the same pass — the same time its
  section is sung, not the same position in the order — clamped to the slides it has now
  (`sameSlideIn`); `sceneEpoch` never moves.
- **Two languages at once** (2026-11-05, owner's choices: a second text, stacked, a LIVE switch). A
  slide's `translation` comes from the editor's «Traducción» text, written like the lyrics and
  paired with them by section key and slide index (`withTranslation`, in `parseDraft`; written back
  by `translationSections`, an untranslated slide before a translated one as an empty `\` line) —
  or, pasted with no header at all, block by block in order with the lyrics' slides that have words
  (`translationFor`, owner 2026-11-06). A song is RESOLVED per language (`resolveSong`'s `language`,
  `sectionsIn`): «original» drops the translation, «translation» puts it in the lines, «both»
  keeps it on each `SongDeckSlide`, cut with the theme's lines — where the lyrics are cut when it has
  as many lines, else into as many pieces, evenly (`splitSection`). So the measuring, the tiles, the jumps and the projector need nothing new:
  `SongScene` draws `translation` under the lines, inside the measured block, in
  `SongTheme.translation` (scale of the lyrics' `em`, colour, italic) — the one size fits both. The
  live `base.language` starts at «both»; the LIVE row's «Original · Ambos · Traducción»
  (`setLiveSongLanguage`) re-resolves and re-measures the song in place, same slide (`sameSlideIn`:
  each language cuts the theme's lines its own way, so never the same number), no new scene —
  each language has its own one size. PREVIEW, always in «both», maps the live slide the same way.
- **A theme's video background** (2026-11-05, `SongBackground`'s `video`, songs only) goes live as
  `base.backgroundVideo` (`songBackgroundVideo`: the url `playableAssetUrl` gives, resolved when the
  song goes live and kept, epoch and all, while the re-dressed theme names the same file) and reaches
  the projector as the output's `songVideo`, at its TOP like `slideVideo`, so BLACK/LOGO only cover
  and pause it. `OutputView` draws it under every scene layer (`SongVideoLayer`: its still, then a
  `<video loop muted>` or the engine's canvas) and the song layer turns see-through over it
  (`videoBehind`) — never inside `SongScene`, because a slide's fade is two layers and the video
  would be a new element on every slide. An incoming song over its video does not "cover", so what
  it replaces fades out instead of holding under it. Everywhere no video is mounted — PREVIEW, the
  tiles, the theme editor, the stage, a monitor with motion off — the theme's `backgroundUrl` is the
  video's still. Main plays an engine one as a third, silent video session (`songVideo`).

## Keyboard

`use-global-shortcuts.ts`, with the split that lets you press them without looking:

| Key | What it moves |
|---|---|
| ←/→, PageUp/PageDown | **what is live** — the slide, verse or song slide on screen, derived from `base` and not from the focused panel. PageUp/PageDown are what a presentation remote sends for back/next |
| 1–9, C, P, F (Shift) | **only with a song live:** verse N, chorus, bridge, ending — the next time it is sung, Shift the previous one. Digits are read by `code`, so Shift+2 is still a 2; the projector forwards `shift` and `code` too |
| T | **only with a song live:** hide or show its lyrics, the theme's background stays |
| ↑/↓ | **the preview cursor** — nothing reaches the projector |
| Enter | sends the preview to the projector (`goLive()`) |
| Space | pauses/resumes an auto-advancing deck — the shortcut you need to stop dead a PPT that advances by itself |
| B (or «.») / L | BLACK / LOGO. «.» is a remote's blank-screen button |
| Delete/Backspace | removes the selected item (library before program) |
| Escape | in a text field, leaves it: the keys are the operator's again |

On the work screen they always work (owner, 2026-11-03), and that takes three things:

- **A control the mouse focused keeps no key**, whatever its role — a clicked tab, volume slider,
  seek bar, list trigger or thumbnail gives the arrows back (`isPointerFocused`, checked by
  `suppressesKey` and by each widget that handles arrows itself: `Tabs`, `MediaScrubber`, `Select`,
  `Menu`, `VirtualGrid`). Reached with Tab, a control keeps its own keys. A list closed by a mouse
  pick does not put focus back on its trigger: focus put there by code reads as the keyboard's.
- **The projector window forwards its keys.** macOS focuses it when it opens and a click on its
  screen does it on any system; main's `before-input-event` on it sends every key without
  Ctrl/⌘/Alt to the control window (`projector-key`), which runs the same `runShortcut`.
- **In a text field only the remote's keys work** (PageUp/PageDown); everything else types.

Held down, only stepping repeats: B, L, Enter, Space and Delete act once per press. A modal open
suspends all of them. A remote's slideshow button (F5/Esc, alternating) does nothing on purpose.
