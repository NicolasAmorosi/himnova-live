/**
 * A song past a limit, read from another program's file, is fitted and gets in (owner, 2026-11-15; audit D8): it used
 * to vanish whole from a linked folder, and an import counted it «sin letra».
 */
import { describe, expect, test } from "vitest";
import { readChordPro } from "../../src/main/songs/text-files";
import {
  fitSongLimits,
  isSongUpsert,
  SONG_LINE_MAX_LENGTH,
  SONG_MAX_SECTIONS,
} from "../../src/shared/song-validators";
import { parseLyrics } from "../../src/shared/song-text";
import type { SongSection } from "../../src/shared/types/song";

const words = (count: number) => Array.from({ length: count }, (_, i) => `palabra${i % 10}`).join(" ");

describe("fitSongLimits", () => {
  test("a ChordPro song with a 539-character line and 61 verses gets in, fitted", () => {
    const long = words(60).slice(0, 539);
    const verse = (n: number) => `{start_of_verse: Estrofa ${n}}\n${n === 1 ? long : `linea ${n}`}\n{end_of_verse}\n`;
    const text = `{title: Larga}\n${Array.from({ length: 61 }, (_, i) => verse(i + 1)).join("")}`;

    const [song] = readChordPro(text, "larga", "es");

    expect(song).not.toBeNull();
    expect(song!.sections).toHaveLength(SONG_MAX_SECTIONS);
    const first = song!.sections[0]!.slides[0]!.lines;
    expect(first.every((line) => line.length <= SONG_LINE_MAX_LENGTH)).toBe(true);
    // Cut at a space, every word kept.
    expect(first.join(" ")).toBe(long);
  });

  test("a chord goes with the piece of the line it sits over", () => {
    const line = `${"a".repeat(300)} ${"b".repeat(300)}`;
    const section: SongSection = {
      key: "v1",
      type: "verse",
      number: 1,
      slides: [{ lines: [line], chords: [[{ at: 10, name: "G" }, { at: 305, name: "D" }]] }],
    };
    const fitted = fitSongLimits({ sections: [section], order: [] });
    const slide = fitted.sections[0]!.slides[0]!;
    expect(slide.lines).toEqual(["a".repeat(300), "b".repeat(300)]);
    expect(slide.chords).toEqual([[{ at: 10, name: "G" }], [{ at: 4, name: "D" }]]);
  });

  test("a song within the limits comes out as it went in, and what comes out passes the validator", () => {
    const sections = parseLyrics("[Estrofa 1]\nuno\n\ndos\n\n[Coro]\nel coro", "es").sections;
    const song = {
      title: "Corta",
      number: null,
      authors: null,
      copyright: null,
      ccliNumber: null,
      notes: null,
      sections,
      order: ["v1", "c1", "v1"],
      themeId: null,
    };
    expect(fitSongLimits(song)).toEqual(song);
    expect(isSongUpsert(fitSongLimits(song))).toBe(true);
  });
});
