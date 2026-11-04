## A `.ppt`'s drawing-group property table is PowerPoint's default for NEW shapes, never inherited
**Area:** slides
**Trigger:** a legacy `.ppt` drawn by `src/main/slides/ppt/` shows the wrong background (often green, `#00cc99`), a picture frame with a fill or a line PowerPoint doesn't draw, or a colour that depends on what a shape "inherits".

- Believed (and what LibreOffice does, `DffPropertyReader::SetDefaultPropSet`): the `OfficeArtFOPT`
  inside the document's `OfficeArtDggContainer` holds defaults every shape inherits. It doesn't, for
  PowerPoint: it is what PowerPoint gives a shape the user draws next (`fillColor` = scheme 4,
  «filled, stroked»). A master background shape that names no `fillColor` is **white** in
  PowerPoint, and LibreOffice paints it with scheme 4.
- Measured on the 160 binary decks with a PowerPoint reference (2026-11-03): inheriting it put 38%
  of the slides «wrong»; without it, 27%. A shape inherits only from itself and from the master
  shape its `hspMaster` names; whether it is filled or stroked, when neither says, is the shape
  type's default (LibreOffice's `mso_DefaultFillingTable`/`StrokingTable`, carried in
  `resources/ooxml/mso-shapes.json` as `notFilled`/`notStroked`).
- Same session, same kind of trap: the special colours a `fSysIndex` colour names are `0xF0` fill,
  `0xF1` line-or-fill, `0xF2` line, `0xF3` shadow, `0xF4` this, `0xF5` fill back, `0xF6` line back,
  `0xF7` fill-then-line (LibreOffice `msdffdef.hxx`), and grey comes before darken/lighten. With
  them off by one, every two-colour background gradient came out red instead of blue.
- How these were found, and how to check the next one: **PowerPoint is the oracle twice.** Its PDF
  (`ppt-ref.sh`) is the picture; «save as Open XML presentation» (the same script with that format)
  is its *reading* of the binary, which the app's `.pptx` reader turns into a model.
  `tools/release-checks/pptx-render/oracle.ts` compares that model with the binary reader's, text
  by text — it gave PowerPoint 97's exact text shadow (3 pt at 45°, 3 pt blur, scheme colour 2)
  before a single pixel was compared. Its noise to ignore: frames of placeholders inherited from a
  layout (the export leaves them 0×0), `0pt` vs `0%`, and `endParaRPr` the export omits.

**Last updated:** 2026-11-03
