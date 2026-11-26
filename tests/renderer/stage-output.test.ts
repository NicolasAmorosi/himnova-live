/**
 * The musicians' screen (`stageOutputFor`): what the projector shows (BLACK and
 * LOGO as themselves, never named; hidden lyrics lifted), what → would bring,
 * and «Proyector», the projector's own picture.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { buildCumulativeMs, selectOutput, useProjectionStore, type LiveDeck } from "@renderer/stores/projection.store";
import { resolveSong } from "@renderer/stores/song.store";
import { stageOutputFor, type StageBibleCursor, type StageControls } from "@renderer/lib/stage-output";
import { DEFAULT_SETTINGS } from "@shared/types/settings";
import { parseLyrics } from "@shared/song-text";
import { DEFAULT_SONG_THEME } from "@shared/types/song";
import { STAGE_BIBLE_STYLE, STAGE_LYRICS, STAGE_SONG_THEME, stageLyricRows } from "@shared/stage";
import { DEFAULT_SCENE_STYLE } from "@shared/types/scene-style";
import { DEFAULT_TIMER_FORMAT } from "@shared/types/timer";
import type { UtilityScene } from "@shared/types/utility";
import { slideUrl } from "@shared/urls";
import type { BibleVerseDTO } from "@shared/types/bible";

const initialState = useProjectionStore.getState();
const NO_CURSOR: StageBibleCursor = { verses: [], currentVerseIndex: null };

const NO_CONTROLS: StageControls = { countdown: null, message: null, settings: DEFAULT_SETTINGS };

const stage = (bible: StageBibleCursor = NO_CURSOR, poster: string | null = null, controls = NO_CONTROLS) =>
  stageOutputFor(useProjectionStore.getState(), bible, poster, controls);

function liveDeck(slideCount: number, slideIndex: number) {
  const slides = Array.from({ length: slideCount }, (_, i) => ({
    index: i + 1,
    url: slideUrl(500, i + 1),
    thumbUrl: `${slideUrl(500, i + 1)}/thumb`,
    modelUrl: null,
    advanceAfterMs: null,
    transition: null,
  }));
  const deck: LiveDeck = {
    assetId: 9,
    deckId: 500,
    slides,
    soundtrack: null,
    sounds: [],
    videos: [],
    cumulativeMs: buildCumulativeMs(slides),
    autoAdvance: false,
  };
  const store = useProjectionStore.getState();
  store.setLiveDeck(deck);
  store.setBase({ kind: "deck", assetId: 9, slideIndex });
}

function liveSong(slideIndex: number, lyricsHidden = false, lyrics = "[Estrofa 1]\nuno\n\ndos\n\n[Coro]\ncoro") {
  const sections = parseLyrics(lyrics, "es").sections;
  const song = {
    id: 7,
    title: "Sublime gracia",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections,
    order: ["v1", "c1", "v1"],
    themeId: null,
    sourceFolder: null,
    file: null,
    updatedAt: 1,
  };
  useProjectionStore.getState().setBase({
    kind: "song",
    songId: 7,
    song: resolveSong(song, DEFAULT_SONG_THEME, null),
    slideIndex,
    detour: null,
    lyricsHidden,
    enterSeq: 0,
    theme: DEFAULT_SONG_THEME,
    sizeCqw: 4.2,
    backgroundVideo: null,
    language: "both",
  });
}

function verse(n: number, text: string): BibleVerseDTO {
  return { id: n, bookId: 43, bookName: "Juan", chapter: 3, verse: n, text };
}

beforeEach(() => {
  useProjectionStore.setState(initialState, true);
});

describe("the stage display", () => {
  test("with nothing live: what the projector shows (black, or LOGO), and nothing next", () => {
    expect(stage()).toMatchObject({ current: { kind: "logo" }, next: null });
    expect(stage()).not.toHaveProperty("notice");
  });

  test("a deck: the live slide and the next one, none after the last", () => {
    liveDeck(3, 2);
    const { current, next } = stage();
    expect(current).toMatchObject({ kind: "slide", index: 2, plates: [] });
    expect(next).toMatchObject({ kind: "slide", index: 3 });
    liveDeck(3, 3);
    expect(stage().next).toBeNull();
  });

  test("a song: the next slide in its order, across sections", () => {
    liveSong(2);
    expect(stage().current).toMatchObject({ kind: "song", lines: ["dos"] });
    expect(stage().next).toMatchObject({ kind: "song", lines: ["coro"] });
  });

  test("a song's chords reach the stage, over the live slide and the next — never the projector", () => {
    liveSong(1, false, "[Estrofa 1]\n[G]uno [C]más\n\n[D]dos\n\n[Coro]\ncoro");
    const { current, next } = stage();
    expect(current).toMatchObject({ kind: "song", lines: ["uno más"], chords: [[{ at: 0, name: "G" }, { at: 4, name: "C" }]] });
    expect(next).toMatchObject({ kind: "song", lines: ["dos"], chords: [[{ at: 0, name: "D" }]] });
    expect(selectOutput(useProjectionStore.getState())).not.toHaveProperty("chords");
  });

  test("a section sung off the order (a detour) brings its chords too", () => {
    liveSong(1, false, "[Estrofa 1]\n[G]uno\n\n[Coro]\n[C]coro\n\n[Puente]\n[Em]puente");
    useProjectionStore.getState().setSongPosition({ slideIndex: 1, detour: { sectionKey: "b1", slideIndex: 1, returnTo: 1 } });
    expect(stage().current).toMatchObject({ kind: "song", lines: ["puente"], chords: [[{ at: 0, name: "Em" }]] });
  });

  test("BLACK and LOGO show as themselves, never named (owner, 2026-11-13); what comes next stays", () => {
    liveSong(1);
    useProjectionStore.getState().setOverlay("black");
    expect(stage()).toMatchObject({ current: { kind: "black" }, next: { kind: "song", lines: ["dos"] } });
    useProjectionStore.getState().setOverlay("logo");
    expect(stage().current.kind).toBe(selectOutput(useProjectionStore.getState()).kind);
    expect(stage().current.kind).not.toBe("song");
  });

  test("hidden lyrics stay on the stage, without a word", () => {
    liveSong(1, true);
    expect(stage()).toMatchObject({ current: { kind: "song", lines: ["uno"] } });
  });

  test("«Proyector» (the panel's view, or Settings' copy of the projector) is exactly the projector's picture", () => {
    liveSong(1, true, "[Estrofa 1]\n[G]uno\n\ndos");
    const projector = { ...NO_CONTROLS, settings: { ...DEFAULT_SETTINGS, "stage.layout": "projector" as const } };
    const copy = stage(NO_CURSOR, null, projector);
    expect(copy.layout).toBe("projector");
    // Hidden lyrics stay hidden and no chords: what the room sees.
    expect(copy.current).toEqual(selectOutput(useProjectionStore.getState()));
    // Settings' copy wins over whatever view the panel had.
    const mirror = { ...NO_CONTROLS, settings: { ...DEFAULT_SETTINGS, "stage.mirror": true, "stage.layout": "musicians" as const } };
    expect(stage(NO_CURSOR, null, mirror).layout).toBe("projector");
  });

  test("a verse from the Bible tab: the next verse of its chapter", () => {
    useProjectionStore.getState().setBase({ kind: "bible", text: "dieciséis", reference: "Juan 3:16", versionLabel: null });
    const cursor = { verses: [verse(16, "dieciséis"), verse(17, "diecisiete")], currentVerseIndex: 0 };
    expect(stage(cursor).next).toMatchObject({ kind: "bible", text: "diecisiete", reference: "Juan 3:17" });
    // A program's verse has no cursor: nothing follows it.
    expect(stage(NO_CURSOR).next).toBeNull();
  });

  test("a video is shown as its poster", () => {
    useProjectionStore.getState().setBase({ kind: "video", assetId: 3, url: "worship://asset/3", epoch: 1, startAtSeconds: 0 });
    expect(stage(NO_CURSOR, "worship://thumb/3")).toMatchObject({
      current: { kind: "video" },
      next: null,
      videoStill: { posterUrl: "worship://thumb/3", videoUrl: "worship://asset/3" },
    });
  });

  test("videos move on the stage unless Settings ▸ Screens turns them into stills", () => {
    expect(stage().videoMotion).toBe(true);
    const still = { ...NO_CONTROLS, settings: { ...DEFAULT_SETTINGS, "stage.videoMotion": false } };
    expect(stage(NO_CURSOR, null, still).videoMotion).toBe(false);
  });

  test("the musicians read a song as words: the stage's theme, the size measured for each row, one language", () => {
    liveSong(2);
    const lyrics = { screenAspect: 16 / 9, songSizes: { current: 7.5, next: 5 } };
    const { current, next, position } = stage(NO_CURSOR, null, { ...NO_CONTROLS, lyrics });
    expect(current).toMatchObject({ kind: "song", lines: ["dos"], theme: STAGE_SONG_THEME, sizeCqw: 7.5, translation: null, footer: null });
    expect(current).not.toHaveProperty("songVideo");
    expect(next).toMatchObject({ kind: "song", lines: ["coro"], theme: STAGE_SONG_THEME, sizeCqw: 5 });
    // The order is v1 (two slides), c1, v1: five in all.
    expect(position).toBe("2/5");
    // The preacher's small frame stays the projector's picture.
    const preacher = { ...NO_CONTROLS, lyrics, settings: { ...DEFAULT_SETTINGS, "stage.layout": "preacher" as const } };
    expect(stage(NO_CURSOR, null, preacher)).toMatchObject({
      current: { kind: "song", theme: DEFAULT_SONG_THEME, sizeCqw: 4.2 },
      words: false,
    });
    // Words, covered too: BLACK over the last slide (nothing next) must not turn the view into pictures.
    expect(stage().words).toBe(true);
    liveSong(5);
    useProjectionStore.getState().setOverlay("black");
    expect(stage()).toMatchObject({ current: { kind: "black" }, next: null, words: true });
  });

  test("a verse reads as words with its reference in the strip; a deck stays a picture, with its slide in the strip", () => {
    useProjectionStore.getState().setBase({ kind: "bible", text: "dieciséis", reference: "Juan 3:16", versionLabel: null });
    const cursor = { verses: [verse(16, "dieciséis"), verse(17, "diecisiete")], currentVerseIndex: 0 };
    const verses = stage(cursor);
    expect(verses).toMatchObject({ current: { kind: "bible", style: STAGE_BIBLE_STYLE }, next: { style: STAGE_BIBLE_STYLE } });
    expect(verses.position).toBe("Juan 3:16");
    liveDeck(24, 7);
    expect(stage()).toMatchObject({ current: { kind: "slide", index: 7 }, position: "7/24", words: false });
    useProjectionStore.getState().setOverlay("black");
    expect(stage().position).toBe("7/24");
  });

  test("the two rows and the strip fill the screen's height, whatever its proportion and text size", () => {
    for (const aspect of [16 / 9, 16 / 10, 4 / 3]) {
      for (const scale of [0.8, 1, 1.25]) {
        const { current, next } = stageLyricRows(aspect, scale);
        const width = 100 - 2 * STAGE_LYRICS.padCqw;
        const used = width / current + width / next + STAGE_LYRICS.stripCqw * scale + 2 * STAGE_LYRICS.padCqw + 2 * STAGE_LYRICS.gapCqw;
        expect(used).toBeCloseTo(100 / aspect, 6);
        expect(next).toBeGreaterThan(current);
      }
    }
    expect(stage().rows).toEqual(stageLyricRows(16 / 9, 1));
  });

  test("chords off in Settings ▸ Screens: the stage shows the words alone", () => {
    liveSong(1);
    const off = { ...NO_CONTROLS, settings: { ...DEFAULT_SETTINGS, "stage.chords": false } };
    expect(stage(NO_CURSOR, null, off).current).not.toHaveProperty("chords");
    expect(stage(NO_CURSOR, null, off).next).not.toHaveProperty("chords");
  });
});

describe("the stage panel's controls", () => {
  const running = { clock: { mode: "countdown", state: "running", endsAtMs: 2_000_000 }, totalMs: 30 * 60_000 } as const;
  const held = { clock: { mode: "countdown", state: "held", remainingMs: 30 * 60_000 }, totalMs: 30 * 60_000 } as const;

  test("«Auto»: the preacher's, unless a song, a presentation or a chapter's verse is live (its last slide too)", () => {
    expect(stage().layout).toBe("preacher");
    expect(stage(NO_CURSOR, null, { ...NO_CONTROLS, countdown: running }).layout).toBe("preacher");
    liveSong(1);
    expect(stage().layout).toBe("musicians");
    liveDeck(2, 2); // the last slide: nothing follows, and the musicians keep it large
    expect(stage().next).toBeNull();
    expect(stage().layout).toBe("musicians");
    useProjectionStore.getState().setBase({ kind: "bible", text: "dieciséis", reference: "Juan 3:16", versionLabel: null });
    expect(stage({ verses: [verse(16, "dieciséis")], currentVerseIndex: 0 }).layout).toBe("musicians");
    // A program's verse whose chapter is not in the tab: nothing known to follow.
    expect(stage(NO_CURSOR).layout).toBe("preacher");
    const musicians = { ...NO_CONTROLS, settings: { ...DEFAULT_SETTINGS, "stage.layout": "musicians" as const } };
    useProjectionStore.getState().setBase({ kind: "video", assetId: 3, url: "worship://asset/3", epoch: 1, startAtSeconds: 0 });
    expect(stage(NO_CURSOR, null, musicians).layout).toBe("musicians");
  });

  test("the countdown travels as its mark with its thresholds, the message as it was set", () => {
    const out = stage(NO_CURSOR, null, { ...NO_CONTROLS, countdown: running, message: { text: "Último coro", urgent: false, seq: 4 } });
    expect(out.countdown).toEqual({ clock: running.clock, warnMs: 5 * 60_000, alertMs: 60_000 });
    expect(out.message).toEqual({ text: "Último coro", urgent: false, seq: 4 });
    // A ten-minute count: amber at 2:00, red at 0:30.
    const short = { ...NO_CONTROLS, countdown: { ...held, totalMs: 10 * 60_000 } };
    expect(stage(NO_CURSOR, null, short).countdown).toMatchObject({ warnMs: 2 * 60_000, alertMs: 30_000 });
  });

  test("a Functions countdown or stopwatch on the air is the stage's count, in its style; the panel's own wins", () => {
    const scene = (tool: UtilityScene["tool"]): UtilityScene => ({
      id: 1,
      name: "Cuenta",
      tool,
      config: { durationMs: 10 * 60_000, targetMinuteOfDay: 600, endMessage: null, format: DEFAULT_TIMER_FORMAT },
      style: DEFAULT_SCENE_STYLE,
      title: null,
      message: null,
    });
    const clock = { mode: "countdown", state: "running", endsAtMs: 3_000_000 } as const;
    useProjectionStore.getState().setBase({ kind: "utility", sceneId: 1, scene: scene("countdown"), clock });
    // Its own length scales the colours, like the panel's: ten minutes turn amber at 2:00.
    expect(stage()).toMatchObject({ layout: "preacher", countdown: { clock, warnMs: 2 * 60_000, alertMs: 30_000 } });
    // A countdown to a time has no length: the operator's thresholds as they are.
    useProjectionStore.getState().setBase({ kind: "utility", sceneId: 1, scene: scene("countdown-to-time"), clock });
    expect(stage().countdown).toMatchObject({ warnMs: 5 * 60_000, alertMs: 60_000 });
    const stopwatch = { mode: "stopwatch", state: "running", startedAtMs: 1_000 } as const;
    useProjectionStore.getState().setBase({ kind: "utility", sceneId: 1, scene: scene("stopwatch"), clock: stopwatch });
    expect(stage().countdown?.clock).toEqual(stopwatch);
    expect(stage(NO_CURSOR, null, { ...NO_CONTROLS, countdown: running }).countdown?.clock).toEqual(running.clock);
    // A clock has nothing to count: the stage's own time is it.
    useProjectionStore.getState().setBase({ kind: "utility", sceneId: 1, scene: scene("clock"), clock: { mode: "clock" } });
    expect(stage().countdown).toBeNull();
  });

  test("the clock: the language's by default (12 hours in English), or the one chosen", () => {
    expect(stage().hour12).toBe(false);
    expect(stage(NO_CURSOR, null, { ...NO_CONTROLS, settings: { ...DEFAULT_SETTINGS, "ui.locale": "en" } }).hour12).toBe(true);
    const twelve = { ...NO_CONTROLS, settings: { ...DEFAULT_SETTINGS, "stage.clockFormat": "12h" as const } };
    expect(stage(NO_CURSOR, null, twelve).hour12).toBe(true);
    expect(stage(NO_CURSOR, null, { ...NO_CONTROLS, settings: { ...DEFAULT_SETTINGS, "stage.textSize": "large" } }).textScale).toBe(1.25);
  });
});
