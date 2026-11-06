/**
 * OpenLP's `songs.sqlite` (written here with the columns OpenLP 2.4 and 2.2
 * create) and OpenLyrics files: verses into sections and slides, chords and
 * formatting out, a second language as the translation, and the import's
 * duplicates and problems.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { initRepos } from "../../src/main/services/repos";
import { importOpenLpDatabase, importOpenLyricsFiles } from "../../src/main/services/song-import";
import { readOpenLpDatabase, readOpenLpLyrics, readOpenLyrics, readOpenLyricsFiles } from "../../src/main/songs/openlp";
import { IpcError } from "../../src/shared/ipc/result";

const drizzleDir = path.join(process.cwd(), "drizzle");

let tmpDir: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-openlp-"));
  const opened = openDatabase(path.join(tmpDir, "library.db"));
  sqlite = opened.sqlite;
  runMigrations(opened.db, drizzleDir);
  initRepos(opened.db, sqlite);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const lyricsXml = (verses: string) =>
  `<?xml version='1.0' encoding='UTF-8'?>\n<song version="1.0"><lyrics>${verses}</lyrics></song>`;
const verse = (type: string, label: string, text: string, lang = "") =>
  `<verse type="${type}" label="${label}"${lang ? ` lang="${lang}"` : ""}><![CDATA[${text}]]></verse>`;

const slidesOf = (sections: { key: string; slides: { lines: string[]; translation?: string[] }[] }[]) =>
  sections.map((section) => [section.key, section.slides.map((slide) => slide.lines)]);

describe("OpenLP's lyrics", () => {
  test("verses by type and label; [---] is a new slide; chords and formatting tags are not text", () => {
    const sections = readOpenLpLyrics(
      lyricsXml(
        verse("v", "1", "[C]Amazing [C7]grace, how [F#m7]sweet{br}the [G/B]sound\n[---]\n{r}That saved{/r} a wretch") +
          verse("c", "1", "[Coro] stays: a word in brackets is not a chord") +
          verse("p", "1", "Before the chorus"),
      ),
    );
    expect(slidesOf(sections)).toEqual([
      ["v1", [["Amazing grace, how sweet", "the sound"], ["That saved a wretch"]]],
      ["c1", [["[Coro] stays: a word in brackets is not a chord"]]],
      ["pc1", [["Before the chorus"]]],
    ]);
    // The chords come in apart from the words, for the musicians' screen.
    expect(sections[0]?.slides[0]?.chords).toEqual([
      [
        { at: 0, name: "C" },
        { at: 8, name: "C7" },
        { at: 19, name: "F#m7" },
      ],
      [{ at: 4, name: "G/B" }],
    ]);
    expect(sections[1]?.slides[0]?.chords).toBeUndefined();
  });

  test("a line of chords alone is kept: an instrumental verse is one (review 2026-11-06)", () => {
    const sections = readOpenLpLyrics(lyricsXml(verse("i", "1", "[G] [D] [Em] [C]") + verse("v", "1", "[G]Uno\n[C] [G]\ndos")));
    expect(slidesOf(sections)).toEqual([
      ["i1", [[""]]],
      ["v1", [["Uno", "", "dos"]]],
    ]);
    expect(sections[1]?.slides[0]?.chords?.[1]).toEqual([{ at: 0, name: "C" }, { at: 0, name: "G" }]);
  });

  test("a second language is the translation, paired by verse and slide; a third is dropped", () => {
    const sections = readOpenLpLyrics(
      lyricsXml(
        verse("v", "1", "Sublime gracia", "es") +
          verse("v", "1", "Amazing grace", "en") +
          verse("v", "1", "Grazia sublime", "it"),
      ),
    );
    expect(sections[0]!.slides).toEqual([{ lines: ["Sublime gracia"], translation: ["Amazing grace"] }]);
  });
});

/** An OpenLP 2.4 database: authors through `authors_songs`, the hymnal's
 *  number in `songs_songbooks`, a temporary song from a service. */
