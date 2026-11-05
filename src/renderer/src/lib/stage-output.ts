import { selectOutput, type ProjectionStoreState } from "@renderer/stores/projection.store";
import { stepSong } from "@shared/song-jump";
import { passageReference, type BibleVerseDTO } from "@shared/types/bible";
import { INSTANT_TRANSITION, type ProjectionOutput, type StageOutput } from "@shared/types/projection";

/** The Bible tab's cursor: a verse projected from it can tell what follows. */
export type StageBibleCursor = { verses: readonly BibleVerseDTO[]; currentVerseIndex: number | null };
export type StageWords = { black: string; logo: string; lyricsHidden: string; next: string };

/** What the projector would show with nothing covering it: no BLACK or LOGO,
 *  no plates, and cut rather than faded — the band reads, it does not watch. */
function uncovered(state: ProjectionStoreState): ProjectionOutput {
  return { ...selectOutput({ ...state, overlay: "none" }), plates: [], transition: INSTANT_TRANSITION };
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
      // Only a verse projected from the Bible tab has a cursor (`projectVerse`);
      // a program's verse, or the tab browsed elsewhere since, has none.
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
    current:
      base === null ? null : uncovered(lyricsHidden ? { ...state, base: { ...base, lyricsHidden: false } } : state),
    next: nextOutput(state, bible),
    videoStill: { posterUrl, videoUrl: base?.kind === "video" ? base.url : null },
    notice:
      overlay === "black" ? words.black : overlay === "logo" ? words.logo : lyricsHidden ? words.lyricsHidden : null,
    nextLabel: words.next,
  };
}
