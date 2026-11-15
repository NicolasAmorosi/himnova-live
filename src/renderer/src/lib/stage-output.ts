import { selectOutput, type ProjectionStoreState } from "@renderer/stores/projection.store";
import { slideAt, stepSong, type SongPosition } from "@shared/song-jump";
import { passageReference, type BibleVerseDTO } from "@shared/types/bible";
import type { ProjectionOutput, StageOutput } from "@shared/types/projection";
import { resolveStageLayout, stageThresholds } from "@shared/stage";
import type { SettingsMap } from "@shared/types/settings";
import type { CountdownClock, StageMessage, StageTextSize } from "@shared/types/stage";

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
};

const TEXT_SCALE: Record<StageTextSize, number> = { small: 0.8, normal: 1, large: 1.25 };

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
  return {
    // A copy of the projector is exactly its picture: plates, both versions of a verse, its own transition.
    current: layout === "projector" ? selectOutput(state) : withStageChords(onStage(shown), base?.kind === "song" ? base : null),
    next: withStageChords(nextOutput(state, bible), base?.kind === "song" ? stepSong(base.song, base, 1) : null),
    videoStill: { posterUrl, videoUrl: base?.kind === "video" ? base.url : null },
    videoMotion: settings["stage.videoMotion"],
    countdown,
    message: controls.message,
    layout,
    // «Auto» is the language's: 12 hours in English.
    hour12: clockFormat === "auto" ? settings["ui.locale"] === "en" : clockFormat === "12h",
    textScale: TEXT_SCALE[settings["stage.textSize"]],
  };
}
