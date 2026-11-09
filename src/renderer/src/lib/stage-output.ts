import { selectOutput, type ProjectionStoreState } from "@renderer/stores/projection.store";
import { slideAt, stepSong, type SongPosition } from "@shared/song-jump";
import { passageReference, type BibleVerseDTO } from "@shared/types/bible";
import { INSTANT_TRANSITION, type ProjectionOutput, type StageOutput } from "@shared/types/projection";

/** The Bible tab's cursor: a verse projected from it can tell what follows. */
export type StageBibleCursor = { verses: readonly BibleVerseDTO[]; currentVerseIndex: number | null };
export type StageWords = { black: string; logo: string; lyricsHidden: string; next: string };

/** What the projector would show with nothing covering it: no BLACK or LOGO,
 *  no plates, and cut rather than faded — the band reads, it does not watch.
 *  A verse in its own version only: two columns in a frame this size are two
 *  columns nobody on the platform can read. */
function uncovered(state: ProjectionStoreState): ProjectionOutput {
  const output = selectOutput({ ...state, overlay: "none" });
  const own = output.kind === "bible" ? { ...output, parallel: null } : output;
  return { ...own, plates: [], transition: INSTANT_TRANSITION };
}

/** A song slide with its chords, for the musicians: the slide of the live song
 *  at `position` — of the order or of a detour —, found by where it is and not
 *  by its words, so two slides of chords alone (an intro, an interlude: no
 *  words, owner 2026-11-06) bring their own. In «Traducción» the slide is the
 *  translation's, which carries none. */
function withChords(output: ProjectionOutput | null, state: ProjectionStoreState, position: SongPosition | null): ProjectionOutput | null {
  if (output?.kind !== "song" || state.base?.kind !== "song" || !position) return output;
  const chords = slideAt(state.base.song, position)?.chords;
  return chords ? { ...output, chords } : output;
}

/** The slide or verse → would bring — the same step `advanceSlide`,
 *  `advanceSong` and `advanceVerse` take — or `null`. */
function nextOutput(state: ProjectionStoreState, bible: StageBibleCursor): ProjectionOutput | null {
  const { base } = state;
  switch (base?.kind) {
    case "deck":
      return base.slideIndex < (state.liveDeck?.slides.length ?? 0)
        ? uncovered({ ...state, base: { ...base, slideIndex: base.slideIndex + 1 }, slideEntry: null })
        : null;
    case "song": {
      const position = stepSong(base.song, base, 1);
      return position ? uncovered({ ...state, base: { ...base, ...position, lyricsHidden: false } }) : null;
    }
    case "bible": {
      // The Bible tab's cursor: a verse projected from it (`projectVerse`), or a
      // program's verse once its chapter reached the tab (`handLiveItemToTab`);
      // the tab browsed elsewhere since has none.
      const index = bible.currentVerseIndex;
      const verse = index === null ? undefined : bible.verses[index + 1];
      if (!verse) return null;
      const reference = passageReference(verse.bookName, verse.chapter, verse.verse, verse.verse);
      return uncovered({ ...state, base: { ...base, text: verse.text, reference } });
    }
    default:
      return null;
  }
}

/**
 * The musicians' screen (`StageOutput`): what is live and what comes next,
 * with the cover named rather than shown. `posterUrl` is the live video's
 * thumbnail, fetched by the caller: the stage shows a video as its poster.
 */
export function stageOutputFor(
  state: ProjectionStoreState,
  bible: StageBibleCursor,
  posterUrl: string | null,
  words: StageWords,
): StageOutput {
  const { base, overlay } = state;
  const lyricsHidden = base?.kind === "song" && base.lyricsHidden;
  return {
    current: withChords(
      base === null ? null : uncovered(lyricsHidden ? { ...state, base: { ...base, lyricsHidden: false } } : state),
      state,
      base?.kind === "song" ? base : null,
    ),
    next: withChords(nextOutput(state, bible), state, base?.kind === "song" ? stepSong(base.song, base, 1) : null),
    videoStill: { posterUrl, videoUrl: base?.kind === "video" ? base.url : null },
    notice:
      overlay === "black" ? words.black : overlay === "logo" ? words.logo : lyricsHidden ? words.lyricsHidden : null,
    nextLabel: words.next,
  };
}
