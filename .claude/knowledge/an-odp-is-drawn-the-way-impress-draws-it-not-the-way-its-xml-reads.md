## An `.odp` is drawn the way Impress draws it, not the way its XML reads
**Area:** slides
**Trigger:** touching `src/main/slides/odp/`, or an `.odp` whose text sits higher/lower, is styled differently or whose custom shape is skewed compared with LibreOffice's own PDF (`_ref/odp-pdf/`).

- LibreOffice Impress is the reference for `.odp` (it is the format's own program); measured against
  its PDF export on 287 files (2026-11-03), several attributes don't do what ODF says:
  - **`draw:text-style-name` is ignored** for alignment, size and colour — Impress applies it before
    the text exists. Only its `style:font-independent-line-spacing` acts: every line is then 1.2 of
    the size with the baseline at 1.0, whatever the face. Most decks converted from `.pptx` set it.
  - **Impress's normal line is the face's own ascent + descent**, not 1.2 em, and extra
    proportional spacing goes *above* the line. The reader converts each paragraph's spacing with a
    table of face metrics and moves the text area so the first baseline lands where Impress puts it
    (`firstBaselineShift` in `odp/text.ts`).
  - **A custom shape's real path is `drawooo:enhanced-path`** (with Impress's own `G` arc command);
    the `draw:enhanced-path` beside it is a plain fallback — reading it turned rounded rectangles
    into skewed boxes.
  - A bullet sits at the paragraph's first-line start plus `space-before`, the text a
    `min-label-width` after it; default tab stops count from the paragraph's margin, every
    `DefaultTabStop` of `settings.xml`.
  - `draw:fit-to-size="true"|"all"` is `TextBody.stretch`; `shrink-to-fit` stores no scale, so the
    reader estimates one from average advance widths.
- The reference has its own error: LibreOffice on a Mac sees only its bundled fonts, so in its PDFs
  Helvetica, Verdana, Open Sans… are a fallback face and CJK text is missing; part of the «bad» share
  is the reference, not the reader.
- A module that exports a function named `then` is a thenable: `await import()` of it never
  resolves (it hung vitest). Never name an export `then`.

**Last updated:** 2026-11-03
