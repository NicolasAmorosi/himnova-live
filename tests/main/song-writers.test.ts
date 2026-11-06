/**
 * The song writers against their own readers: what is written reads back as
 * the same song, for every field the format holds — songs built here, and real
 * files read, written and read again (a fixed point) —, a file rewritten in
 * place keeping what the app never read (owner, 2026-11-06), the encodings a
 * file is written back in, and `SONG_FILE_LIMITS` against what the writers do.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { decodeText, encodeText, readText } from "../../src/main/decode-text";
import { readOpenLyrics, readOpenLyricsFiles } from "../../src/main/songs/openlp";
import {
  rewriteChordPro,
  rewriteOpenLyrics,
  rewriteSongSelect,
  withXmlEncoding,
  writeChordPro,
  writeOpenLyrics,
  writeSongSelect,
  type WrittenSong,
} from "../../src/main/songs/song-writers";
import { readChordPro, readSongSelect, readSongText, readSongTextFiles } from "../../src/main/songs/text-files";
import { SONG_FILE_LIMITS, songFileLimits, type SongFileField } from "../../src/shared/song-file-limits";
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

  test("notes as written: a blank line and double spaces are the operator's", () => {
    const noted = { ...FULL, notes: "Capo 2\n\nTono:  G (bajar en la 3ª)" };
    expect(read(noted)?.notes).toBe(noted.notes);
  });

  test("a line pasted from PowerPoint (a vertical tab as its soft break) is written as well-formed XML", () => {
    const xml = writeOpenLyrics(song("[Verse 1]\nSublime gracia\u000Bdel Señor"));
    // XML 1.0 forbids C0 controls but tab/LF/CR: OpenLP's parser refuses the whole file.
    expect([...xml].filter((char) => char < " " && !"\t\n\r".includes(char))).toEqual([]);
    expect(readOpenLyrics(xml)?.sections[0]?.slides[0]?.lines).toEqual(["Sublime gracia del Señor"]);
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

  test("words that would read as something else are escaped and come back as words", () => {
    const lines = (s: WrittenSong | null) => (s?.sections ?? []).flatMap((x) => x.slides.flatMap((slide) => slide.lines));
    // A remark, a directive, a bracket that is no chord, a backslash.
    const tricky = song("[Verse 1]\n#1 en mi corazón\n{bis}\nGloria [in excelsis] Deo\n[Hombres] Santo, santo\nC:\\himnos\n\n[Chorus]\n[G]{bis} canten");
    expect(lines(read(tricky))).toEqual([
      "#1 en mi corazón",
      "{bis}",
      "Gloria [in excelsis] Deo",
      "[Hombres] Santo, santo",
      "C:\\himnos",
      "{bis} canten",
    ]);
    expect(writeChordPro([tricky])).toContain("\\#1 en mi corazón\n\\{bis}\nGloria \\[in excelsis] Deo");
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
    // «All rights reserved» is a song's copyright as often as the licence's words.
    const rights = { ...bare, authors: "Ann Writer", copyright: "2026 Example Music. All rights reserved" };
    expect(read(rights)).toEqual(held(rights));
  });

  test("a lyric in braces («{bis}») does not make the file read as ChordPro", () => {
    const braced = song("[Verse 1]\nCanten todos\n{bis}", { authors: "Ann Writer", ccliNumber: "1234" });
    expect(readSongText(writeSongSelect(braced), "file name", "es").map(fields)).toEqual([held(braced)]);
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

describe("an edit written back survives in every format, for what the format holds", () => {
  const EDITED: WrittenSong = {
    ...song("[Verse 1]\n[G]Sublime gracia del [D]Señor"),
    title: `Gracia & «paz» <1> {x} [y] #2 ]]> 'q'`,
    authors: "José Pérez, Ñandú & Co.",
    copyright: "© 2026 Música {libre} #1",
    ccliNumber: "7654321",
    sections: parseLyrics(
      "[Verse 1]\n[Am]Sublime [F#m7]gracia del [D/F#]Señor & <todos>\nque a un pecador salvó\n\nFui ciego, mas hoy veo yo\n\n[Chorus]\nAleluya {gloria}\n\n[Verse 2]\nSegunda estrofa\n\n[Bridge]\nΦῶς ἱλαρόν 我的全心 О, Благодать",
      "es",
    ).sections,
    order: ["v1", "c1", "v2", "c1", "b1", "c1"],
  };

  test("title, authors, copyright, CCLI, sections added and reordered, chords, special characters", () => {
    expect(fields(readOpenLyrics(writeOpenLyrics(EDITED)))).toEqual(EDITED);
    expect(fields(readChordPro(writeChordPro([EDITED]), "file", "es")[0])).toEqual({ ...EDITED, number: null, notes: null });
    const plainSlides = { ...EDITED, order: [], sections: EDITED.sections.map((s) => ({ ...s, slides: s.slides.map((sl) => ({ lines: sl.lines })) })) };
    expect(fields(readSongSelect(writeSongSelect(plainSlides), "es"))).toEqual({ ...plainSlides, sections: flat(plainSlides.sections) });
  });
});

describe("a slide of chords alone and an empty line inside a slide (review 2026-11-06)", () => {
  // An instrumental intro (owner, 2026-11-06: the projector shows the background,
  // the stage the chords), and empty lines the operator wrote as «\\».
  const INSTRUMENTAL = song("[Intro]\n[G] [D] [Em] [C]\n\n[Verse 1]\n[G]Sublime gracia\n\\\nsegunda\n\\\n\n[Chorus]\nAleluya", {
    order: ["i1", "v1", "c1", "c1"],
  });

  test("read back as written, in OpenLyrics and in ChordPro", () => {
    expect(INSTRUMENTAL.sections[0]?.slides[0]?.lines).toEqual([""]);
    expect(INSTRUMENTAL.sections[1]?.slides[0]?.lines).toEqual(["Sublime gracia", "", "segunda", ""]);
    expect(fields(readOpenLyrics(writeOpenLyrics(INSTRUMENTAL)))).toEqual(INSTRUMENTAL);
    expect(fields(readChordPro(writeChordPro([INSTRUMENTAL]), "file", "es")[0])).toEqual(INSTRUMENTAL);
    // ChordPro's empty line is a lone «\», never a blank line: that one starts another slide.
    expect(writeChordPro([INSTRUMENTAL])).toContain("[G]Sublime gracia\n\\\nsegunda\n\\\n{end_of_verse}");
  });
});

/* ---------------------------------------------------------------------------
 * A file rewritten in place (owner, 2026-11-06: never lose what is in it)
 * ------------------------------------------------------------------------ */

