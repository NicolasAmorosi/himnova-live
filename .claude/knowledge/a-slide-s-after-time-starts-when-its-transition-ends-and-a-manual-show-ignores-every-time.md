## A slide's «After» time starts when its transition ends, and a show set to «Manually» ignores every slide's time
**Area:** slides
**Trigger:** a church reports «the slides get ahead of the music» or «this hymn advances by itself and it shouldn't»;
touching `slideHoldMs`/`buildCumulativeMs` (`projection.store.ts`), `deck-autoplay.ts`, or the timing readers
(`ppt-binary.ts`, `pptx-metadata.ts`, `odp/meta.ts`)

- **Measured in PowerPoint 16.112 on the Mac (2026-11-21)**, by AppleScript polling `current show position` and
  `slide elapsed time` of the slide show view every ~20 ms (`run slide show`). During a transition the position reads
  0; the next slide's elapsed time starts at ~0 when the transition ENDS. Hymn 002 (random bars, fast, 0.5 s) and
  hymn 138 (fade smoothly, slow, 1.0 s): every slide stayed its own time plus the transition into it (plus ~40 to 55 ms
  of PowerPoint's own per slide). The app counted the times alone, so a deck ran ahead of its music by the sum of its
  transitions: 4.5 s by the last slide of 002, 17 s in 138.
- **The whole sung hymnal agrees.** Over its 611 hymns with an `.mp3` and every slide timed, the deck's end minus the
  song's end is a median of +0.2 s counting the transitions, and -3.1 s (482 of 611 ending early) without them. The
  authors timed them in PowerPoint, transitions included.
- **The first slide's transition is not counted**: PowerPoint plays it before the slide's timeline, where the music
  starts. `slideHoldMs(slides, n)` = `advanceAfterMs` + (n > 1 ? `transition.durationMs` : 0), used by the synced
  boundaries (`cumulativeMs`, which the transport's «next in» also reads) and the detached chain (`advanceMsFor`).
  PowerPoint's legacy speeds are 0.5 / 0.75 / 1.0 s, as `SLIDE_TRANSITION_SPEED_MS` already said: its `transition
  duration` read them back from hymns 002 (fast), 300 (medium) and 138 (slow), and each lasted that long on screen.
- **The app, measured against its music after the fix** (real hymns and their `.mp3`, a throwaway Playwright probe
  logging each slide change against the projector's `<audio>`): within ~20 ms of the computed boundaries, landing
  early by design. PowerPoint itself runs ~40 to 55 ms per slide behind its nominal times, so by the last slide of 002 it
  is ~0.5 s later than the app; not emulated. Not measured: when PowerPoint starts the linked music (its `.mp3` was
  moved aside to avoid the sandbox prompt), so leaving out the first slide's transition rests on PowerPoint's model,
  where a slide's timeline (its sounds included) starts after its transition.
- **Counting the transitions makes half the hymnal's last slides outlast their song** (328 of 611 decks end after their
  music, 2026-11-22 audit): a synced deck no longer ends with its music then, its last slides run out their own times
  (`runPastMusic`). The ended music is then held paused in the store, or lifting BLACK/LOGO `play()`s the ended
  `<audio>` from 0:00 under the slides left. And the detached chain adds a slide's transition only when the deck moved forward onto it (`slideEntryMs`): a step
  back or a GO LIVE past slide 1 is a cut. It counts even when the slide cut in because «Transiciones de las
  presentaciones» (`slides.transitions`) is off: `slideEntry` is only how it is drawn (2026-11-25). **Impress was never measured**: an `.odp` gets the same rule by analogy.
- **«Sin secuencia» was the show's own setting.** That copy of hymn 001 has the hymnal's per-slide times, but its
  `SlideShowDocInfoAtom` (0x0401, a child of the `DocumentContainer`, 80 bytes) has bit 0 of the u16 at +76
  (`fAutoAdvance`, Set Up Slide Show ▸ «Using timings, if present») clear: PowerPoint said «manual advance» and stayed on
  slide 1 for 35 s. The app read only the slides' atoms. A file without the atom uses timings (22 of the hymnal's). Its
  siblings: OOXML `ppt/presProps.xml` `<p:showPr useTimings="0">` (default true), ODF `<presentation:settings
  presentation:force-manual="true">`. A manual show now reads as no timings at all, so it never starts autoplay.
- **Driving the Mac's PowerPoint from a script:** it is sandboxed. `open` in AppleScript on a file outside its
  container hangs on «Grant File Access»; `open -a "Microsoft PowerPoint" <file>` (Launch Services) passes the access
  with the file. A hymn's linked `.mp3` asks again: move it away (the slides' timing does not depend on it). A `.pps`
  opens straight into the show, so copy it as `.ppt` to read its settings first. `out` is a PowerPoint term: a
  variable named so fails with «Access not allowed». Script: `entry effect`, `advance time`, `transition duration` of
  `slide show transition`, and `advance mode` of `slide show settings`.

**Last updated:** 2026-11-25
