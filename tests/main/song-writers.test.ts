/**
 * The song writers against their own readers: what is written reads back as
 * the same song, for every field the format holds — songs built here, and real
 * files read, written and read again (a fixed point).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { readOpenLyrics, readOpenLyricsFiles } from "../../src/main/songs/openlp";
import { writeChordPro, writeOpenLyrics, writeSongSelect, type WrittenSong } from "../../src/main/songs/song-writers";
import { readChordPro, readSongSelect, readSongTextFiles } from "../../src/main/songs/text-files";
import { parseLyrics, textOrder, withTranslation } from "../../src/shared/song-text";
import { LOCALES } from "../../src/shared/types/settings";
import type { SongSection } from "../../src/shared/types/song";

const song = (lyrics: string, fields: Partial<WrittenSong> = {}): WrittenSong => {
  const parsed = parseLyrics(lyrics, "es");
  return {
    title: "Sublime gracia",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: parsed.sections,
    order: textOrder(parsed),
    ...fields,
  };
};

/** The fields a writer reads, from whatever a reader gave. */
const fields = (read: WrittenSong | null | undefined): WrittenSong | null =>
  read
    ? {
        title: read.title,
        number: read.number,
        authors: read.authors,
        copyright: read.copyright,
        ccliNumber: read.ccliNumber,
        notes: read.notes,
        sections: read.sections,
        order: read.order,
      }
    : null;

const LYRICS = `[Verse 1]
[G]Amazing [C]grace, how sweet & <loud> the "sound"
That saved a wretch like [D/F#]me

I once was lost, but 'now' am found[G]

[Chorus]
[D]Hallelujah, R&B <3 &amp; ]]>
Praise Him

[Verse 2]
奇异恩典 何等甘甜
Слава Богу, мир
الله محبة 🙏

[Bridge]
Mine is the [Em7]sunlight`;

const FULL = song(LYRICS, {
  title: `Grace & "Mercy" <live>`,
  number: "12a",
  authors: "John Newton, Edwin O. Excell",
  copyright: "Public Domain",
  ccliNumber: "22025",
  notes: "Sing it slowly & softly\nCapo 2",
  order: ["v1", "c1", "v2", "c1", "b1", "c1"],
});

/** What SongSelect keeps of a section: its lines, in one slide, no chords. */
const flat = (sections: readonly SongSection[]): SongSection[] =>
  sections.map((section) => ({ ...section, slides: [{ lines: section.slides.flatMap((slide) => slide.lines) }] }));

describe("OpenLyrics", () => {
  const read = (s: WrittenSong) => fields(readOpenLyrics(writeOpenLyrics(s)));

  test("every field, chords, slides, escaping, non-Latin text and the order", () => {
    expect(read(FULL)).toEqual(FULL);
    expect(FULL.sections[0]?.slides).toHaveLength(2);
    expect(FULL.sections[0]?.slides[0]?.chords).toBeDefined();
  });

  test("an empty order stays empty; a repeated verse and a pre-chorus keep their keys", () => {
    const plain = song(LYRICS);
    expect(plain.order).toEqual([]);
    expect(read(plain)).toEqual(plain);
    const repeats = song("[Verse 1]\nOne\n\n[Pre-Chorus]\nBefore\n\n[Chorus 2]\nTwo\n\n[Ending]\nEnd\n\n[Intro]\nIn\n\n[Interlude]\nOoh", {
      order: ["i1", "v1", "pc1", "c2", "v1", "c2", "o1", "e1"],
    });
    expect(read(repeats)).toEqual(repeats);
    expect(writeOpenLyrics(repeats)).toContain("<verseOrder>i1 v1 p1 c2 v1 c2 o1 e1</verseOrder>");
  });

  test("the translation comes back paired by section and slide", () => {
    const original = parseLyrics("[Verse 1]\nSublime gracia\n\nFui ciego\n\n[Chorus]\nAleluya", "es").sections;
    const translation = parseLyrics("[Verse 1]\nAmazing grace\n\nWas blind & lost", "es").sections;
    const bilingual: WrittenSong = { ...song(""), sections: withTranslation(original, translation) };
    expect(bilingual.sections[0]?.slides[1]?.translation).toEqual(["Was blind & lost"]);
    expect(read(bilingual)).toEqual(bilingual);
  });

  test("XML that is well formed: an escaped title is one title", () => {
    const xml = writeOpenLyrics(FULL);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<song')).toBe(true);
    expect(xml).toContain("<title>Grace &amp; &quot;Mercy&quot; &lt;live&gt;</title>");
    expect(xml).toContain('<chord name="D/F#"/>');
  });
});

