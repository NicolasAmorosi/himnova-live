## Electron never aborts a protocol request the page gave up on, so main has to order its own queue
**Area:** slides
**Trigger:** a queue behind `protocol.handle` (`worship://deck/<id>/<n>` → `pdfPageImage` in `src/main/slides/rasterizer.ts`), anything that relies on `request.signal`, or a PDF that lags behind the operator's key presses.

- Believed: when the projector drops an image it no longer wants (`img.src = ""` in `OutputView`'s
  preload, or React swapping the visible `<img>`'s `src`), the `Request` main's `protocol.handle`
  received gets its `signal` aborted, so a queued draw could be cancelled.
- True (measured 2026-11-03, Electron 44.3.0, a 20-line probe: `new Image()` → `src = ""` after
  200 ms on a handler that waits 1.5 s): `request.signal` exists but **never fires `abort`**, and
  `signal.aborted` is still `false` when the handler answers.
- Consequence: a first-come-first-served `now` lane drew every page an operator skipped past before
  the one on screen — 12 quick → presses in a 48-page PDF left page 13 off the projector for 2.0 s
  (Windows), 2.6 s (Linux laptop), 0.95 s (M3). The fix is order, not cancellation:
  `takeNewestBurst` (`src/main/slides/raster-order.ts`) serves the newest burst of asks first (the
  visible slide, then its warm-up, arrive within a frame), and a queued page asked for again joins
  that burst (`bump`). Mac: 0.95 s → 0.26–0.32 s. Abandoned pages are still drawn afterwards.
- Do not build cancellation on `request.signal` without re-measuring on the Electron in use.
  Related: [a PDF page drawn on request costs milliseconds](a-pdf-page-drawn-on-request-costs-milliseconds-and-webp-is-most-of-it.md).

**Last updated:** 2026-11-03
