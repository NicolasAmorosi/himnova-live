## Something drawn over `OutputView` must isolate it: its scene layers carry inline z-indexes
**Area:** renderer
**Trigger:** adding an overlay as a SIBLING after `OutputView` (a test pattern, a watermark, a debug grid) in the projector or a monitor; an E2E that checks an overlay with `toBeVisible()`

- `OutputView`'s root is `relative` with no z-index, so it makes no stacking context, and its scene layers carry
  `style={{ zIndex: 1 }}` (and more during a crossfade). They paint in the PARENT's context, over any later sibling
  with `z-index: auto`. The projector's test pattern (2026-11-21) sat in the DOM, full size, under the live video.
- Fixed by `className="isolate"` on the projector's `OutputView`: its layers stay inside it, and the sibling after it
  paints on top whatever z-indexes the scenes use. Isolating changes nothing else there: its backdrop is its own
  black root either way.
- `toBeVisible()` passed the whole time: Playwright checks size and CSS visibility, never what paints on top. The
  E2E now asks `document.elementFromPoint(centre)` and expects it inside the overlay. Only a screenshot showed it.

**Last updated:** 2026-11-21
