## OfficeArt boolean properties inherit from a master shape flag by flag, not as a whole value

**Area:** slides
**Trigger:** a picture with `hspMaster` (opid 0x0301) in a legacy deck; deciding whether a shape's
line, fill or visibility is on in `src/main/slides/ppt-binary.ts` (`mergeFlags` from `ppt/escher.ts`, `lineIsOff`,
`fillIsOff`, `isHidden`).

- Every property id ending in `0x3F` (`0x01BF` fill, `0x01FF` line, `0x03BF` group/visibility…) is
  16 flags in the low half, each meaningful only where its `fUse` twin in the high half is set
  (MS-ODRAW 2.3). A shape that names a master shape (`hspMaster`) inherits every flag it does not
  `fUse` — so `new Map([...master, ...own])` is wrong: the shape's own `0x01FF = 0x00100010`
  (only `fUsefArrowheadsOK`) overrode the master's `0x00190011` (`fUsefLine`, line off) and the
  line became «unknown». Merge per flag: `(own & ownUse) | (master & ~ownUse)`.
- Measured on the hymnal: 166 covers say nothing about their line themselves; the master's body
  placeholder they inherit from says «no line». Every other picture states it on the shape.
- `fLine`/`fFilled` with no `fUse` anywhere has a default this reader refuses to guess: such a deck
  goes to LibreOffice. None of the 1231 hymnal decks needs that.

**Last updated:** 2026-10-26