describe("ChordPro rewritten in place", () => {
  const FILE = [
    "{title: Sublime gracia}",
    "{subtitle: Amazing Grace}",
    "{artist: John Newton}",
    "{composer: Trad.}",
    "{key: G}",
    "{capo: 2}",
    "{meta: arranger Ana}",
    "# arreglo del domingo",
    "{gc: Intro}",
    "[G]   [D]   [Em]",
    "",
    "{start_of_verse: Verse 1}",
    "[G]Sublime gracia del [C]Señor",
    "# a remark among the words",
    "que a un pecador salvó",
    "{end_of_verse}",
    "",
    "{start_of_tab}",
    "e|---3---|",
    "{end_of_tab}",
    "{ccli: 22025}",
    "",
    "{new_song}",
    "{title: Preludio}",
    "{start_of_verse}",
    "[G] [D] [C]",
    "{end_of_verse}",
    "",
    "{new_song}",
    "{title: Castillo fuerte}",
    "{start_of_verse}",
    "Castillo fuerte es nuestro Dios",
    "{end_of_verse}",
    "",
  ].join("\r\n");
  const [gracia, preludio, castillo] = readSongText(FILE, "domingo", "es");

  test("another song of the file is edited: the others stay byte for byte, a song of chords alone too", () => {
    // «Preludio» is an instrumental song (owner, 2026-11-06): its chords are its words.
    expect(preludio?.sections[0]?.slides[0]).toEqual({ lines: [""], chords: [[{ at: 0, name: "G" }, { at: 0, name: "D" }, { at: 0, name: "C" }]] });
    const edited = rewriteChordPro(FILE, 2, { ...castillo!, title: "Castillo fuerte (2)" }, "domingo");
    const at = FILE.lastIndexOf("{new_song}");
    expect(edited.slice(0, at)).toBe(FILE.slice(0, at));
    expect(readSongText(edited, "domingo", "es")).toEqual([gracia, preludio, { ...castillo, title: "Castillo fuerte (2)" }]);
  });

  test("its own directives above and below its words stay; a changed field is written where it was", () => {
    const edited = rewriteChordPro(FILE, 0, { ...gracia!, authors: "John Newton, E. O. Excell", ccliNumber: "7654321" }, "domingo");
    const block = edited.slice(0, edited.indexOf("{new_song}"));
    for (const kept of ["{subtitle: Amazing Grace}", "{key: G}", "{capo: 2}", "{meta: arranger Ana}", "# arreglo del domingo", "{gc: Intro}", "[G]   [D]   [Em]", "{start_of_tab}\r\ne|---3---|\r\n{end_of_tab}"]) {
      expect(block).toContain(kept);
    }
    // The authors where their lines were; the CCLI number, whose only line was
    // below the words, under the title.
    expect(block).toContain("{title: Sublime gracia}\r\n{ccli: 7654321}\r\n{subtitle: Amazing Grace}\r\n{artist: John Newton}\r\n{artist: E. O. Excell}\r\n{key: G}");
    // The old CCLI line below the words would win over the new one: it goes.
    expect(block).not.toContain("{ccli: 22025}");
    expect(readSongText(edited, "domingo", "es")[0]).toMatchObject({ authors: "John Newton, E. O. Excell", ccliNumber: "7654321" });
  });

  test("an edit that leaves the words alone leaves their lines alone; one that changes them loses a remark among them", () => {
    // Review 2026-11-06: a title-only edit regenerated the words, losing what sat among them.
    const titled = rewriteChordPro(FILE, 0, { ...gracia!, title: "Sublime gracia (2)" }, "domingo");
    expect(titled).toBe(FILE.replace("{title: Sublime gracia}", "{title: Sublime gracia (2)}"));
    const reworded = rewriteChordPro(FILE, 0, { ...gracia!, sections: [...gracia!.sections, ...song("[Puente]\nNueva").sections] }, "domingo");
    expect(reworded).not.toContain("a remark among");
    expect(readSongText(reworded, "domingo", "es")[0]?.sections.at(-1)?.slides[0]?.lines).toEqual(["Nueva"]);
  });

  test("written anew in a CRLF file, every line ends in CRLF", () => {
    const reworded = rewriteChordPro(FILE, 2, { ...castillo!, sections: song("[Verse 1]\nUno\ndos\n\ntres").sections }, "domingo");
    expect(reworded).not.toMatch(/[^\r]\n/);
    expect(readSongText(reworded, "domingo", "es")[2]?.sections[0]?.slides.map((slide) => slide.lines)).toEqual([["Uno", "dos"], ["tres"]]);
  });

  test.skipIf(!fs.existsSync(FORMATS))("real files: key, capo, tempo, tabs, grids and ABC stay", () => {
    const rewritten = (file: string, index = 0) => {
      const text = decodeText(fs.readFileSync(path.join(FORMATS, file)));
      const songs = readSongText(text, "f", "es");
      return rewriteChordPro(text, index, { ...songs[index]!, title: "Edited" }, "f");
    };
    expect(rewritten("chordpro/cho/Silent Night.cho")).toEqual(expect.stringContaining("{key:Bb}"));
    expect(rewritten("chordpro/cho/Silent Night.cho")).toEqual(expect.stringContaining("{capo:3}"));
    expect(rewritten("chordpro/chopro/twinkle_twinkle_little_star.chopro")).toContain("{start_of_tab}");
    const father = rewritten("chordpro/cho/Our-Father-complex-tags.cho");
    for (const kept of ["{key: G}", "[G]  [C/E]  [C]", "{start_of_grid}", "{start_of_abc}", "{start_of_svg}"]) expect(father).toContain(kept);
  });
});

