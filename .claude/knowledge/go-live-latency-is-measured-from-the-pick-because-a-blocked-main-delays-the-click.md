## GO LIVE latency is measured from the pick, because a blocked main delays the click and hides its own cost
**Area:** slides
**Trigger:** comparing two builds' «GO LIVE → painted» times, a perf regression that shows only with GO LIVE straight
after PREVIEW, or a driver that clicks EN VIVO as soon as PREVIEW shows «1/N»

- Believed (2026-11-22 night): moving the deck's fonts and metafiles to the parts thread (SE1) made a heavy deck reach
  the projector 130 to 250 ms later on Windows (Liturgia 199 → 329 ms, a 74-EMF deck 418 → 669 ms), measured from the
  click on EN VIVO to slide 1 painted.
- True (2026-11-23, same decks, base `42b37ac2` against `4463750d`, median of 3, a fresh app each): from picking the
  deck to slide 1 painted, the newer build is equal or better everywhere (Windows `.odp` 554 → 278, Liturgia
  554 → 366, simple-church 662 → 439). The driver clicked EN VIVO the moment PREVIEW showed «1/N»; on the old build
  main converted PREVIEW's fonts inline and froze, so «1/N» appeared 200 to 345 ms late and the click landed with the
  fonts already done. The old build's cost was spent before the clock started.
- Measure from the pick (`row.pick`) to painted, and keep the click time only as a split; compare only runs of one
  batch (the same build varied 278 / 364 / 392 ms across batches on the Windows test PC). Main's own `[probe]` lines are needed
  for the parts: Resource Timing does not record `worship://` requests.
- What the honest clock then showed: every slide model carries the deck's whole embedded-font list
  (`SlideModel.fonts`), and `loadSlideModel` (`src/renderer/src/lib/slide-models.ts`) waited for all of them before
  the first slide (Liturgia's slide 1 names 5 of 24 faces, the `.odp`'s none of 11). FS-1 (`6b4a4816`) loads only the
  faces the slide's text names; the cost moves to the step before a slide that brings new faces (read ahead), up to
  +113 ms once in a deck.
- Drivers, raw data and the table: the maintainer's `docs/auditorias/2026-11-22-noche/herramientas/material-real/manana-1123/`
  (`golive.mjs`, `table.py`, `FS-1-verificacion.md`).

**Last updated:** 2026-11-23
