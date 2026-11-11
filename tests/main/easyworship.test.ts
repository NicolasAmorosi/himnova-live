/**
 * EasyWorship 6/7's song database, written here the way EasyWorship writes it
 * (the schema of OpenLP's test files): RTF lyrics read into sections and an
 * order, the import's duplicates, and a folder picked one level too high.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { getSongsRepo, initRepos } from "../../src/main/services/repos";
import { importEasyWorshipFolder } from "../../src/main/services/song-import";
import { findEasyWorshipData, readEasyWorship } from "../../src/main/songs/easyworship";
import { rtfToText } from "../../src/main/songs/rtf";
import { IpcError } from "../../src/shared/ipc/result";

const drizzleDir = path.join(process.cwd(), "drizzle");

/** EasyWorship's RTF around `body`: the font and colour tables and the
 *  `{\*\pnseclvl…}` groups it always writes, none of which is text. */
function rtf(body: string): string {
  return [
    "{\\rtf1\\ansi\\ansicpg1252\\deff0\\deftab254{\\fonttbl{\\f0\\fnil\\fcharset1 Arial;}}",
    "{\\colortbl\\red0\\green0\\blue0;\\red255\\green0\\blue0;}\\paperw12240\\paperh15840",
    "{\\*\\pnseclvl1\\pnucrm\\pnstart1\\pnhang\\pnindent720{\\pntxtb}{\\pntxta{.}}}",
    "{\\pard\\li0\\fi0\\ri0\\sb0\\sl\\sa0 \\plain\\f0\\fntnamaut " +
      body.split("\n").join("\\par\n\\li0\\fi0\\ri0\\sb0\\sl\\sa0 \\plain\\f0\\fntnamaut ") +
      "}",
    "}",
  ].join("\n");
}

type Row = { title: string; author?: string; copyright?: string; reference?: string; vendor?: number; words: string };

function writeEasyWorship(folder: string, rows: Row[]): void {
  fs.mkdirSync(folder, { recursive: true });
  const songs = new Database(path.join(folder, "Songs.db"));
  songs.exec(`CREATE TABLE song ("rowid" integer PRIMARY KEY AUTOINCREMENT NOT NULL UNIQUE, song_item_uid text UNIQUE,
    song_rev_uid text, song_uid text, title text NOT NULL COLLATE NOCASE, author text COLLATE NOCASE,
    copyright text COLLATE NOCASE, administrator text COLLATE NOCASE, description text, tags text,
    reference_number text, vendor_id integer, presentation_id integer, layout_revision integer DEFAULT 1,
    revision integer DEFAULT 1)`);
  const words = new Database(path.join(folder, "SongWords.db"));
  words.exec(`CREATE TABLE word ("rowid" integer PRIMARY KEY NOT NULL UNIQUE, song_id integer, words rtf,
    slide_uids text, slide_layout_revisions int64a, slide_revisions int64a)`);
  rows.forEach((row, i) => {
    songs
      .prepare("INSERT INTO song (rowid, title, author, copyright, reference_number, vendor_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(i + 1, row.title, row.author ?? null, row.copyright ?? null, row.reference ?? null, row.vendor ?? 0);
    words.prepare("INSERT INTO word (song_id, words) VALUES (?, ?)").run(i + 1, row.words);
  });
  songs.close();
  words.close();
}

let tmpDir: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-ew-"));
  const opened = openDatabase(path.join(tmpDir, "library.db"));
  sqlite = opened.sqlite;
  runMigrations(opened.db, drizzleDir);
  initRepos(opened.db, sqlite);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("RTF", () => {
  test("text only: tables, {\\*…} groups and formatting words are not text", () => {
    expect(rtfToText(rtf("Verse 1\nAmazing grace"))).toBe("Verse 1\nAmazing grace");
  });

  test("\\uN carries a character and skips its fallback; \\'xx is a byte of the code page", () => {
    expect(rtfToText("{\\rtf1 Vi pl\\u248?jed og vi s\\u229?'de}")).toBe("Vi pløjed og vi så'de");
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg1252 Se\\'f1or, \\'bfqui\\'e9n?}")).toBe("Señor, ¿quién?");
    expect(rtfToText("{\\rtf1 \\u-3913?}")).toBe(String.fromCharCode(65_536 - 3913));
    expect(rtfToText("{\\rtf1 a\\{b\\}c\\\\d\\tab e}")).toBe("a{b}c\\d\te");
  });
});

describe("the EasyWorship database", () => {
  const data = () => path.join(tmpDir, "Default", "v6.1", "Databases", "Data");

  test("lyrics become sections and the repeated chorus the order", () => {
    writeEasyWorship(data(), [
      {
        title: "Sublime gracia",
        author: "John Newton",
        copyright: "Dominio público",
        reference: "22025",
        words: rtf("Verse 1\nSublime gracia del Se\\'f1or\n\nChorus\nAleluya\n\nVerse 2\nFui ciego\n\nChorus\nAleluya"),
      },
      // A song with nothing under it is counted, never written half.
      { title: "Vacía", words: rtf("") },
      { title: "Coro en español", reference: "Den Danske", words: rtf("Coro\nGloria\n\nEstrofa 1\nuno") },
    ]);
    const { problems, songs } = readEasyWorship(data(), "es");
    expect(problems).toBe(1);
    expect(songs.map((s) => s.title)).toEqual(["Sublime gracia", "Coro en español"]);
    const [gracia, coro] = songs;
    expect(gracia!.sections.map((s) => s.key)).toEqual(["v1", "c1", "v2"]);
    expect(gracia!.sections[0]!.slides[0]!.lines).toEqual(["Sublime gracia del Señor"]);
    expect(gracia!.order).toEqual(["v1", "c1", "v2", "c1"]);
    expect(gracia!.ccliNumber).toBe("22025");
    // «Den Danske» is no CCLI number.
    expect(coro!.ccliNumber).toBeNull();
    expect(coro!.sections.map((s) => s.key)).toEqual(["c1", "v1"]);
  });

  test("a folder above Databases/Data is found; one without the files is refused", () => {
    expect(findEasyWorshipData(path.join(tmpDir, "Default", "v6.1"))).toBe(data());
    expect(findEasyWorshipData(data())).toBe(data());
    expect(() => importEasyWorshipFolder(tmpDir)).toThrow(IpcError);
  });

  test("importing twice skips what is already there; the same title with other words comes in", async () => {
    expect(await importEasyWorshipFolder(path.join(tmpDir, "Default"))).toEqual({ imported: 2, repeated: 0, problems: 1, unsupported: 0 });
    expect(await importEasyWorshipFolder(data())).toEqual({ imported: 0, repeated: 2, problems: 1, unsupported: 0 });

    const other = path.join(tmpDir, "Other", "Databases", "Data");
    writeEasyWorship(other, [{ title: "Sublime gracia", words: rtf("Verse 1\notra versión") }]);
    expect(await importEasyWorshipFolder(other)).toEqual({ imported: 1, repeated: 0, problems: 0, unsupported: 0 });
    expect(getSongsRepo().search("version").length).toBe(1);
    expect(getSongsRepo().list().filter((s) => s.title === "Sublime gracia")).toHaveLength(2);
  });

  test("a database that will not open says so", async () => {
    const broken = path.join(tmpDir, "Broken");
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, "Songs.db"), "not a database");
    fs.writeFileSync(path.join(broken, "SongWords.db"), "not a database");
    try {
      await importEasyWorshipFolder(broken);
      throw new Error("expected EW_UNREADABLE");
    } catch (error) {
      expect((error as IpcError).code).toBe("EW_UNREADABLE");
    }
  });
});