describe("OpenLyrics rewritten in place", () => {
  const FILE = `<?xml version='1.0' encoding='UTF-8'?>
<?xml-stylesheet href="openlyrics.css" type="text/css"?>
<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8" createdIn="OpenLP 2.0.4" xml:lang="es">
  <properties>
    <titles><title lang="es">Sublime gracia</title><title lang="en">Amazing Grace</title></titles>
    <authors><author type="words">John Newton</author></authors>
    <songbooks><songbook name="Himnario Adventista" entry="5"/><songbook name="Otro"/></songbooks>
    <key>G</key><tempo type="bpm">72</tempo>
    <themes><theme>Gracia</theme></themes>
  </properties>
  <format><tags application="OpenLP"><tag name="r"><open>&lt;span&gt;</open></tag></tags></format>
  <lyrics>
    <verse name="v1" lang="es"><lines>Sublime gracia del Señor</lines></verse>
    <verse name="v1" lang="en-US"><lines>Amazing grace how sweet the sound</lines></verse>
    <verse name="v1" lang="es" translit="la"><lines>Sublime gratia</lines></verse>
    <verse name="v1" lang="pt"><lines>Maravilhosa graça</lines></verse>
  </lyrics>
</song>
`;
  const before = readOpenLyrics(FILE)!;

  test("what the app never read stays: alternate titles, author types, songbooks' names, key, tempo, themes, other languages", () => {
    const edited = rewriteOpenLyrics(FILE, {
      ...before,
      sections: before.sections.map((section) => ({ ...section, slides: [{ ...section.slides[0]!, lines: ["Sublime gracia, ¡oh Señor!"] }] })),
    });
    for (const kept of [
      "<?xml-stylesheet",
      'createdIn="OpenLP 2.0.4" xml:lang="es"',
      '<title lang="es">Sublime gracia</title><title lang="en">Amazing Grace</title>',
      '<author type="words">John Newton</author>',
      '<songbook name="Himnario Adventista" entry="5"/><songbook name="Otro"/>',
      '<key>G</key>',
      '<tempo type="bpm">72</tempo>',
      "<theme>Gracia</theme>",
      '<tag name="r">',
      '<verse name="v1" lang="es" translit="la">',
      '<verse name="v1" lang="pt"><lines>Maravilhosa graça</lines></verse>',
      '<verse name="v1" lang="es">',
      '<verse name="v1" lang="en-US">',
    ]) {
      expect(edited).toContain(kept);
    }
    expect({ ...readOpenLyrics(edited), sections: [] }).toEqual({ ...before, sections: [] });
    expect(readOpenLyrics(edited)?.sections[0]?.slides[0]).toEqual({ lines: ["Sublime gracia, ¡oh Señor!"], translation: ["Amazing grace how sweet the sound"] });
  });

  test("a changed field is written anew; the first title keeps its attributes, the songbook its name", () => {
    const edited = rewriteOpenLyrics(FILE, { ...before, title: "Sublime gracia (2)", number: "6", authors: "J. Newton" });
    expect(edited).toContain('<title lang="es">Sublime gracia (2)</title><title lang="en">Amazing Grace</title>');
    expect(edited).toContain('<songbook name="Himnario Adventista" entry="6"/>');
    expect(edited).toContain("<author>J. Newton</author>");
    expect(readOpenLyrics(edited)).toMatchObject({ title: "Sublime gracia (2)", number: "6", authors: "J. Newton" });
  });

  test("the declaration names the encoding written; none is added for UTF-8", () => {
    expect(withXmlEncoding(FILE, "utf-8")).toBe(FILE);
    expect(withXmlEncoding(FILE, "windows-1252").startsWith("<?xml version='1.0' encoding=\"windows-1252\"?>")).toBe(true);
    expect(withXmlEncoding("<?xml version='1.0' encoding='ISO-8859-1'?><song/>", "windows-1252")).toContain("ISO-8859-1");
    expect(withXmlEncoding("<song/>", "utf-8")).toBe("<song/>");
    expect(withXmlEncoding("<song/>", "windows-1251")).toBe('<?xml version="1.0" encoding="windows-1251"?>\n<song/>');
  });

  test.skipIf(!fs.existsSync(FORMATS))("a real file: complex.xml keeps its alternate titles, songbook names, author types, themes, key, tempo", () => {
    const xml = decodeText(fs.readFileSync(path.join(FORMATS, "openlyrics/openlyrics-ejemplos/complex.xml")));
    const written = rewriteOpenLyrics(xml, { ...readOpenLyrics(xml)!, title: "Edited" });
    for (const kept of ["Erstaunliche Anmut", "Songbook with Number", 'type="words"', "<theme>", "<key>", "<tempo"]) {
      expect(written).toContain(kept);
    }
  });
});

