## A `SlideModel` colour must be `rgb()`/`rgba()`, and a trailing `<br>` opens no line
**Area:** slides
**Trigger:** writing a new reader that produces a `SlideModel` (`src/main/slides/ppt/`, `odp/`), a gradient drawn in the wrong colours, or a centred/bottom-anchored text box sitting lower than PowerPoint's.

- Colours in a model are CSS strings, but not any CSS: `slide-paint.tsx` blends gradient stops by
  reading the numbers back out of the string (`match(/[\d.]+/g)`), which only works for the
  `rgb(r,g,b)` / `rgba(r,g,b,a)` that `css()` in `pptx/color.ts` writes. A `#000099` stop yields
  the digits `000099` and the gradient paints garbage — a blue background came out dark red, while
  solid fills of the same colour looked right. Every reader writes colours through the same format
  (`cssColor` in `ppt/escher.ts` matches `css`).
- A paragraph that ends with a line break: PowerPoint opens one more line (at the paragraph mark's
  size); HTML's trailing `<br>` opens none, so the block was a line short and a centred one sat
  half a line lower (measured on a hymn with three trailing breaks: 32 → 17 coarse score once
  fixed). `SlideParagraph` (`slide-text.tsx`) appends a zero-width span after a trailing break.
  Applies to `.pptx` too (`a:br` before `a:endParaRPr`).

**Last updated:** 2026-11-03
