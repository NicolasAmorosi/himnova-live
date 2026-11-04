## A PDF page drawn on request costs milliseconds, and WebP is most of it
**Area:** slides
**Trigger:** touching `src/main/slides/rasterizer.ts` or `src/renderer/src/rasterizer.tsx`, the `slides.imageFormat` / `slides.maxRenderWidth` settings, or a PDF that feels slow to open or to step.

- Measured on an M3 (2026-11-03), pdf.js legacy in a hidden Electron window, PowerPoint-exported
  slide PDFs exported by PowerPoint from real church decks (1–48 pages, up to 11 MB):
  - opening the document: 20–26 ms; every page's size after that: 1–2 ms for the whole PDF;
  - drawing a page at 1920 px: 5–110 ms; a 320 px thumbnail, drawn and encoded: 4–23 ms;
  - encoding that 1920 px canvas with `canvas.toBlob`: **PNG 6–21 ms** (220 KB–1.3 MB),
    **WebP q0.92 70–165 ms** (60–290 KB), JPEG q0.92 8–13 ms.
- So the whole-PDF rasterization the app did until 2026-11-03 (every page to WebP on disk, one PDF
  at a time behind a queue) bought nothing: drawing the asked page takes less than a frame of
  waiting, and WebP — the default format — is the slow half of each page. The owner kept the format
  setting (2026-11-03); PNG is the fast one, and only lives in memory now.
- The projector's `preload` of the next slides (`output-view.tsx`) is what draws them ahead; main
  keeps encoded pages in a 128 MB in-memory cache keyed by the file's stamp, so the projector gets
  at once what PREVIEW drew (they are different renderers: Chromium's image cache is per process).
- Not measured: the owner's Windows PC and a scanned PDF of large photos (pdf.js decodes each image
  on every draw; the document stays open, so only the first draw of a page pays the parse).