describe("SongSelect rewritten in place", () => {
  test("the church's licence lines stay under the footer", () => {
    const old = "Grace\r\n\r\n\r\nVerse 1\r\nAmazing grace\r\n\r\nJohn Newton\r\nCCLI Song #22025\r\n© Public Domain\r\nFor use solely with the SongSelect® Terms of Use. All rights reserved. www.ccli.com\r\nCCLI License #11111\r\n";
    const song = readSongSelect(old, "en")!;
    const written = rewriteSongSelect(old, { ...song, title: "Grace (2)" });
    expect(written.endsWith("© Public Domain\r\nFor use solely with the SongSelect® Terms of Use. All rights reserved. www.ccli.com\r\nCCLI License #11111\r\n")).toBe(true);
    expect(readSongSelect(written, "en")).toEqual({ ...song, title: "Grace (2)" });
  });
});

describe("the encoding a file is written back in", () => {
  test("text read and written untouched is the same bytes, mark included", () => {
    const samples = [
      Buffer.from("{title: Señor}\r\n", "utf8"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Señor", "utf8")]),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Señor", "utf16le")]),
      Buffer.from([0x4f, 0x2c, 0x20, 0xc1, 0xeb, 0xe0, 0xe3, 0xee, 0x81, 0x8d]), // Windows-1251 read as Windows-1252, and two bytes 1252 leaves undefined
    ];
    for (const bytes of samples) {
      const read = readText(bytes);
      expect(Buffer.from(encodeText(read.text, read.encoding, read.bom)!)).toEqual(bytes);
    }
  });

  test("a character the encoding cannot hold says so, for the caller to write UTF-8", () => {
    expect(encodeText("Señor", "windows-1252", false)).toEqual(Uint8Array.from([0x53, 0x65, 0xf1, 0x6f, 0x72]));
    expect(encodeText("Благодать", "windows-1252", false)).toBeNull();
    expect(decodeText(encodeText("Благодать", "windows-1251", false)!)).not.toBe("Благодать"); // read as 1252: guessed, not lost
    expect(new TextDecoder("windows-1251").decode(encodeText("Благодать", "windows-1251", false) ?? undefined)).toBe("Благодать");
  });
});

