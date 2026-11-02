# 04 — Renderer state

The global `state` object (20 fields) and the `els` map of ~45 hardcoded IDs are gone. In
their place, **Zustand** in per-domain slices (`src/renderer/src/stores/`):

| Store | What it holds |
|---|---|
| `program.store.ts` | current program (`items`, name, notes, date), `selectedIndex` (highlight), `activeIndex` (live), `dirty` |
| `preview.store.ts` | **what is being looked at** (`target`: program item \| verse \| library asset) + `slideIndex`, the preview cursor, independent of the projection one |
| `projection.store.ts` | `base` (what was chosen to project) + `overlay` ('none'\|'black'\|'logo') + `logoUrl` + `presentationOpen` |
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

`src/renderer/src/effects/end-of-playback.ts` takes off the air, on its own, a video or an
auto-advancing deck that finished playing by itself, leaving the logo scene
(`clearBaseContent()`) — the congregation is never left staring at the last frame or the last
slide because the operator forgot to clear. A deck counts as finished when it has reached
`autoplay: "finished"` **and**, if it has a soundtrack, that track has also reported `ended` —
whichever ends last wins; music longer than the sum of the timings is not cut off midway.
No manual deck (without `advanceAfterMs`) ever clears itself.

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

## The actions layer

`lib/actions/` is where everything that crosses stores lives, and it is split along
EasyWorship's two-stage flow:

- `preview.ts` — selection and preview cursor. **It never touches `projection.store`.** A click
  in the program, on a verse or on an asset always ends up here.
- `playback.ts` — `goLive()` is the **only** path from preview to projector, shared by the
  GO LIVE button, Enter, and double-clicking a row, a tile or a verse, so the four cannot
  diverge. Also `clearLive()` (CLEAR), `advanceSlide`/`gotoSlide` and `toggleOverlay`. It orders
  things so that a deck is **ready before** `base` changes: hitting GO LIVE on an unconverted
  `.pptx` leaves the projector as it is instead of cutting to black during the conversion.
- `bible.ts` — `projectVerse`/`advanceVerse` (live), `previewSearchHit` and
  `addVerseToSchedule`.

## Keyboard

`use-global-shortcuts.ts`, with the split that lets you press them without looking:

| Key | What it moves |
|---|---|
| ←/→ | **what is live** — the slide or verse on screen, derived from `base` and not from the focused panel |
| ↑/↓ | **the preview cursor** — nothing reaches the projector |
| Enter | sends the preview to the projector (`goLive()`) |
| Space | pauses/resumes an auto-advancing deck — the shortcut you need to stop dead a PPT that advances by itself |
| B / L | BLACK / LOGO |
| Delete/Backspace | removes the selected item (library before program) |
