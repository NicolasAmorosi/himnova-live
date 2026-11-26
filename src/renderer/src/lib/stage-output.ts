import { selectOutput, type ProjectionStoreState } from "@renderer/stores/projection.store";
import { slideAt, stepSong, type SongPosition } from "@shared/song-jump";
import { passageReference, type BibleVerseDTO } from "@shared/types/bible";
import type { ProjectionOutput, StageOutput } from "@shared/types/projection";
import { STAGE_BIBLE_STYLE, STAGE_SONG_THEME, resolveStageLayout, stageLyricRows, stageThresholds } from "@shared/stage";
import type { ResolvedSong } from "@shared/types/song";
import type { SettingsMap } from "@shared/types/settings";
import type { CountdownClock, StageClockFormat, StageMessage, StageTextSize } from "@shared/types/stage";

/** The Bible tab's cursor: a verse projected from it can tell what follows. */
export type StageBibleCursor = { verses: readonly BibleVerseDTO[]; currentVerseIndex: number | null };

/** What the stage panel set (the stage store) and how Settings ▸ Screens dresses it. */
export type StageControls = {
  countdown: { clock: CountdownClock; totalMs: number } | null;
  message: StageMessage | null;
  settings: Pick<
    SettingsMap,
    | "stage.layout"
    | "stage.mirror"
    | "stage.textSize"
    | "stage.clockFormat"
    | "stage.chords"
    | "stage.videoMotion"
    | "stage.warnMs"
    | "stage.alertMs"
    | "ui.locale"
  >;
  /** What the musicians' words need from the caller; absent, a 16:9 screen and nothing measured yet. */
  lyrics?: StageLyricsFit;
};

/** The stage screen's proportion, and the live song's one size for each of the musicians' rows, measured for them
 *  (`fitSongSize` of `stageSong` with `STAGE_SONG_THEME`, at `stageLyricRows`); `null` until it is. */
export type StageLyricsFit = { screenAspect: number; songSizes: { current: number; next: number } | null };

const NO_LYRICS_FIT: StageLyricsFit = { screenAspect: 16 / 9, songSizes: null };

/** «Auto» is the language's: 12 hours in English. */
export const stageHour12 = (clockFormat: StageClockFormat, locale: string): boolean =>
  clockFormat === "auto" ? locale === "en" : clockFormat === "12h";

export const TEXT_SCALE: Record<StageTextSize, number> = { small: 0.8, normal: 1, large: 1.25 };

/** On the stage every change eases (owner, 2026-11-13), and never slowly: the band reads, it does not watch. */
const STAGE_FADE_MS = 300;

/** What the projector shows, BLACK and LOGO included, as the stage draws it: a short crossfade between scenes
 *  whatever the projector's own transition is, no plates, and a verse in its own version only — two columns in a
 *  frame this size are two columns nobody on the platform can read. */
function onStage(state: ProjectionStoreState): ProjectionOutput {
  const output = selectOutput(state);
  const own = output.kind === "bible" ? { ...output, parallel: null } : output;
  return { ...own, plates: [], transition: { epoch: state.sceneEpoch, style: "crossfade", durationMs: STAGE_FADE_MS } };
}

/** The live song as the musicians read it, its words in one language: what the stage's size is measured on. */
export function stageSong(song: ResolvedSong): ResolvedSong {
  const words = <T extends { translation?: string[] }>({ translation: _translation, ...slide }: T) => slide;
  return {
    ...song,
    slides: song.slides.map(words),
    sections: song.sections.map((section) => ({ ...section, slides: section.slides.map(words) })),
  };
}

/** A song or a verse as the musicians read it: the words alone, white on black, a song at the size measured for its
 *  row (its video background, its translation and its footer stay on the projector). Anything else is the
 *  projector's picture. */
export function stageWords(output: ProjectionOutput, songSizeCqw: number = STAGE_SONG_THEME.minSizeCqw): ProjectionOutput {
  switch (output.kind) {
    case "song": {
      const { songVideo: _video, ...song } = output;
      return { ...song, theme: STAGE_SONG_THEME, sizeCqw: songSizeCqw, translation: null, footer: null, backgroundUrl: null };
    }
    case "bible":
      return { ...output, style: STAGE_BIBLE_STYLE, backgroundUrl: null };
    default:
      return output;
  }
}

