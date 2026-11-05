/**
 * SongSelect's `.txt` (both footers) and ChordPro: sections from the labels,
 * chords apart from the words, the band's parts out, the footer and the directives into the
 * song's fields, and files told apart by their words.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { readChordPro, readSongSelect, readSongTextFiles } from "../../src/main/songs/text-files";
import type { SongSection } from "../../src/shared/types/song";

const outline = (sections: readonly SongSection[] | undefined) =>
  (sections ?? []).map((section) => [section.key, section.slides.map((slide) => slide.lines)]);

const SONGSELECT_2023 = [
  "Grace Above",
  "",
  "",
  "Verse 1",
  "First line of verse one",
  "Second line of verse one",
  "",
  "",
  "Chorus",
  "The chorus line",
  "",
  "",
  "Verse 2",
  "First line of verse two",
  "",
  "",
  "Tag",
  "The tag line",
  "",
  "Ann Writer, Ben Writer",
  "CCLI Song #7654321",
  "© 2023 Example Music",
  "For use solely with the SongSelect® Terms of Use. All rights reserved. www.ccli.com",
  "CCLI License #11111",
].join("\r\n");

describe("SongSelect", () => {
  test("the 2023 footer: authors above the song number, the licence words dropped", () => {
    const song = readSongSelect(SONGSELECT_2023, "es");
    expect(song).toMatchObject({
      title: "Grace Above",
      authors: "Ann Writer, Ben Writer",
      ccliNumber: "7654321",
      copyright: "© 2023 Example Music",
      order: [],
    });
    expect(outline(song?.sections)).toEqual([
      ["v1", [["First line of verse one", "Second line of verse one"]]],
      ["c1", [["The chorus line"]]],
      ["v2", [["First line of verse two"]]],
      ["e1", [["The tag line"]]],
    ]);
  });

  test("the footer before 2023: the number first, authors split by «|», a copyright without «©» after them", () => {
    const body = "Old Song\n\nVerse 1\nA line\n\nInterlude\nOoh\n\n";
    expect(
      readSongSelect(`${body}CCLI Song # 1234\nAnn Writer | Ben Writer\n© 1999 Old Music\nFor use solely with the SongSelect Terms of Use.\nCCLI License # 14`, "en"),
    ).toMatchObject({ authors: "Ann Writer, Ben Writer", copyright: "© 1999 Old Music", ccliNumber: "1234" });
    const without = readSongSelect(`${body}CCLI Song # 1234\nAnn Writer\n1999 Old Music\nCCLI License # 14`, "en");
    expect(without).toMatchObject({ authors: "Ann Writer", copyright: "1999 Old Music" });
    // A label the app has no word for is a section of its own, never a lyric.
    expect(outline(without?.sections)).toEqual([
      ["v1", [["A line"]]],
      ["o1", [["Ooh"]]],
    ]);
  });

  test("text without a CCLI footer is not SongSelect", () => {
    expect(readSongSelect("A title\n\nVerse 1\nA line\n", "es")).toBeNull();
  });
});

describe("ChordPro", () => {
  test("sections, repeats and the song's fields; chords kept apart; tabs and remarks dropped", () => {
    const text = `{title: Morning Hymn}
{artist: Ann Writer}
{composer: Ben Writer}
{meta: lyricist Ann Writer}
{copyright: Public domain}
{ccli: 22025}
{key: G}
# a note to self
{c: Capo 2}
[G]Morning has [C]broken
Like the first [D]morning

{soc}
[G]Praise for the [C]singing
[G] [C] [D]

Praise for the morning
{eoc}
{sot}
e|---3---|
{eot}
Sweet the rain's new fall
{chorus}
{c: Bridge}
Mine is the sunlight`;
    const [song] = readChordPro(text, "file name", "es");
    expect(song).toMatchObject({
      title: "Morning Hymn",
      authors: "Ann Writer, Ben Writer",
      copyright: "Public domain",
      ccliNumber: "22025",
      order: ["v1", "c1", "v2", "c1", "b1"],
    });
    expect(outline(song?.sections)).toEqual([
      ["v1", [["Morning has broken", "Like the first morning"]]],
      ["c1", [["Praise for the singing"], ["Praise for the morning"]]],
      ["v2", [["Sweet the rain's new fall"]]],
      ["b1", [["Mine is the sunlight"]]],
    ]);
    expect(song?.sections[0]?.slides[0]?.chords).toEqual([
      [
        { at: 0, name: "G" },
        { at: 12, name: "C" },
      ],
      [{ at: 15, name: "D" }],
    ]);
  });

  test("labelled sections and paragraphs: a labelled verse keeps its number, an unlabelled paragraph is a verse of its own", () => {
    const [song] = readChordPro(
      `{t: Song}\n{start_of_verse: Verse 2}\nSecond\n{end_of_verse}\n\nFirst unlabelled\n\nAnother\n{start_of_chorus: label="Coro"}\nChorus\n{eoc}`,
      "x",
      "es",
    );
    expect(outline(song?.sections)).toEqual([
      ["v2", [["Second"]]],
      ["v1", [["First unlabelled"]]],
      ["v3", [["Another"]]],
      ["c1", [["Chorus"]]],
    ]);
  });

  test("{new_song} starts another; a song without a title takes the file's name; one without words is a problem", () => {
    const songs = readChordPro(`{ns}\n{title: One}\nFirst song\n{new_song}\nSecond song\n{ns}\n{title: Empty}`, "hymns", "es");
    expect(songs.map((song) => song?.title ?? null)).toEqual(["One", "hymns", null]);
  });
});

describe("files", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "worship-song-text-"));
  afterAll(() => fs.rmSync(folder, { recursive: true, force: true }));
  const write = (name: string, bytes: Buffer | string) => {
    fs.writeFileSync(path.join(folder, name), bytes);
    return path.join(folder, name);
  };

  test("each file read by its words, whatever its extension; Windows-1252 and UTF-16 decoded", () => {
    const read = readSongTextFiles(
      [
        write("grace.txt", SONGSELECT_2023),
        write("chordpro.txt", "{title: Señor}\nCanción"),
        write("latin.cho", Buffer.from("{title: Oh Señor}\nCanción", "latin1")),
        write("utf16.cho", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("{title: Dios}\nÉl vive", "utf16le")])),
        write("notes.txt", "Just some notes\n\nwith no footer"),
      ],
      "es",
    );
    expect(read.songs.map((song) => song.title)).toEqual(["Grace Above", "Señor", "Oh Señor", "Dios"]);
    expect(read.songs[2]?.sections[0]?.slides[0]?.lines).toEqual(["Canción"]);
    expect(read.songs[3]?.sections[0]?.slides[0]?.lines).toEqual(["Él vive"]);
    expect(read.problems).toBe(1);
  });
});