function writeOpenLp24(file: string): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE songs (id INTEGER NOT NULL PRIMARY KEY, title VARCHAR(255) NOT NULL, alternate_title VARCHAR(255),
      lyrics TEXT NOT NULL, verse_order VARCHAR(128), copyright VARCHAR(255), comments TEXT, ccli_number VARCHAR(64),
      theme_name VARCHAR(128), search_title VARCHAR(255) NOT NULL, search_lyrics TEXT NOT NULL, create_date DATETIME,
      last_modified DATETIME, "temporary" BOOLEAN);
    CREATE TABLE authors (id INTEGER NOT NULL PRIMARY KEY, first_name VARCHAR(128), last_name VARCHAR(128),
      display_name VARCHAR(255) NOT NULL);
    CREATE TABLE authors_songs (author_id INTEGER NOT NULL, song_id INTEGER NOT NULL, author_type VARCHAR(255) NOT NULL);
    CREATE TABLE song_books (id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(128) NOT NULL, publisher VARCHAR(128));
    CREATE TABLE songs_songbooks (songbook_id INTEGER NOT NULL, song_id INTEGER NOT NULL, entry VARCHAR(255) NOT NULL);
  `);
  const insert = db.prepare(
    `INSERT INTO songs (id, title, lyrics, verse_order, copyright, comments, ccli_number, search_title, search_lyrics, "temporary")
     VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?)`,
  );
  insert.run(
    1,
    "Amazing Grace",
    lyricsXml(verse("v", "1", "Amazing grace") + verse("c", "1", "My chains are gone") + verse("v", "2", "T'was grace")),
    "v1 c1 v2 c1",
    "Public Domain",
    "Sing it slowly",
    "22025",
    0,
  );
  insert.run(2, "In order", lyricsXml(verse("v", "1", "One") + verse("v", "2", "Two")), "v1 v2", null, null, "", 0);
  insert.run(3, "From a service", lyricsXml(verse("v", "1", "Temporary")), "", null, null, null, 1);
  insert.run(4, "No lyrics", lyricsXml(""), "", null, null, null, 0);
  db.exec(`
    INSERT INTO authors VALUES (1, 'John', 'Newton', 'John Newton'), (2, 'Edwin', 'Excell', 'Edwin Excell');
    INSERT INTO authors_songs VALUES (1, 1, 'words'), (1, 1, 'music'), (2, 1, 'music');
    INSERT INTO song_books VALUES (1, 'Himnario', NULL), (2, 'Otro', NULL);
    INSERT INTO songs_songbooks VALUES (1, 1, '230'), (2, 1, '12');
  `);
  db.close();
}

describe("OpenLP's database", () => {
  test("title, authors once each, the first hymnal's number, CCLI, notes, and the verse order", () => {
    const file = path.join(tmpDir, "songs-24.sqlite");
    writeOpenLp24(file);
    const { songs, problems } = readOpenLpDatabase(file);
    expect(problems).toBe(1);
    expect(songs.map((song) => song.title)).toEqual(["Amazing Grace", "In order"]);
    expect(songs[0]).toMatchObject({
      number: "230",
      authors: "John Newton, Edwin Excell",
      copyright: "Public Domain",
      ccliNumber: "22025",
      notes: "Sing it slowly",
      order: ["v1", "c1", "v2", "c1"],
    });
    // The order as written is the order an empty one already means.
    expect(songs[1]).toMatchObject({ number: null, authors: null, ccliNumber: null, order: [] });
  });

  test("OpenLP 2.2 keeps the number in the song", () => {
    const file = path.join(tmpDir, "songs-22.sqlite");
    const db = new Database(file);
    db.exec(`CREATE TABLE songs (id INTEGER PRIMARY KEY, title VARCHAR(255) NOT NULL, lyrics TEXT NOT NULL,
      verse_order VARCHAR(128), copyright VARCHAR(255), comments TEXT, ccli_number VARCHAR(64), song_number VARCHAR(64))`);
    db.prepare("INSERT INTO songs (id, title, lyrics, song_number) VALUES (1, 'Old', ?, '45')").run(
      lyricsXml(verse("v", "1", "Old words")),
    );
    db.close();
    expect(readOpenLpDatabase(file).songs[0]).toMatchObject({ title: "Old", number: "45" });
  });

  test("importing twice skips what is there; a file that is not OpenLP's says so", () => {
    const file = path.join(tmpDir, "songs-import.sqlite");
    writeOpenLp24(file);
    expect(importOpenLpDatabase(file)).toEqual({ imported: 2, repeated: 0, problems: 1, unsupported: 0 });
    expect(importOpenLpDatabase(file)).toEqual({ imported: 0, repeated: 2, problems: 1, unsupported: 0 });

    const other = path.join(tmpDir, "not-openlp.sqlite");
    new Database(other).exec("CREATE TABLE song (title TEXT)").close();
    for (const bad of [other, path.join(tmpDir, "missing.sqlite")]) {
      try {
        importOpenLpDatabase(bad);
        throw new Error("expected OPENLP_UNREADABLE");
      } catch (error) {
        expect((error as IpcError).code).toBe("OPENLP_UNREADABLE");
      }
    }
  });
});

const openLyrics = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8" createdIn="OpenLP 2.4.6">
  <properties>
    <titles><title>Sublime gracia</title><title>Amazing Grace</title></titles>
    <authors><author type="words">John Newton</author><author type="music">John Newton</author></authors>
    <copyright>Public Domain</copyright>
    <ccliNo>22025</ccliNo>
    <songbooks><songbook name="Himnario" entry="230"/></songbooks>
    <verseOrder>v1a v1b c v2 c</verseOrder>
    <comments><comment>From the 1909 hymnal</comment></comments>
  </properties>
  <lyrics>${body}</lyrics>
</song>`;

