## A `FontFace` loaded on its own and added to `document.fonts` afterwards fires no `loadingdone`

**Area:** slides
**Trigger:** anything that re-measures or redraws text when a font arrives (`slide-metrics.ts`, `useFontsLoaded`,
`metricsOf`), or a deck's embedded fonts (`registerFonts` in `lib/slide-models.ts`).

- `document.fonts` fires `loadingdone` only for faces it tracked while they were loading: a face from
  `document.fonts.load(...)`, or one declared in CSS. A deck's embedded font is a standalone
  `new FontFace(...).load()`, added once loaded, and adding an already-loaded face fires nothing (the spec;
  Chromium's `add` tracks only faces still loading).
- So a listener on `loadingdone` alone (the metrics cache, the memoized `SlideView`'s redraw) never hears an
  embedded font. The session that added A41's redraw first tested it by dispatching `loadingdone` by hand, which
  proved nothing for this case; a cold review found it (2026-11-16). `registerFonts` calls `fontsChanged()` itself
  after `document.fonts.add(loaded)`.
- A test of a font-arrival path must use the path's real event source, not a hand-dispatched event.