describe("ChordPro", () => {
  const read = (s: WrittenSong) => fields(readChordPro(writeChordPro([s]), "file", "es")[0]);
  /** What ChordPro holds: neither the number nor the notes. */
  const held = (s: WrittenSong): WrittenSong => ({ ...s, number: null, notes: null });

  test("every field it holds, chords, slides, non-Latin text and the order", () => {
    expect(read(FULL)).toEqual(held(FULL));
    const text = writeChordPro([FULL]);
    // The chorus sung again is the chorus repeated, never written twice.
    expect(text.match(/\{start_of_chorus/g)).toHaveLength(1);
    expect(text.match(/^\{chorus\}$/gm)).toHaveLength(2);
  });

  test("a repeated verse, a chorus that is not the newest, and every section type, in every language", () => {
    const repeats = song(
      "[Verse 1]\nOne\n\n[Chorus]\nFirst chorus\n\n[Pre-Chorus]\nBefore\n\n[Chorus 2]\nSecond chorus\n\n[Ending]\nEnd\n\n[Intro]\nIn\n\n[Interlude]\nOoh",
      { order: ["v1", "c1", "pc1", "c2", "v1", "c1", "e1", "i1", "o1", "c2"] },
    );
    for (const locale of LOCALES) {
      expect(fields(readChordPro(writeChordPro([repeats]), "file", locale)[0])).toEqual(held(repeats));
    }
    expect(writeChordPro([repeats])).toContain("{comment: Verse 1}");
    expect(writeChordPro([repeats])).toContain("{comment: Chorus 1}");
  });

  test("an empty order stays empty; two songs in one file", () => {
    const plain = song(LYRICS, { title: "Two", authors: "Ann Writer" });
    expect(plain.order).toEqual([]);
    const both = readChordPro(writeChordPro([FULL, plain]), "file", "es").map(fields);
    expect(both).toEqual([held(FULL), held(plain)]);
  });

  test("a section the order skips is written after it (a linear text cannot skip one)", () => {
    const skipped = song("[Verse 1]\nOne\n\n[Verse 2]\nTwo\n\n[Chorus]\nChorus", { order: ["v1", "c1", "v1"] });
    expect(read(skipped)?.order).toEqual(["v1", "c1", "v1", "v2"]);
  });
});

describe("SongSelect", () => {
  const read = (s: WrittenSong, locale: (typeof LOCALES)[number] = "es") => fields(readSongSelect(writeSongSelect(s), locale));
  /** What SongSelect holds: no number, notes, order, chords or slides. */
  const held = (s: WrittenSong): WrittenSong => ({ ...s, number: null, notes: null, order: [], sections: flat(s.sections) });

  test("title, sections as written, the footer; CRLF like SongSelect's own", () => {
    for (const locale of LOCALES) expect(read(FULL, locale)).toEqual(held(FULL));
    expect(writeSongSelect(FULL)).toContain("\r\nVerse 1\r\nAmazing grace");
    expect(writeSongSelect(FULL).split("\r\n").slice(-4)).toEqual([
      "John Newton, Edwin O. Excell",
      "CCLI Song #22025",
      "Public Domain",
      "",
    ]);
  });

  test("a footer with nothing but the song number, or a copyright and no authors", () => {
    const bare = song("[Verse 1]\nOne\n\n[Chorus]\nTwo");
    expect(read(bare)).toEqual(held(bare));
    expect(read({ ...bare, copyright: "© 2023 Example Music" })).toEqual(held({ ...bare, copyright: "© 2023 Example Music" }));
    // Without «©» and no authors it would be read as the authors: it gets the sign.
    expect(read({ ...bare, copyright: "Public Domain" })?.copyright).toBe("© Public Domain");
  });
});

/* ---------------------------------------------------------------------------
 * Real files (this Mac only): read → write → read is a fixed point
 * ------------------------------------------------------------------------ */

const HASD = "/Users/nicolasamorosi/Downloads/hasdlp-master/HASD";
const FORMATS = "/Users/nicolasamorosi/Downloads/hasdlp-master/pruebas-formatos";

const filesIn = (folder: string, pattern: RegExp): string[] =>
  fs.existsSync(folder)
    ? (fs.readdirSync(folder, { recursive: true }) as string[])
        .filter((name) => pattern.test(name))
        .map((name) => path.join(folder, name))
        .sort()
    : [];

/** A song as a file reader gives it, without which file it came from. */
const words = <T extends { origin?: unknown }>({ origin: _origin, ...song }: T) => song;

describe("real files", () => {
  test.skipIf(!fs.existsSync(HASD))("the HASD hymnal (OpenLyrics 0.8, Windows-1252)", () => {
    const songs = readOpenLyricsFiles(filesIn(HASD, /\.xml$/i)).songs.map(words);
    expect(songs.length).toBeGreaterThan(600);
    for (const first of songs) expect(readOpenLyrics(writeOpenLyrics(first)), first.title).toEqual(first);
  });

  test.skipIf(!fs.existsSync(FORMATS))("OpenLyrics files", () => {
    const files = [...filesIn(path.join(FORMATS, "openlyrics"), /\.xml$/i), ...filesIn(path.join(FORMATS, "creados-a-mano"), /\.xml$/i)];
    const songs = readOpenLyricsFiles(files).songs.map(words);
    expect(songs.length).toBeGreaterThan(40);
    for (const first of songs) expect(readOpenLyrics(writeOpenLyrics(first)), first.title).toEqual(first);
  });

  test.skipIf(!fs.existsSync(FORMATS))("ChordPro files", () => {
    const files = [
      ...filesIn(path.join(FORMATS, "chordpro"), /\.(cho|chordpro|chopro|pro|crd)$/i),
      ...filesIn(path.join(FORMATS, "creados-a-mano"), /\.cho$/i),
    ];
    expect(files.length).toBeGreaterThan(20);
    let read = 0;
    for (const file of files) {
      const songs = readSongTextFiles([file], "es").songs.map(words);
      if (songs.length === 0) continue; // a file with no song the app reads
      read += songs.length;
      expect(readChordPro(writeChordPro(songs), "file", "es"), file).toEqual(songs);
    }
    expect(read).toBeGreaterThan(20);
  });

  test.skipIf(!fs.existsSync(FORMATS))("SongSelect files", () => {
    const files = [
      ...filesIn(path.join(FORMATS, "songselect"), /\.txt$/i),
      ...filesIn(path.join(FORMATS, "creados-a-mano"), /^songselect.*\.txt$/i),
    ];
    const songs = readSongTextFiles(files, "es").songs.map(words);
    expect(songs).toHaveLength(files.length);
    for (const first of songs) expect(readSongSelect(writeSongSelect(first), "es"), first.title).toEqual(first);
  });
});
