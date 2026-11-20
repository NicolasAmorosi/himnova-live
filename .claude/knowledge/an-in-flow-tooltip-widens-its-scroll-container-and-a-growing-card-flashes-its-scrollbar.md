## An in-flow tooltip widens the scroll area of the box it sits in, and a card that grows flashes its scrollbar
**Area:** ui
**Trigger:** a scrolling panel or card (`overflow-y-auto`) shows a scrollbar although its children fit; animating a box's height (`interpolate-size`, `@starting-style`); `components/ui/tooltip.tsx` inside anything that scrolls

- `Tooltip` without `floating` is a CSS bubble absolutely positioned off its trigger, invisible until hover,
  but it still exists for layout overflow. Inside an `overflow-y-auto` box, a trigger near its bottom with
  `placement="bottom"` (the default) pushes the box's `scrollHeight` past its `clientHeight`. Measured on the
  stage panel's card (2026-11-13): children 220 + 143 + 201 = 564 px, `scrollHeight` 592: a permanent scrollbar
  for 28 px of hidden bubble. Fix: `floating` (portal to `body`, positioned in the viewport) for every tooltip
  inside a scrolling or clipping box. Measuring the children's heights against `scrollHeight` is what tells this
  apart from content that really does not fit.
- Animating a card's height from a bar's to `auto` works in Electron 44 with
  `interpolate-size: allow-keywords` + `transition: height` + `@starting-style { height: <start> }`, no JS
  measuring (`.wa-stage-card` in `globals.css`). But while it grows, its `overflow-y-auto` body is shorter than
  its content, so a scrollbar shows for the growth and vanishes at the end: a jerk the owner saw at once. Clip
  the body (`overflow-hidden`) until the height's `transitionend` (with a timer as a fallback: a window the OS
  is not drawing never ends a transition), then let it scroll.
- The same `interpolate-size` trick eases a band in and out of a flex column (the stage's message), so what is
  above it moves instead of jumping. Keep the last content drawn while it collapses, then unmount it.

- 2026-11-20 (audit X16): the in-flow tooltip is gone; every `Tooltip` floats, so the first point above can no
  longer happen. The `floating` prop is still accepted and does nothing.

**Last updated:** 2026-11-13
