## A chorded song line is far taller than `CHORDED_SCALE` assumes, so the stage measures a song with its chords drawn
**Area:** renderer
**Trigger:** a song slide with chords cut at the bottom on the stage screen; touching `ChordedLine`/`CHORDED_SCALE` in `components/shared/song-scene.tsx`, `fitSongSize` in `lib/song-fit.tsx`, or drawing chords anywhere new

- Believed: a song's size is measured without chords, and `SongScene` shrinks a chorded slide by `CHORDED_SCALE`
  (0.66) "because a row of chords makes the block that much taller", so it still fits.
- True: each chorded word run is an `inline-flex` column (chord over words) whose baseline is the CHORD's, so it hangs
  far below the paragraph's baseline. With Noto Sans at the 1.375 leading a chorded line box comes out around 2.6 em,
  not 1.375 + 0.69: about 24 % taller than 0.66 buys back.
- Evidence (2026-11-26, the musicians' words view): a four-line slide with chords on every line, the song's longest,
  lost its last line in the live row (only the tops of its chords showed), at both the 1.3 and the default 1.375
  leading. Two-line chorded slides looked fine because a shorter slide had set the size.
- Fix: the stage measures the song WITH its chords when they are on (`fitSongSize(song, theme, aspect, chords)`), and
  the measurer multiplies each probe by the block's own `data-song-scale` (what `SongScene` draws it at), so what
  fits there fits on the stage. The projector never draws chords and still measures without them.
- Then a second cut, same day, with the next row made shorter: measured WITH chords and still cut. Chromium rounds a
  face's ascent and descent to whole pixels, so a line is not the same share of the width at every size: in the real
  stage window a chorded line was 2.551 em at a 38 px font and 2.608 em at 16 px, and `fitSongSize` measures at
  1000 px, where the next row's letters are smaller still. The stage now measures its rows 6 % shorter than it draws
  them (`ROUNDING_HEADROOM` in `effects/stage-sync.ts`). The projector's sizes are large enough that this stays
  under its 1 px tolerance.
- Consequence: never trust a fixed scale for chords. Anything that draws chords must be measured with them drawn, and
  anything measured at one pixel size and drawn small needs headroom.

**Last updated:** 2026-11-26