/** «2/12»: the slide in a song's order or a deck; a verse's reference. Under BLACK or LOGO too: the band is still
 *  there. */
function stagePosition(state: ProjectionStoreState): string | null {
  const { base } = state;
  switch (base?.kind) {
    case "deck": {
      const total = state.liveDeck?.slides.length ?? 0;
      return total > 0 ? `${base.slideIndex}/${total}` : null;
    }
    case "song":
      return `${base.slideIndex}/${base.song.slides.length}`;
    case "bible":
      return base.reference;
    default:
      return null;
  }
}

/** What the projector would show with nothing covering it: what comes next. */
function uncovered(state: ProjectionStoreState): ProjectionOutput {
  return onStage({ ...state, overlay: "none" });
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
 * The musicians' screen (`StageOutput`): what the projector shows and what comes next. `posterUrl` is the live
 * video's thumbnail, fetched by the caller: what the stage shows for it with its videos off, and under `next`.
 */
export function stageOutputFor(
  state: ProjectionStoreState,
  bible: StageBibleCursor,
  posterUrl: string | null,
  controls: StageControls,
): StageOutput {
  const { base } = state;
  const { settings } = controls;
  const withStageChords = <T extends ProjectionOutput | null>(output: T, position: SongPosition | null): T =>
    settings["stage.chords"] ? (withChords(output, state, position) as T) : output;
  const thresholds = (totalMs: number) => stageThresholds(totalMs, settings["stage.warnMs"], settings["stage.alertMs"]);
  // The panel's own countdown; without one, a Functions countdown or stopwatch that is live, in the stage's style
  // (owner, 2026-11-14). A countdown to a time has no length: the operator's thresholds as they are.
  const live = base?.kind === "utility" ? base : null;
  const countdown = controls.countdown
    ? { clock: controls.countdown.clock, ...thresholds(controls.countdown.totalMs) }
    : live && live.clock.mode !== "clock"
      ? { clock: live.clock, ...thresholds(live.scene.tool === "countdown" ? live.scene.config.durationMs : Infinity) }
      : null;
  const clockFormat = settings["stage.clockFormat"];
  // Followed: a song, a presentation, or a verse whose chapter the Bible tab holds (a next is known).
  const layout = settings["stage.mirror"]
    ? "projector"
    : resolveStageLayout(
        settings["stage.layout"],
        base?.kind === "deck" || base?.kind === "song" || (base?.kind === "bible" && bible.currentVerseIndex !== null),
      );
  // Hidden lyrics are the one cover the band does not get, and without a word (owner, 2026-11-13).
  const shown = base?.kind === "song" && base.lyricsHidden ? { ...state, base: { ...base, lyricsHidden: false } } : state;
  // A copy of the projector is exactly its picture: plates, both versions of a verse, its own transition.
  const current = layout === "projector" ? selectOutput(state) : withStageChords(onStage(shown), base?.kind === "song" ? base : null);
  const next = withStageChords(nextOutput(state, bible), base?.kind === "song" ? stepSong(base.song, base, 1) : null);
  const lyrics = controls.lyrics ?? NO_LYRICS_FIT;
  const sizes = lyrics.songSizes ?? { current: STAGE_SONG_THEME.minSizeCqw, next: STAGE_SONG_THEME.minSizeCqw };
  const textScale = TEXT_SCALE[settings["stage.textSize"]];
  // Only the musicians read words; the preacher's small frame is the projector's picture.
  const words = layout === "musicians";
  return {
    current: words ? stageWords(current, sizes.current) : current,
    next: words && next ? stageWords(next, sizes.next) : next,
    videoStill: { posterUrl, videoUrl: base?.kind === "video" ? base.url : null },
    videoMotion: settings["stage.videoMotion"],
    countdown,
    message: controls.message,
    layout,
    hour12: stageHour12(clockFormat, settings["ui.locale"]),
    textScale,
    rows: stageLyricRows(lyrics.screenAspect, textScale),
    words: words && (base?.kind === "song" || base?.kind === "bible"),
    position: stagePosition(state),
  };
}