describe("OpenLyrics", () => {
  test("lines by <br/> and not by indentation; each <lines> a slide; parts of a verse are one section", () => {
    const song = readOpenLyrics(
      openLyrics(`
    <verse name="v1a">
      <lines>
        <chord name="C"/>Sublime <chord name="C7"/>gracia del Se<chord name="F"/>ñor<br/>
        que a un infeliz salvó
      </lines>
      <lines><comment>softly</comment>Fui ciego mas hoy veo yo</lines>
    </verse>
    <verse name="v1b"><lines>Perdido y Él me halló</lines></verse>
    <verse name="c"><lines><chord root="G" structure="dom7">A</chord>leluya</lines></verse>
    <verse name="v2"><lines>Su gracia me enseñó a temer</lines></verse>`),
    );
    expect(song).not.toBeNull();
    expect(slidesOf(song!.sections)).toEqual([
      ["v1", [["Sublime gracia del Señor", "que a un infeliz salvó"], ["Fui ciego mas hoy veo yo"], ["Perdido y Él me halló"]]],
      ["c1", [["Aleluya"]]],
      ["v2", [["Su gracia me enseñó a temer"]]],
    ]);
    expect(song!.sections[0]?.slides[0]?.chords).toEqual([
      [
        { at: 0, name: "C" },
        { at: 8, name: "C7" },
        { at: 21, name: "F" },
      ],
      [],
    ]);
    expect(song!.sections[1]?.slides[0]?.chords).toEqual([[{ at: 0, name: "G7" }]]);
    expect(song).toMatchObject({
      title: "Sublime gracia",
      authors: "John Newton",
      copyright: "Public Domain",
      ccliNumber: "22025",
      number: "230",
      notes: "From the 1909 hymnal",
      order: ["v1", "c1", "v2", "c1"],
    });
  });

  test("the first language is the lyrics, the second the translation", () => {
    const song = readOpenLyrics(
      openLyrics(`
    <verse name="v1" lang="es"><lines>Sublime gracia</lines><lines>Fui ciego</lines></verse>
    <verse name="v1" lang="en"><lines>Amazing grace</lines><lines>Was blind</lines></verse>
    <verse name="c" lang="es"><lines>Aleluya</lines></verse>`),
    );
    expect(song!.sections.map((section) => section.slides)).toEqual([
      [
        { lines: ["Sublime gracia"], translation: ["Amazing grace"] },
        { lines: ["Fui ciego"], translation: ["Was blind"] },
      ],
      [{ lines: ["Aleluya"] }],
    ]);
  });

  test("files: one without lyrics is a problem, one not XML no song file at all; the rest come in once", () => {
    const good = path.join(tmpDir, "gracia.xml");
    const empty = path.join(tmpDir, "empty.xml");
    const broken = path.join(tmpDir, "broken.xml");
    fs.writeFileSync(good, openLyrics(`<verse name="v1"><lines>Sublime gracia del Señor</lines></verse>`));
    fs.writeFileSync(empty, openLyrics(""));
    fs.writeFileSync(broken, "<song><lyrics><verse");
    expect(importOpenLyricsFiles([good, empty, broken])).toEqual({ imported: 1, repeated: 0, problems: 1, unsupported: 1 });
    expect(importOpenLyricsFiles([good])).toEqual({ imported: 0, repeated: 1, problems: 0, unsupported: 0 });
  });

  test("0.9 chords keep their kind: shortcode or formula, bass included; an unknown one keeps its root", () => {
    const song = readOpenLyrics(
      `<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.9"><properties><titles><title>Acordes</title></titles></properties>` +
        `<lyrics><verse name="v1"><lines><chord root="A" structure="min7"/>Uno <chord root="D" structure="dom7" bass="F#"/>dos ` +
        `<chord root="E" structure="m3-5"/>tres <chord root="G" structure="sus4"/>cuatro <chord root="C" structure="m3-5-7-9-a11-13"/>cinco` +
        `</lines></verse></lyrics></song>`,
    );
    expect(song?.sections[0]?.slides[0]?.chords?.[0]?.map((chord) => chord.name)).toEqual(["Am7", "D7/F#", "Em", "Gsus4", "C"]);
  });

  test("files read in the encoding they declare or carry, never as � (the HASD hymnal, 2026-11-05)", () => {
    const song = (title: string, line: string, encoding: string) =>
      `<?xml version='1.0' encoding='${encoding}'?><song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8">` +
      `<properties><titles><title>${title}</title></titles></properties>` +
      `<lyrics><verse name="v1"><lines>${line}</lines></verse></lyrics></song>`;
    // Windows-1251 by hand: А..я are 0xC0..0xFF, ASCII is itself.
    const cp1251 = (text: string) =>
      Buffer.from([...text].map((c) => (c.charCodeAt(0) >= 0x410 ? 0xc0 + c.charCodeAt(0) - 0x410 : c.charCodeAt(0))));
    const files = Object.entries({
      // OpenLP 2.0's own export: declared and written as Windows-1252.
      "hasd.xml": Buffer.from(song("1 - Ó Deus de Amor", "vimos nós", "windows-1252"), "latin1"),
      "russian.xml": cp1251(song("Аминь", "Слава Богу", "windows-1251")),
      "chinese.xml": Buffer.from(song("奇异恩典", "何等甘甜 🙏", "utf-8"), "utf8"),
      "greek.xml": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(song("Ἀμήν", "Ἀλληλούια", "utf-16"), "utf16le")]),
      // Says UTF-8 and is not: an editor saved Latin-1 and kept the declaration.
      "lying.xml": Buffer.from(song("Canción", "Señor", "utf-8"), "latin1"),
    }).map(([name, bytes]) => {
      const file = path.join(tmpDir, name);
      fs.writeFileSync(file, bytes);
      return file;
    });
    const read = readOpenLyricsFiles(files);
    expect(read.problems).toBe(0);
    expect(read.songs.map((s) => [s.title, s.sections[0]?.slides[0]?.lines[0]])).toEqual([
      ["1 - Ó Deus de Amor", "vimos nós"],
      ["Аминь", "Слава Богу"],
      ["奇异恩典", "何等甘甜 🙏"],
      ["Ἀμήν", "Ἀλληλούια"],
      ["Canción", "Señor"],
    ]);
  });
});