describe("SONG_FILE_LIMITS is what the writers really lose", () => {
  const ALL = song("[Verse 1]\n[G]Uno\n\nDos\n\n[Chorus]\nCoro\n\n[Verse 2]\nTres", {
    number: "12",
    notes: "Despacio",
    order: ["v1", "c1", "v2", "c1"],
  });
  const translated = { ...ALL, sections: withTranslation(ALL.sections, parseLyrics("[Verse 1]\nOne", "es").sections) };
  const lost = (back: WrittenSong | null): SongFileField[] => {
    const out: SongFileField[] = [];
    if (back?.number !== translated.number) out.push("number");
    if (back?.notes !== translated.notes) out.push("notes");
    if (!back?.sections.some((section) => section.slides.some((slide) => slide.translation))) out.push("translation");
    if (JSON.stringify(back?.order) !== JSON.stringify(translated.order)) out.push("order");
    if (back?.sections[0]?.slides.length !== 2) out.push("slides");
    if (!back?.sections.some((section) => section.slides.some((slide) => slide.chords))) out.push("chords");
    return out;
  };

  test("each format's list, field by field", () => {
    expect(lost(fields(readOpenLyrics(writeOpenLyrics(translated))))).toEqual([...SONG_FILE_LIMITS.openlyrics]);
    expect(lost(fields(readChordPro(writeChordPro([translated]), "f", "es")[0])).sort()).toEqual([...SONG_FILE_LIMITS.chordpro].sort());
    expect(lost(fields(readSongSelect(writeSongSelect(translated), "es"))).sort()).toEqual([...SONG_FILE_LIMITS.songselect].sort());
  });

  test("by the file's name: a .txt is SongSelect's (the most), a file that is no song file nothing", () => {
    expect(songFileLimits("/Himnos/5.xml")).toEqual([]);
    expect(songFileLimits("C:\\Himnos\\Gracia.CHO")).toEqual(SONG_FILE_LIMITS.chordpro);
    expect(songFileLimits("gracia.txt")).toEqual(SONG_FILE_LIMITS.songselect);
    expect(songFileLimits("notas.md")).toEqual([]);
  });
});