describe("OpenLyrics: languages and text kept as written (2026-11-06)", () => {
  const xml = (verses: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8"><properties><titles><title>T</title></titles></properties><lyrics>${verses}</lyrics></song>`;
  const lines = (sections: readonly { slides: { lines: string[] }[] }[] | undefined) =>
    (sections ?? []).flatMap((section) => section.slides.flatMap((slide) => slide.lines));

  test("a verse without `lang` is the lyrics', not a third language dropped", () => {
    const read = readOpenLyrics(
      xml(`<verse name="v1" lang="es"><lines>Primera estrofa</lines></verse><verse name="c1"><lines>El coro sin idioma</lines></verse><verse name="v2" lang="es"><lines>Segunda estrofa</lines></verse>`),
    );
    expect(lines(read?.sections)).toEqual(["Primera estrofa", "El coro sin idioma", "Segunda estrofa"]);
  });

  test("`en` and `en-US` are one language", () => {
    const read = readOpenLyrics(xml(`<verse name="v1" lang="en"><lines>Verse one</lines></verse><verse name="v2" lang="en-US"><lines>Verse two</lines></verse>`));
    expect(lines(read?.sections)).toEqual(["Verse one", "Verse two"]);
  });

  test("a transliteration is never projected; a section only the translation has comes in as lyrics", () => {
    const read = readOpenLyrics(
      xml(
        `<verse name="v1" lang="he"><lines>הבה נגילה</lines></verse><verse name="v1" lang="he" translit="en"><lines>Hava nagila</lines></verse>` +
          `<verse name="v1" lang="en"><lines>Let's rejoice</lines></verse><verse name="e" lang="en"><lines>The end</lines></verse>`,
      ),
    );
    expect(read?.sections.map((section) => [section.key, section.slides])).toEqual([
      ["v1", [{ lines: ["הבה נגילה"], translation: ["Let's rejoice"] }]],
      ["e1", [{ lines: ["The end"] }]],
    ]);
  });

  test("a <br/> ends a line: OpenLP's after the last one is no line, two in a row an empty line; chords alone are a line (review 2026-11-06)", () => {
    const read = readOpenLyrics(
      xml(
        `<verse name="i1"><lines><chord name="G"/> <chord name="D"/></lines></verse>` +
          `<verse name="v1"><lines>\n  Uno<br/>\n  <br/>\n  dos<br/>\n</lines><lines>Tres<br/></lines></verse>`,
      ),
    );
    expect(read?.sections.map((section) => [section.key, section.slides.map((slide) => slide.lines)])).toEqual([
      ["i1", [[""]]],
      ["v1", [["Uno", "", "dos"], ["Tres"]]],
    ]);
    expect(read?.sections[0]?.slides[0]?.chords).toEqual([[{ at: 0, name: "G" }, { at: 0, name: "D" }]]);
  });

  test("a <comment> alone on its line is no line, not an empty one (review 2026-11-06)", () => {
    const read = readOpenLyrics(
      xml(`<verse name="c"><lines><comment>any comment</comment><br/>Line content.</lines></verse>` +
        `<verse name="v1"><lines>Uno<br/><comment>softly</comment><br/>dos<br/><br/></lines></verse>`),
    );
    expect(read?.sections.map((section) => section.slides.map((slide) => slide.lines))).toEqual([
      [["Line content."]],
      [["Uno", "dos", ""]],
    ]);
  });

  test("an ideographic space inside a line stays; a chord written the Central-European way ([Ami]) is a chord", () => {
    const read = readOpenLyrics(xml(`<verse name="v1"><lines>いつくしみ深き\u3000友なるイエスは<br/>Všemoh[Ami]úci [G]Boh</lines></verse>`));
    expect(read?.sections[0]?.slides[0]?.lines).toEqual(["いつくしみ深き　友なるイエスは", "Všemohúci Boh"]);
  });
});
