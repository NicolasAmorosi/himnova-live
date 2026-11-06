/**
 * Songs on the main side: the validator/normalizer pairs, the repo and its
 * accent-blind search, migration 0019's CHECK and FKs, a song as an
 * order-of-service row (saved, drafted, force-deleted), the history counting a
 * song once, and the default theme seeded once from the verse's look.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { SongsRepo } from "../../src/main/db/repositories/songs.repo";
import { ProgramsRepo } from "../../src/main/db/repositories/programs.repo";
import { DraftRepo } from "../../src/main/db/repositories/draft.repo";
import { HistoryRepo } from "../../src/main/db/repositories/history.repo";
import { SettingsRepo } from "../../src/main/db/repositories/settings.repo";
import { seedSongThemes } from "../../src/main/db/seed/seed-song-themes";
import { decodeText } from "../../src/main/decode-text";
import { getSongsRepo, initRepos } from "../../src/main/services/repos";
import { listSongFolder, writeSongFile } from "../../src/main/services/song-files";
import { importSongFiles } from "../../src/main/services/song-import";
import { removeSong } from "../../src/main/services/song-removal";
import { readOpenLyrics } from "../../src/main/songs/openlp";
import { readSongText } from "../../src/main/songs/text-files";
import {
  isSongTheme,
  isSongUpsert,
  normalizeOrder,
  normalizeSections,
  normalizeSongTheme,
  songProblem,
} from "../../src/shared/song-validators";
import { parseLyrics, splitSection, withTranslation, writtenLines } from "../../src/shared/song-text";
import {
  DEFAULT_SONG_THEME,
  songFooterLines,
  songThemeFromBibleStyle,
  type Song,
  type SongUpsert,
} from "../../src/shared/types/song";
import { isSongThemeUpsert } from "../../src/shared/song-validators";
import { DEFAULT_BIBLE_STYLE } from "../../src/shared/types/bible-style";
import { INSTANT_TRANSITION, type ProjectionOutput } from "../../src/shared/types/projection";
import { IpcError } from "../../src/shared/ipc/result";

const drizzleDir = path.join(process.cwd(), "drizzle");

let tmpDir: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];
let db: ReturnType<typeof openDatabase>["db"];
let repo: SongsRepo;
let programs: ProgramsRepo;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-songs-"));
  const opened = openDatabase(path.join(tmpDir, "songs.db"));
  sqlite = opened.sqlite;
  db = opened.db;
  runMigrations(db, drizzleDir);
  initRepos(db, sqlite);
  repo = getSongsRepo();
  programs = new ProgramsRepo(db, sqlite);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function song(title: string, lyrics: string, overrides: Partial<SongUpsert> = {}): Omit<SongUpsert, "id"> {
  return {
    title,
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: parseLyrics(lyrics, "es").sections,
    order: [],
    themeId: null,
    ...overrides,
  };
}

describe("the song validator", () => {
  test("accepts a parsed song", () => {
    expect(isSongUpsert(song("Sublime gracia", "[Estrofa 1]\nSublime gracia\n\n[Coro]\nAleluya"))).toBe(true);
    expect(isSongUpsert({ ...song("A", "a"), order: ["v1", "c9"] })).toBe(true);
  });

  test("a song needs a title, a slide that says something and keys that match", () => {
    expect(isSongUpsert(song("  ", "a"))).toBe(false);
    expect(isSongUpsert(song("A", ""))).toBe(false);
    const [section] = parseLyrics("[Coro]\nc", "es").sections;
    expect(isSongUpsert({ ...song("A", "a"), sections: [{ ...section!, key: "v1" }] })).toBe(false);
    expect(isSongUpsert({ ...song("A", "a"), sections: [section!, section!] })).toBe(false);
    expect(isSongUpsert({ ...song("A", "a"), sections: [{ ...section!, slides: [{ lines: ["  "] }] }] })).toBe(false);
    expect(isSongUpsert({ ...song("A", "a"), order: ["coro"] })).toBe(false);
  });

  test("a slide of chords alone is a slide (owner, 2026-11-06); chords out of order are not", () => {
    expect(isSongUpsert(song("Preludio", "[Intro]\n[G] [D] [Em] [C]\n\n[Estrofa 1]\n[G]Sublime gracia"))).toBe(true);
    // QA 2026-11-06: written back, they repeated the words between them into the file.
    const slide = { lines: ["Hello world"], chords: [[{ at: 5, name: "A" }, { at: 2, name: "B" }]] };
    expect(writtenLines(slide)).toEqual(["Hello[A][B]llo world"]);
    expect(isSongUpsert({ ...song("T", "x"), sections: [{ key: "v1", type: "verse", number: 1, slides: [slide] }] })).toBe(false);
  });

  test("says which limit a song breaks, so the editor can name it", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
    expect(songProblem(song("A", "[Estrofa 1]\nuno"))).toBeNull();
    expect(songProblem(song(" ", "uno"))).toEqual({ kind: "basic" });
    expect(songProblem(song("A", ""))).toEqual({ kind: "basic" });
    // A whole song pasted as one block is stored; past 200 lines it is not.
    expect(songProblem(song("A", `[Estrofa 1]\n${lines(200)}`))).toBeNull();
    expect(songProblem(song("A", `[Estrofa 1]\n${lines(201)}`))).toEqual({ kind: "lines", max: 200, section: "v1" });
    expect(songProblem(song("A", `[Coro]\n${"a".repeat(501)}`))).toEqual({ kind: "lineLength", max: 500, section: "c1" });
    expect(songProblem(song("A", `[Coro]\n${lines(41).replaceAll("\n", "\n\n")}`))).toEqual({ kind: "slides", max: 40, section: "c1" });
    const sections = Array.from({ length: 61 }, (_, i) => `[Estrofa ${i + 1}]\nv${i}`).join("\n\n");
    expect(songProblem(song("A", sections))).toEqual({ kind: "sections", max: 60 });
    expect(songProblem(song("A", "[Coro]\n[Gmaj7sus4add9b13/F#]x"))).toEqual({ kind: "chord", max: 16, section: "c1" });
    expect(songProblem({ ...song("A", "x"), order: Array(201).fill("v1") })).toEqual({ kind: "order", max: 200 });
  });

  test("a stored row is read field by field: a broken section costs that section", () => {
    const good = parseLyrics("[Estrofa 1]\na\n[Coro]\nc", "es").sections;
    expect(normalizeSections([good[0], { key: "x" }, good[1], good[0]])).toEqual(good);
    expect(normalizeSections("nope")).toEqual([]);
    expect(normalizeOrder(["v1", 3, "zz", "c1"])).toEqual(["v1", "c1"]);
  });

  test("whatever the theme normalizer returns passes the theme validator", () => {
    for (const input of [null, {}, { text: { sizeCqw: 999 } }, { ...DEFAULT_SONG_THEME, lineHeight: 9 }]) {
      expect(isSongTheme(normalizeSongTheme(input))).toBe(true);
    }
    expect(isSongTheme(songThemeFromBibleStyle(DEFAULT_BIBLE_STYLE))).toBe(true);
    expect(normalizeSongTheme({ ...DEFAULT_SONG_THEME, minSizeCqw: -1 }).minSizeCqw).toBe(DEFAULT_SONG_THEME.minSizeCqw);
  });

  test("a song theme takes a video background; a broken one falls back to the default", () => {
    const video = { kind: "video", assetId: 4, fit: "cover" } as const;
    expect(isSongTheme({ ...DEFAULT_SONG_THEME, background: video })).toBe(true);
    expect(normalizeSongTheme({ ...DEFAULT_SONG_THEME, background: video }).background).toEqual(video);
    for (const broken of [{ ...video, assetId: 0 }, { ...video, fit: "stretch" }, { kind: "video" }]) {
      expect(isSongTheme({ ...DEFAULT_SONG_THEME, background: broken })).toBe(false);
      expect(normalizeSongTheme({ ...DEFAULT_SONG_THEME, background: broken }).background).toEqual(DEFAULT_SONG_THEME.background);
    }
  });
});

describe("the repo and its search", () => {
  let gracia: number;

  test("create, read back, update and duplicate", () => {
    const created = repo.create(
      song("Sublime gracia", "[Estrofa 1]\nSublime gracia del Señor\n\n[Coro]\nAleluya", {
        number: " 230 ",
        authors: "John Newton",
        notes: "   ",
      }),
    );
    gracia = created.id;
    expect(created.number).toBe("230");
    expect(created.notes).toBeNull();
    expect(repo.get(gracia)?.sections.map((s) => s.key)).toEqual(["v1", "c1"]);

    const updated = repo.update(gracia, { ...song("Sublime gracia", "[Coro]\notra"), number: "230" });
    expect(updated.sections.map((s) => s.key)).toEqual(["c1"]);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    repo.update(gracia, song("Sublime gracia", "[Estrofa 1]\nSublime gracia del Señor\n\n[Coro]\nAleluya", {
      number: "230",
      authors: "John Newton",
    }));

    const copy = repo.duplicate(gracia, "Sublime gracia (copia)");
    expect(copy.id).not.toBe(gracia);
    expect(copy.sections).toEqual(repo.get(gracia)?.sections);
    repo.delete(copy.id);
  });

  test("finds by lyrics without accents, by number and by author, the lyrics fragment marked", () => {
    repo.create(song("Cuán grande es Él", "[Coro]\nMi corazón entona la canción"));
    const byLyrics = repo.search("senor");
    expect(byLyrics.map((h) => h.songId)).toEqual([gracia]);
    expect(byLyrics[0]!.snippet).toContain("\u0001Señor\u0002");
    expect(repo.search("230").map((h) => h.songId)).toEqual([gracia]);
    expect(repo.search("newton").map((h) => h.songId)).toEqual([gracia]);
    expect(repo.search("corazon").length).toBe(1);
  });

  test("a match in the title only has no lyrics fragment; an edit re-indexes", () => {
    const [hit] = repo.search("grande");
    expect(hit).toBeDefined();
    expect(hit!.snippet).toBeNull();
    repo.update(gracia, { ...song("Sublime gracia", "[Coro]\npalabra nueva"), number: "230" });
    expect(repo.search("señor")).toEqual([]);
    expect(repo.search("nueva").map((h) => h.songId)).toEqual([gracia]);
  });

  test("a pathological query answers nothing instead of throwing", () => {
    expect(repo.search('"')).toEqual([]);
    expect(repo.search("   ")).toEqual([]);
  });
});

describe("migration 0019", () => {
  test("the CHECK knows the song kind and nothing else may carry a song", () => {
    const programId = programs.save({ name: "Check", items: [] }).id;
    const insert = (kind: string, songId: number | null, mediaAssetId: number | null) =>
      sqlite
        .prepare(
          "INSERT INTO program_items (program_id, position, kind, song_id, media_asset_id, created_at) VALUES (?, 0, ?, ?, ?, 0)",
        )
        .run(programId, kind, songId, mediaAssetId);
    const someSong = repo.list()[0]!.id;
    expect(() => insert("song", null, null)).toThrow(/CHECK/);
    expect(() => insert("utility", someSong, null)).toThrow(/CHECK/);
    expect(() => insert("song", someSong, null)).not.toThrow();
    programs.delete(programId);
  });

  test("deleting a theme leaves its songs on the default one", () => {
    const theme = repo.createTheme("Jóvenes", DEFAULT_SONG_THEME);
    const dressed = repo.create(song("Con tema", "a", { themeId: theme.id }));
    sqlite.prepare("DELETE FROM song_themes WHERE id = ?").run(theme.id);
    expect(repo.get(dressed.id)?.themeId).toBeNull();
    repo.delete(dressed.id);
  });
});

describe("a song in the order of service", () => {
  test("saved and read back by reference", () => {
    const songId = repo.create(song("En el programa", "a")).id;
    const saved = programs.save({ name: "Domingo", items: [{ kind: "song", songId, title: null }] });
    expect(programs.peek(saved.id).items).toEqual([
      expect.objectContaining({ kind: "song", songId, title: null }),
    ]);
    expect(programs.findSongUsages(songId)).toEqual([{ programId: saved.id, programName: "Domingo", itemCount: 1 }]);
  });

  test("a song a program sings is refused, and force removes its rows with it", () => {
    const songId = repo.list().find((s) => s.title === "En el programa")!.id;
    try {
      repo.delete(songId);
      throw new Error("expected SONG_IN_USE");
    } catch (error) {
      expect(error).toBeInstanceOf(IpcError);
      expect((error as IpcError).code).toBe("SONG_IN_USE");
    }
    removeSong(songId, true);
    expect(repo.get(songId)).toBeNull();
    expect(programs.findSongUsages(songId)).toEqual([]);
  });

  test("the draft drops a song that is gone", () => {
    const drafts = new DraftRepo(db);
    const kept = repo.create(song("Queda", "a")).id;
    drafts.save({
      programId: null,
      name: "Borrador",
      notes: null,
      items: [
        { kind: "song", songId: kept, title: null },
        { kind: "song", songId: 999_999, title: null },
      ],
      updatedAt: 1,
    });
    expect(drafts.load()?.items).toEqual([{ kind: "song", songId: kept, title: null }]);
    drafts.clear();
  });
});

describe("the history", () => {
  test("counts a song once, however many slides it shows", () => {
    const history = new HistoryRepo(db);
    const before = history.recent(500).length;
    const slide = (songId: number, line: string): ProjectionOutput => ({
      kind: "song",
      songId,
      title: `Canción ${songId}`,
      lines: [line],
      translation: null,
      footer: null,
      theme: DEFAULT_SONG_THEME,
      backgroundUrl: null,
      sizeCqw: 5,
      enter: null,
      videoUnderlay: null,
      slideVideo: null,
      plates: [],
      transition: INSTANT_TRANSITION,
    });
    history.record(slide(1, "a"), null);
    history.record(slide(1, "b"), null);
    history.record(slide(1, "c"), null);
    history.record(slide(2, "a"), null);
    const rows = history.recent(500).slice(0, history.recent(500).length - before);
    expect(rows.map((row) => [row.kind, row.reference])).toEqual([
      ["song", "Canción 2"],
      ["song", "Canción 1"],
    ]);
  });
});

describe("the default theme", () => {
  test("is the verse's look at a singer's size, written once", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "worship-songs-seed-"));
    const opened = openDatabase(path.join(fresh, "seed.db"));
    try {
      runMigrations(opened.db, drizzleDir);
      const settings = new SettingsRepo(opened.db);
      const songs = new SongsRepo(opened.db, opened.sqlite);
      const verse = { ...DEFAULT_BIBLE_STYLE, background: { kind: "solid" as const, color: "#123456" } };
      settings.setMany({ "bible.style": verse });
      seedSongThemes(songs, settings);
      seedSongThemes(songs, settings);
      const themes = songs.listThemes();
      expect(themes).toHaveLength(1);
      expect(themes[0]!.style.background).toEqual(verse.background);
      expect(themes[0]!.style.text.sizeCqw).toBe(6);
      expect(themes[0]!.style.minSizeCqw).toBe(2.5);
      // Deleting it is deleting it: the flag keeps it from coming back.
      opened.sqlite.prepare("DELETE FROM song_themes").run();
      seedSongThemes(songs, settings);
      expect(songs.listThemes()).toHaveLength(0);
    } finally {
      opened.sqlite.close();
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("themes (F3)", () => {
  test("a theme stored before the F3 knobs reads them at their defaults", () => {
    const { uppercase: _u, outline: _o, footer: _f, slideTransition: _s, maxLines: _m, letterSpacingEm: _l, ...f1 } =
      DEFAULT_SONG_THEME;
    const read = normalizeSongTheme({ ...f1, background: { kind: "solid", color: "#112233" } });
    expect(read.background).toEqual({ kind: "solid", color: "#112233" });
    expect(read.footer).toEqual(DEFAULT_SONG_THEME.footer);
    expect(read.slideTransition).toEqual({ style: "fade", durationMs: 300 });
    expect(isSongTheme(read)).toBe(true);
  });

  test("a broken knob costs that knob, field by field", () => {
    const read = normalizeSongTheme({
      ...DEFAULT_SONG_THEME,
      footer: { ...DEFAULT_SONG_THEME.footer, show: "sometimes", fields: { title: false, authors: "yes" } },
      outline: { enabled: true, color: "red", widthCqw: 0.3 },
      maxLines: 2.5,
    });
    expect(read.footer.show).toBe("last");
    expect(read.footer.fields).toEqual({ ...DEFAULT_SONG_THEME.footer.fields, title: false });
    expect(read.outline).toEqual({ enabled: true, color: "#000000", widthCqw: 0.3 });
    expect(read.maxLines).toBe(0);
    expect(isSongThemeUpsert({ name: "Jóvenes", style: read })).toBe(true);
    expect(isSongThemeUpsert({ name: " ", style: read })).toBe(false);
  });

  test("lines per slide split a slide when drawn, never the stored one", () => {
    const [section] = parseLyrics("[Coro]\nuno\ndos\ntres\ncuatro\ncinco", "es").sections;
    expect(splitSection(section!, 2).slides.map((s) => s.lines)).toEqual([["uno", "dos"], ["tres", "cuatro"], ["cinco"]]);
    expect(splitSection(section!, 0)).toBe(section);
  });

  test("the footer says what the song has, two lines at most", () => {
    const labels = { ccli: "CCLI n.º", license: "Licencia CCLI n.º" };
    const all = DEFAULT_SONG_THEME.footer.fields;
    expect(
      songFooterLines({ title: "Sublime gracia", authors: "John Newton", copyright: "© Dominio público", ccliNumber: "22025" }, all, "123", labels),
    ).toEqual(["Sublime gracia — John Newton", "© Dominio público · CCLI n.º 22025 · Licencia CCLI n.º 123"]);
    expect(songFooterLines({ title: "Sin datos", authors: null, copyright: null, ccliNumber: null }, all, null, labels)).toEqual([
      "Sin datos",
    ]);
  });

  test("the repo updates a theme and never deletes the last one", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "worship-songs-themes-"));
    const opened = openDatabase(path.join(fresh, "themes.db"));
    try {
      runMigrations(opened.db, drizzleDir);
      const songs = new SongsRepo(opened.db, opened.sqlite);
      const a = songs.createTheme("A", DEFAULT_SONG_THEME);
      const b = songs.createTheme("B", DEFAULT_SONG_THEME);
      expect(songs.listThemes().map((t) => t.name)).toEqual(["A", "B"]);
      expect(songs.updateTheme(b.id, "Bis", { ...DEFAULT_SONG_THEME, uppercase: true }).style.uppercase).toBe(true);
      const dressed = songs.create(song("Con B", "a", { themeId: b.id }));
      songs.deleteTheme(b.id);
      expect(songs.get(dressed.id)?.themeId).toBeNull();
      expect(() => songs.deleteTheme(a.id)).toThrow(IpcError);
    } finally {
      opened.sqlite.close();
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("a linked folder of song files (owner, 2026-11-05)", () => {
  test("its files read into songs; the library and the folder are searched apart; a changed file updates in place", async () => {
    const { listSongFolder } = await import("../../src/main/services/song-files");
    const { importSongFiles } = await import("../../src/main/services/song-import");
    const folder = fs.mkdtempSync(path.join(tmpDir, "linked-"));
    fs.writeFileSync(path.join(folder, "uno.cho"), "{title: Roca eterna}\n{start_of_verse}\nRoca de la eternidad\n{end_of_verse}\n");
    fs.writeFileSync(
      path.join(folder, "dos.txt"),
      "Santo santo santo\n\nVerse 1\nSanto santo santo\n\nReginald Heber\nCCLI Song # 1156\n© Public Domain\n",
    );
    fs.writeFileSync(path.join(folder, "notas.md"), "not a song");

    const listed = await listSongFolder(folder);
    expect(listed.map((song) => song.title).sort()).toEqual(["Roca eterna", "Santo santo santo"]);
    expect(listed.every((song) => song.sourceFolder === folder)).toBe(true);
    const roca = listed.find((song) => song.title === "Roca eterna")!;
    expect(repo.search("roca", 200, folder).map((hit) => hit.songId)).toEqual([roca.id]);
    expect(repo.search("roca").map((hit) => hit.songId)).not.toContain(roca.id);

    // Imported into the library, the same song is not a repeat of the folder's.
    expect(importSongFiles([path.join(folder, "uno.cho")])).toEqual({ imported: 1, repeated: 0, problems: 0, unsupported: 0 });

    // Edited outside the app: read again, same row.
    const file = path.join(folder, "uno.cho");
    fs.writeFileSync(file, "{title: Roca de los siglos}\n{start_of_verse}\nRoca de la eternidad\n{end_of_verse}\n");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const again = await listSongFolder(folder);
    expect(again.find((song) => song.id === roca.id)?.title).toBe("Roca de los siglos");
  });

  test("a song of a file is saved into its file, and a file changed since is not overwritten", async () => {
    const { listSongFolder, writeSongFile } = await import("../../src/main/services/song-files");
    const folder = fs.mkdtempSync(path.join(tmpDir, "linked-"));
    const file = path.join(folder, "gracia.cho");
    fs.writeFileSync(file, "{title: Sublime gracia}\n{start_of_verse}\nSublime gracia del Señor\n{end_of_verse}\n");
    const [gracia] = await listSongFolder(folder);
    const { id, updatedAt: _u, sourceFolder: _s, file: _f, ...edited } = { ...gracia!, title: "Sublime gracia (2)" };
    // What `song:update` does: the file first, then the row.
    writeSongFile(id, edited);
    repo.update(id, edited);
    expect(fs.readFileSync(file, "utf8")).toContain("Sublime gracia (2)");
    expect((await listSongFolder(folder))[0]?.title).toBe("Sublime gracia (2)");

    fs.utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    expect(() => writeSongFile(id, { ...edited, title: "Sublime gracia (3)" })).toThrow(
      expect.objectContaining({ code: "SONG_FILE_CHANGED" }),
    );
    // A song that lives only in the app has no file to write.
    const only = repo.create(song("Biblioteca", "[Estrofa 1]\nuna línea"));
    expect(only.file).toBeNull();
    expect(() => writeSongFile(only.id, edited)).not.toThrow();
  });
});

describe("a song imported from a song file stays tied to it (owner, 2026-11-05)", () => {
  /** What `song:update` does: the file first, then the row. */
  async function save(id: number, change: (song: Song) => Song): Promise<Song> {
    const { writeSongFile } = await import("../../src/main/services/song-files");
    const { id: _id, updatedAt: _u, sourceFolder: _s, file: _f, ...edited } = change(repo.get(id)!);
    writeSongFile(id, edited);
    return repo.update(id, edited);
  }
  const titled = (title: string) => repo.listLibrary().find((song) => song.title === title)!;

  test("an OpenLyrics file in Windows-1252, like the HASD hymnal's, is written back and reads the same", async () => {
    const { importSongFiles } = await import("../../src/main/services/song-import");
    const { readOpenLyrics } = await import("../../src/main/songs/openlp");
    const { decodeText } = await import("../../src/main/decode-text");
    const folder = fs.mkdtempSync(path.join(tmpDir, "import-"));
    const file = path.join(folder, "5.xml");
    const xml = `<?xml version='1.0' encoding='windows-1252'?>
<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8">
  <properties><titles><title>5 - Jubilosos Te Adoramos</title></titles><authors><author>HASD</author></authors></properties>
  <lyrics><verse name="v1"><lines>Jubilosos Te adoramos<br/>Deus da glória, Deus do amor</lines></verse></lyrics>
</song>`;
    fs.writeFileSync(file, Buffer.from(xml, "latin1"));
    expect(importSongFiles([file])).toEqual({ imported: 1, repeated: 0, problems: 0, unsupported: 0 });
    const imported = titled("5 - Jubilosos Te Adoramos");
    expect(imported.file).toBe(file);
    expect(imported.sourceFolder).toBeNull();

    await save(imported.id, (song) => ({
      ...song,
      sections: song.sections.map((section) => ({
        ...section,
        slides: section.slides.map((slide) => ({
          ...slide,
          lines: slide.lines.map((line) => line.replace("Deus do amor", "Deus do amor e da paz")),
        })),
      })),
    }));
    const back = readOpenLyrics(decodeText(fs.readFileSync(file)))!;
    expect(back.title).toBe("5 - Jubilosos Te Adoramos");
    expect(back.sections[0]?.slides[0]?.lines).toContain("Deus da glória, Deus do amor e da paz");
    // Saved twice in a row: the second save sees its own write, not a change from outside.
    await save(imported.id, (song) => ({ ...song, authors: "HASD (rev.)" }));
    expect(readOpenLyrics(decodeText(fs.readFileSync(file)))?.authors).toBe("HASD (rev.)");
  });

  test("a ChordPro file of two songs keeps both; editing the second writes only it", async () => {
    const { importSongFiles } = await import("../../src/main/services/song-import");
    const folder = fs.mkdtempSync(path.join(tmpDir, "import-"));
    const file = path.join(folder, "dos.cho");
    fs.writeFileSync(
      file,
      "{title: Primera}\n{start_of_verse}\nUna línea primera\n{end_of_verse}\n{new_song}\n{title: Segunda}\n{start_of_verse}\nUna línea segunda\n{end_of_verse}\n",
    );
    expect(importSongFiles([file]).imported).toBe(2);
    const segunda = titled("Segunda");
    expect(segunda.file).toBe(file);
    await save(segunda.id, (song) => ({ ...song, title: "Segunda (editada)" }));
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("Primera");
    expect(text).toContain("Una línea primera");
    expect(text).toContain("Segunda (editada)");
  });

  test("changed outside the app: refused, read again, and saving once more replaces it", async () => {
    const { importSongFiles } = await import("../../src/main/services/song-import");
    const folder = fs.mkdtempSync(path.join(tmpDir, "import-"));
    const file = path.join(folder, "roca.cho");
    fs.writeFileSync(file, "{title: Roca}\n{start_of_verse}\nRoca de la eternidad\n{end_of_verse}\n");
    importSongFiles([file]);
    const roca = titled("Roca");
    fs.writeFileSync(file, "{title: Roca}\n{start_of_verse}\nRoca de los siglos\n{end_of_verse}\n");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));

    // A field the file holds (notes alone would never touch a ChordPro file).
    await expect(save(roca.id, (song) => ({ ...song, title: "Roca (mía)" }))).rejects.toMatchObject({ code: "SONG_FILE_CHANGED" });
    expect(repo.get(roca.id)?.sections[0]?.slides[0]?.lines).toEqual(["Roca de los siglos"]);
    await save(roca.id, (song) => ({ ...song, title: "Roca (mía)" }));
    expect(fs.readFileSync(file, "utf8")).toContain("Roca (mía)");
  });

  test("its file gone: saved in the app and untied; the file is never deleted with the song", async () => {
    const { importSongFiles } = await import("../../src/main/services/song-import");
    const folder = fs.mkdtempSync(path.join(tmpDir, "import-"));
    const kept = path.join(folder, "queda.cho");
    const gone = path.join(folder, "se-va.cho");
    fs.writeFileSync(kept, "{title: Queda}\n{start_of_verse}\nEsta queda\n{end_of_verse}\n");
    fs.writeFileSync(gone, "{title: Se va}\n{start_of_verse}\nEsta se va\n{end_of_verse}\n");
    importSongFiles([kept, gone]);
    fs.rmSync(gone);
    const saved = await save(titled("Se va").id, (song) => ({ ...song, title: "Se fue" }));
    expect(saved.title).toBe("Se fue");
    expect(saved.file).toBeNull();

    removeSong(titled("Queda").id, false);
    expect(fs.existsSync(kept)).toBe(true);
  });

  test("re-imported, a library copy without a file gets tied to it — still counted as a repeat", async () => {
    const { importSongFiles } = await import("../../src/main/services/song-import");
    const folder = fs.mkdtempSync(path.join(tmpDir, "import-"));
    const file = path.join(folder, "copia.cho");
    fs.writeFileSync(file, "{title: Copia vieja}\n{start_of_verse}\nLa letra de la copia\n{end_of_verse}\n");
    const copy = repo.create(song("Copia vieja", "[Estrofa 1]\nLa letra de la copia"));
    expect(copy.file).toBeNull();
    expect(importSongFiles([file])).toEqual({ imported: 0, repeated: 1, problems: 0, unsupported: 0 });
    expect(repo.get(copy.id)?.file).toBe(file);
  });

  test("the same file imported and in a linked folder: a save from one side makes the other read it again", async () => {
    const { importSongFiles } = await import("../../src/main/services/song-import");
    const { listSongFolder } = await import("../../src/main/services/song-files");
    const folder = fs.mkdtempSync(path.join(tmpDir, "both-"));
    const file = path.join(folder, "ambos.cho");
    fs.writeFileSync(file, "{title: Ambos}\n{start_of_verse}\nEn los dos lados\n{end_of_verse}\n");
    importSongFiles([file]);
    const [inFolder] = await listSongFolder(folder);
    await save(titled("Ambos").id, (song) => ({ ...song, title: "Ambos (desde la biblioteca)" }));
    expect((await listSongFolder(folder)).find((s) => s.id === inFolder!.id)?.title).toBe("Ambos (desde la biblioteca)");
  });
});

/* ---------------------------------------------------------------------------
 * Song files written back and read again (2026-11-06: never lose what is in
 * the file). Real files are COPIED from the corpus on this Mac, never written.
 * ------------------------------------------------------------------------ */

const FORMATS = "/Users/nicolasamorosi/Downloads/hasdlp-master/pruebas-formatos";
const HASD = "/Users/nicolasamorosi/Downloads/hasdlp-master/HASD";
const hasCorpus = fs.existsSync(FORMATS);

const fresh = (name: string) => fs.mkdtempSync(path.join(tmpDir, `${name}-`));
/** A copy of a corpus file in `folder`. */
const copy = (relative: string, folder: string, as = path.basename(relative)) => {
  const to = path.join(folder, as);
  fs.copyFileSync(path.join(FORMATS, relative), to);
  return to;
};
/** A change from outside the app: the file's mtime moves on. */
const touch = (file: string, seconds = 5) => fs.utimesSync(file, new Date(), new Date(Date.now() + seconds * 1000));
/** What `song:update` does: the file first, then the row. */
function writeBack(id: number, change: (song: Song) => Song): Song {
  const { id: _id, updatedAt: _u, sourceFolder: _s, file: _f, ...edited } = change(repo.get(id)!);
  writeSongFile(id, edited);
  return repo.update(id, edited);
}
const inLibrary = (title: string) => repo.listLibrary().find((s) => s.title === title)!;
const someTheme = () => repo.listThemes()[0] ?? repo.createTheme("Tema", DEFAULT_SONG_THEME);

describe("a song file written back keeps what it holds", () => {
  const THREE = `{title: Primera}
{start_of_verse}
Letra de la primera
{end_of_verse}

{new_song}
{title: Segunda (sin letra todavía)}
{artist: Alguien}

{new_song}
{title: Tercera}
{start_of_verse}
Letra de la tercera
{end_of_verse}
`;

  test("a ChordPro file of several songs, one without words yet: editing another keeps it, from the library or a folder", async () => {
    const imported = path.join(fresh("cho-lib"), "cancionero.cho");
    fs.writeFileSync(imported, THREE);
    expect(importSongFiles([imported])).toEqual({ imported: 2, repeated: 0, problems: 1, unsupported: 0 });
    writeBack(inLibrary("Tercera").id, (s) => ({ ...s, title: "Tercera (corregida)" }));
    expect(fs.readFileSync(imported, "utf8")).toContain("Tercera (corregida)");
    expect(fs.readFileSync(imported, "utf8")).toContain("{title: Segunda (sin letra todavía)}\n{artist: Alguien}");

    const folder = fresh("cho-folder");
    fs.writeFileSync(path.join(folder, "cancionero.cho"), THREE);
    const listed = await listSongFolder(folder);
    writeBack(listed.find((s) => s.title === "Primera")!.id, (s) => ({ ...s, title: "Primera (corregida)" }));
    const text = fs.readFileSync(path.join(folder, "cancionero.cho"), "utf8");
    expect(text).toContain("Primera (corregida)");
    expect(text.slice(text.indexOf("{new_song}"))).toBe(THREE.slice(THREE.indexOf("{new_song}")));
  });

  test("only a change the file holds writes it: a theme, or notes a ChordPro file has no place for, never touch it", async () => {
    const folder = fresh("theme-only");
    const file = path.join(folder, "domingo.cho");
    const original = "{title: Sublime gracia}\n{key: G}\n{start_of_verse: Verse 1}\nSublime gracia\n{end_of_verse}\n{start_of_tab}\ne|---3---|\n{end_of_tab}\n";
    fs.writeFileSync(file, original);
    const [gracia] = await listSongFolder(folder);
    // Changed outside since: no file is written, so nothing is refused either.
    touch(file, -60);
    const before = fs.statSync(file).mtimeMs;
    writeBack(gracia!.id, (s) => ({ ...s, themeId: someTheme().id }));
    writeBack(gracia!.id, (s) => ({ ...s, notes: "Capo 2" }));
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(repo.get(gracia!.id)).toMatchObject({ themeId: someTheme().id, notes: "Capo 2" });
  });

  test("an OpenLyrics song's theme changed: its languages, alternate title and key stay", async () => {
    const folder = fresh("xml-theme");
    const file = path.join(folder, "gracia.xml");
    const original = `<?xml version="1.0" encoding="UTF-8"?>
<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.9">
  <properties><titles><title lang="es">Sublime gracia</title><title lang="en">Amazing Grace</title></titles><key>G</key></properties>
  <lyrics>
    <verse name="v1" lang="es"><lines>Sublime gracia del Señor</lines></verse>
    <verse name="v1" lang="en"><lines>Amazing grace how sweet the sound</lines></verse>
    <verse name="v1" lang="pt"><lines>Maravilhosa graça</lines></verse>
  </lyrics>
</song>
`;
    fs.writeFileSync(file, original);
    const [gracia] = await listSongFolder(folder);
    writeBack(gracia!.id, (s) => ({ ...s, themeId: someTheme().id }));
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  test.skipIf(!hasCorpus)("a Windows-1251 ChordPro read as Windows-1252 is written back in its own bytes", async () => {
    const folder = fresh("cp1251");
    const file = copy("creados-a-mano/chordpro-ru-o-blagodat-windows-1251.cho", folder);
    const [read] = await listSongFolder(folder);
    expect(read?.title).toBe("Î, Áëàãîäàòü");
    writeBack(read!.id, (s) => ({ ...s, title: "O Blagodat" }));
    expect(new TextDecoder("windows-1251").decode(fs.readFileSync(file))).toContain("лагодать");
  });

  test("a character the file's encoding cannot hold: written as UTF-8, with a mark or a declaration that says so", async () => {
    const folder = fresh("to-utf8");
    fs.writeFileSync(path.join(folder, "uno.cho"), Buffer.from("{title: Señor}\n{start_of_verse}\nCanción\n{end_of_verse}\n", "latin1"));
    fs.writeFileSync(
      path.join(folder, "dos.xml"),
      Buffer.from(`<?xml version='1.0' encoding='windows-1252'?><song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8"><properties><titles><title>Canción</title></titles></properties><lyrics><verse name="v1"><lines>Señor</lines></verse></lyrics></song>`, "latin1"),
    );
    for (const listed of await listSongFolder(folder)) writeBack(listed.id, (s) => ({ ...s, title: `${s.title} — Благодать` }));
    const cho = fs.readFileSync(path.join(folder, "uno.cho"));
    expect([...cho.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(decodeText(cho)).toContain("Señor — Благодать");
    const xml = fs.readFileSync(path.join(folder, "dos.xml"), "utf8");
    expect(xml.startsWith("<?xml version='1.0' encoding=\"UTF-8\"?>")).toBe(true);
    expect(readOpenLyrics(xml)?.title).toBe("Canción — Благодать");
  });

  test("re-importing a file a library copy already has: the copy takes the file's chords, authors and CCLI number, keeps its theme and notes", () => {
    const old = repo.create(
      song("Roca de la eternidad", "[Estrofa 1]\nRoca de la eternidad\nfuiste abierta tú por mí", { notes: "Despacio", themeId: someTheme().id }),
    );
    const file = path.join(fresh("retie"), "roca.cho");
    fs.writeFileSync(
      file,
      "{title: Roca de la eternidad}\n{artist: Augustus Toplady}\n{ccli: 1234567}\n{start_of_verse: Verse 1}\n[G]Roca de la [D]eternidad\nfuiste [C]abierta tú por [G]mí\n{end_of_verse}\n",
    );
    expect(importSongFiles([file])).toEqual({ imported: 0, repeated: 1, problems: 0, unsupported: 0 });
    expect(repo.get(old.id)).toMatchObject({ file, authors: "Augustus Toplady", ccliNumber: "1234567", notes: "Despacio", themeId: someTheme().id });
    writeBack(old.id, (s) => ({ ...s, title: "Roca de la eternidad (Toplady)" }));
    const text = fs.readFileSync(file, "utf8");
    for (const kept of ["[G]Roca de la [D]eternidad", "Augustus Toplady", "1234567"]) expect(text).toContain(kept);
  });
});

describe("re-importing a file of a library song: what the file lacks stays the library's (review 2026-11-06)", () => {
  test("its number, notes, order, translation and chords stay; what it has (the authors) comes in", () => {
    const sections = withTranslation(
      parseLyrics("[Estrofa 1]\n[G]Sublime gracia\n\n[Coro]\nAleluya", "es").sections,
      parseLyrics("[Estrofa 1]\nAmazing grace", "es").sections,
    );
    const copy = repo.create(
      song("Sublime gracia (copia)", "x", { sections, number: "123", notes: "Cantar lento", order: ["v1", "c1", "v1", "c1", "c1"] }),
    );
    const file = path.join(fresh("lacks"), "gracia.xml");
    fs.writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?><song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8"><properties><titles><title>Sublime gracia (copia)</title></titles><authors><author>John Newton</author></authors></properties><lyrics><verse name="v1"><lines>Sublime gracia</lines></verse><verse name="c1"><lines>Aleluya</lines></verse></lyrics></song>`,
    );
    expect(importSongFiles([file])).toEqual({ imported: 0, repeated: 1, problems: 0, unsupported: 0 });
    const after = repo.get(copy.id)!;
    expect(after).toMatchObject({ file, authors: "John Newton", number: "123", notes: "Cantar lento", order: ["v1", "c1", "v1", "c1", "c1"] });
    expect(after.sections).toEqual(copy.sections);
  });

  test("a file that cuts or names the sections otherwise: the translation comes back line by line, OpenLyrics or ChordPro", () => {
    // The copy: verse 1 in two translated slides, then a translated chorus.
    const sections = withTranslation(
      parseLyrics("[Estrofa 1]\nlinea a\n\nlinea b\n\n[Coro]\ncoro x", "es").sections,
      parseLyrics("[Estrofa 1]\nline A\n\nline B\n\n[Coro]\nchorus X", "es").sections,
    );
    const slides = (id: number) =>
      repo.get(id)!.sections.flatMap((section) => section.slides.map((slide) => [slide.lines, slide.translation]));
    const expected = [
      [["linea a", "linea b"], ["line A", "line B"]],
      [["coro x"], ["chorus X"]],
    ];
    // The file: verse 1 as ONE slide, the chorus as verse 2.
    const xml = repo.create(song("Uno traducida", "x", { sections }));
    const xmlFile = path.join(fresh("by-line"), "uno.xml");
    fs.writeFileSync(
      xmlFile,
      `<?xml version="1.0" encoding="UTF-8"?><song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8"><properties><titles><title>Uno traducida</title></titles></properties><lyrics><verse name="v1"><lines>linea a<br/>linea b</lines></verse><verse name="v2"><lines>coro x</lines></verse></lyrics></song>`,
    );
    expect(importSongFiles([xmlFile])).toEqual({ imported: 0, repeated: 1, problems: 0, unsupported: 0 });
    expect(slides(xml.id)).toEqual(expected);
    // ChordPro has no place for a translation: `fromFile` restores it the same way.
    const cho = repo.create(song("Dos traducida", "x", { sections }));
    const choFile = path.join(fresh("by-line"), "dos.cho");
    fs.writeFileSync(
      choFile,
      "{title: Dos traducida}\n{start_of_verse}\nlinea a\nlinea b\n{end_of_verse}\n{start_of_verse}\ncoro x\n{end_of_verse}\n",
    );
    expect(importSongFiles([choFile])).toEqual({ imported: 0, repeated: 1, problems: 0, unsupported: 0 });
    expect(slides(cho.id)).toEqual(expected);
  });
});

describe("the songs of a file find their rows by title, then by place", () => {
  const make = (titles: string[]) =>
    titles.map((t) => `{title: ${t}}\n{start_of_verse}\nLetra de ${t}\n{end_of_verse}`).join("\n{new_song}\n");

  test("a linked folder: the first song removed outside the app, each row keeps its own song", async () => {
    const folder = fresh("shift-folder");
    const file = path.join(folder, "tres.cho");
    fs.writeFileSync(file, make(["A", "B", "C"]));
    const before = new Map((await listSongFolder(folder)).map((s) => [s.title, s.id]));
    fs.writeFileSync(file, make(["B", "C"]));
    touch(file);
    const after = await listSongFolder(folder);
    expect(after.map((s) => [s.title, s.id])).toEqual([
      ["B", before.get("B")],
      ["C", before.get("C")],
    ]);
  });

  test("a library song: the first removed outside, the third saved twice — «Uno» is not turned into «Dos», nothing duplicated", () => {
    const file = path.join(fresh("shift-lib"), "tres.cho");
    fs.writeFileSync(file, make(["Uno", "Dos", "Tres"]));
    importSongFiles([file]);
    const uno = inLibrary("Uno");
    const tres = inLibrary("Tres");
    fs.writeFileSync(file, make(["Dos", "Tres"]));
    touch(file);
    expect(() => writeBack(tres.id, (s) => ({ ...s, title: "Tres (editada)" }))).toThrow(
      expect.objectContaining({ code: "SONG_FILE_CHANGED" }),
    );
    writeBack(tres.id, (s) => ({ ...s, title: "Tres (editada)" }));
    expect(readSongText(fs.readFileSync(file, "utf8"), "x", "es").map((s) => s?.title)).toEqual(["Dos", "Tres (editada)"]);
    // «Uno» left the file: still in the library, untied.
    expect(repo.get(uno.id)).toMatchObject({ title: "Uno", file: null });
  });

  test("a song a saved program sings, gone from its file: a library song from then on, saveable, its file no longer re-read", async () => {
    const folder = fresh("orphan");
    const file = path.join(folder, "dos.cho");
    fs.writeFileSync(file, make(["Primera", "Segunda"]));
    const segunda = (await listSongFolder(folder)).find((s) => s.title === "Segunda")!;
    programs.save({ name: "Domingo", items: [{ kind: "song", songId: segunda.id, title: null }] });
    fs.writeFileSync(file, make(["Primera"]));
    touch(file);
    expect((await listSongFolder(folder)).map((s) => s.title)).toEqual(["Primera"]);
    expect(repo.get(segunda.id)).toMatchObject({ sourceFolder: null, file: null });
    expect(writeBack(segunda.id, (s) => ({ ...s, notes: "mía" })).notes).toBe("mía");
    expect(fs.readFileSync(file, "utf8")).toBe(make(["Primera"]));
  });

  test("a song made instrumental in a ChordPro songbook: saved again and again into its own block, never over another song (review 2026-11-06)", async () => {
    const folder = fresh("instrumental");
    const file = path.join(folder, "libro.cho");
    const OTHER = "{new_song}\n{title: Otra canción}\n{start_of_verse}\nLetra de la otra canción\n{end_of_verse}\n";
    fs.writeFileSync(file, `{title: Preludio}\n{start_of_verse}\nPalabras del preludio\n{end_of_verse}\n\n${OTHER}`);
    const listed = await listSongFolder(folder);
    const preludio = listed.find((s) => s.title === "Preludio")!;
    // Chords alone (owner, 2026-11-06): it read back as no song, and its row got tied to «Otra canción».
    writeBack(preludio.id, (s) => ({ ...s, sections: parseLyrics("[Intro]\n[G] [D] [Em] [C]", "es").sections, order: [] }));
    writeBack(preludio.id, (s) => ({ ...s, title: "Preludio (2)" }));
    writeBack(preludio.id, (s) => ({ ...s, title: "Preludio (3)" }));
    const text = fs.readFileSync(file, "utf8");
    expect(text.endsWith(`\n${OTHER}`)).toBe(true);
    expect(readSongText(text, "libro", "es").map((s) => s?.title)).toEqual(["Preludio (3)", "Otra canción"]);

    // A library song its file no longer holds at all: appended, and tied to
    // that new block — saved again, it replaces it, nothing else.
    const mtime = Math.floor(fs.statSync(file).mtimeMs);
    const lone = repo.create(song("Suelta", "[Intro]\n[G] [D]"), { path: file, index: 7, mtime, format: "chordpro" });
    writeBack(lone.id, (s) => ({ ...s, title: "Suelta (2)" }));
    writeBack(lone.id, (s) => ({ ...s, title: "Suelta (3)" }));
    const appended = fs.readFileSync(file, "utf8");
    expect(appended.startsWith(text)).toBe(true);
    expect(readSongText(appended, "libro", "es").map((s) => s?.title)).toEqual(["Preludio (3)", "Otra canción", "Suelta (3)"]);
  });

  test("two songs of a file with one title (a file's name is every untitled song's): saving one never rewrites the other's row (review 2026-11-06)", async () => {
    const SANTOS =
      "{title: Santo}\n{start_of_verse}\nSanto es el Señor primero\n{end_of_verse}\n\n{new_song}\n{title: Santo}\n{start_of_verse}\nSanto segundo distinto\n{end_of_verse}\n";
    const words = (id: number) => repo.get(id)!.sections[0]!.slides[0]!.lines[0];
    const pair = (all: readonly Song[], file: string) => {
      const tied = all.filter((s) => s.file === file);
      return [tied.find((s) => s.sections[0]!.slides[0]!.lines[0]!.includes("primero"))!.id, tied.find((s) => s.sections[0]!.slides[0]!.lines[0]!.includes("segundo"))!.id] as const;
    };
    // The library's.
    const imported = path.join(fresh("twins-lib"), "santos.cho");
    fs.writeFileSync(imported, SANTOS);
    importSongFiles([imported]);
    const [libFirst, libSecond] = pair(repo.listLibrary(), imported);
    writeBack(libFirst, (s) => ({ ...s, authors: "Autor Nuevo" }));
    expect(repo.get(libSecond)).toMatchObject({ authors: null });
    expect(words(libSecond)).toBe("Santo segundo distinto");
    // A linked folder's.
    const folder = fresh("twins-folder");
    const file = path.join(folder, "santos.cho");
    fs.writeFileSync(file, SANTOS);
    const [first, second] = pair(await listSongFolder(folder), file);
    writeBack(second, (s) => ({ ...s, authors: "Autor Nuevo" }));
    expect(repo.get(first)).toMatchObject({ authors: null });
    expect(words(first)).toBe("Santo es el Señor primero");
    // Both ways: a linked folder's file imported too — the folder's row of the
    // SAME block takes the edit, the other one keeps its own.
    const bothFolder = fresh("twins-both");
    const both = path.join(bothFolder, "sanctus.cho");
    fs.writeFileSync(both, SANTOS.replaceAll("Santo", "Sanctus"));
    const [folderFirst, folderSecond] = pair(await listSongFolder(bothFolder), both);
    importSongFiles([both]);
    const [, libraryCopy] = pair(repo.listLibrary(), both);
    writeBack(libraryCopy, (s) => ({ ...s, sections: parseLyrics("[Estrofa 1]\nSanctus segundo cambiado", "es").sections }));
    expect(words(folderSecond)).toBe("Sanctus segundo cambiado");
    expect(words(folderFirst)).toBe("Sanctus es el Señor primero");
  });

  test("the same file imported and in a linked folder: saving from one side never reads as «changed outside» on the other", async () => {
    const folder = fresh("both");
    const file = path.join(folder, "ambos.cho");
    fs.writeFileSync(file, "{title: Ambos}\n{start_of_verse}\nEn los dos lados\n{end_of_verse}\n");
    importSongFiles([file]);
    const [inFolder] = await listSongFolder(folder);
    repo.update(inFolder!.id, { ...inFolder!, themeId: someTheme().id });
    writeBack(inLibrary("Ambos").id, (s) => ({ ...s, title: "Ambos (desde la biblioteca)" }));
    // The folder's row has the words and the new mtime: its own save goes through, its theme stays.
    expect(repo.get(inFolder!.id)).toMatchObject({ title: "Ambos (desde la biblioteca)", themeId: someTheme().id });
    writeBack(inFolder!.id, (s) => ({ ...s, title: "Ambos (desde la carpeta)" }));
    expect(inLibrary("Ambos (desde la carpeta)")).toBeDefined();
  });
});

describe("a linked folder", () => {
  test.skipIf(!hasCorpus)("lists only songs: broken, empty, foreign, hidden, sub-folder and non-song files are skipped quietly", async () => {
    const folder = fresh("mixed");
    copy("openlyrics/openlyrics-tests/InvalidXml.xml", folder);
    copy("openlyrics/otras-fuentes/multiple-comments-sin-letra.xml", folder);
    copy("otros-formatos/propresenter/Come-Thou-Fount-ProPresenter7.pro", folder);
    copy("otros-formatos/easyslides/amazing-grace.xml", folder, "easyslides.xml");
    copy("chordpro/crd/acordes-sobre-letra-t001.crd", folder);
    copy("otros-formatos/opspro/amazing grace.txt", folder, "opspro.txt");
    copy("otros-formatos/lyrix/A002.TXT", folder);
    copy("chordpro/cho/Silent Night.cho", folder);
    fs.writeFileSync(path.join(folder, "vacío.cho"), "");
    fs.writeFileSync(path.join(folder, ".oculta.cho"), "{title: Oculta}\nLetra");
    fs.writeFileSync(path.join(folder, "notas.md"), "{title: no}\nno");
    fs.mkdirSync(path.join(folder, "sub"));
    fs.writeFileSync(path.join(folder, "sub", "dentro.cho"), "{title: Dentro}\nLetra");
    expect((await listSongFolder(folder)).map((s) => s.title)).toEqual(["Silent Night"]);
  });

  test("a file deleted outside the app: its songs go, and the folder's search no longer finds them", async () => {
    const folder = fresh("deleted");
    const file = path.join(folder, "borrar.cho");
    fs.writeFileSync(file, "{title: Zarza ardiente}\n{start_of_verse}\nZarza ardiente en el desierto\n{end_of_verse}\n");
    const [zarza] = await listSongFolder(folder);
    fs.rmSync(file);
    expect(await listSongFolder(folder)).toEqual([]);
    expect(repo.search("zarza", 200, folder)).toEqual([]);
    expect(repo.get(zarza!.id)).toBeNull();
  });

  test("a folder no longer linked: its songs go, a saved program's become library songs", async () => {
    const folder = fresh("unlinked");
    fs.writeFileSync(path.join(folder, "a.cho"), "{title: Se olvida}\n{start_of_verse}\nUna\n{end_of_verse}\n");
    fs.writeFileSync(path.join(folder, "b.cho"), "{title: Se queda}\n{start_of_verse}\nOtra\n{end_of_verse}\n");
    const listed = await listSongFolder(folder);
    const kept = listed.find((s) => s.title === "Se queda")!;
    programs.save({ name: "Programa", items: [{ kind: "song", songId: kept.id, title: null }] });
    repo.forgetFolders([]);
    expect(repo.get(listed.find((s) => s.title === "Se olvida")!.id)).toBeNull();
    expect(repo.get(kept.id)).toMatchObject({ sourceFolder: null, file: null });
  });

  test("a song the unsaved order of service sings: its file gone or its folder unlinked, a library song — never a dangling id (review 2026-11-06)", async () => {
    const folder = fresh("drafted");
    fs.writeFileSync(path.join(folder, "a.cho"), "{title: En el borrador}\n{start_of_verse}\nUna\n{end_of_verse}\n");
    fs.writeFileSync(path.join(folder, "b.cho"), "{title: Archivo borrado}\n{start_of_verse}\nOtra\n{end_of_verse}\n");
    const listed = await listSongFolder(folder);
    const drafts = new DraftRepo(db);
    const items = listed.map((s) => ({ kind: "song" as const, songId: s.id, title: null }));
    drafts.save({ programId: null, name: "", notes: null, items, updatedAt: 1 });
    fs.rmSync(path.join(folder, "b.cho"));
    await listSongFolder(folder);
    repo.forgetFolders([]);
    for (const s of listed) expect(repo.get(s.id)).toMatchObject({ title: s.title, sourceFolder: null, file: null });
    expect(drafts.load()?.items).toEqual(items);
    drafts.clear();
  });

  test("a file empty for a moment (an editor that truncates before writing) keeps its song's row, id and theme", async () => {
    const folder = fresh("flaky");
    const file = path.join(folder, "himno.xml");
    const good = `<?xml version="1.0" encoding="UTF-8"?><song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8"><properties><titles><title>Himno</title></titles></properties><lyrics><verse name="v1"><lines>Una línea</lines></verse></lyrics></song>`;
    fs.writeFileSync(file, good);
    const [first] = await listSongFolder(folder);
    repo.update(first!.id, { ...first!, themeId: someTheme().id });
    fs.writeFileSync(file, "");
    touch(file, 5);
    expect(await listSongFolder(folder)).toEqual([]);
    fs.writeFileSync(file, good);
    touch(file, 10);
    expect((await listSongFolder(folder))[0]).toMatchObject({ id: first!.id, themeId: someTheme().id });
  });

  test("notes a ChordPro file cannot hold survive the file changing outside the app", async () => {
    const folder = fresh("notes");
    const file = path.join(folder, "notas.cho");
    fs.writeFileSync(file, "{title: Con notas}\n{start_of_verse}\nUna línea\n{end_of_verse}\n");
    const [listed] = await listSongFolder(folder);
    writeBack(listed!.id, (s) => ({ ...s, notes: "Capo 2", number: "12" }));
    fs.writeFileSync(file, "{title: Con notas}\n{start_of_verse}\nUna línea cambiada\n{end_of_verse}\n");
    touch(file);
    expect((await listSongFolder(folder))[0]).toMatchObject({ id: listed!.id, notes: "Capo 2", number: "12" });
  });

  test.skipIf(!fs.existsSync(HASD) || !hasCorpus)("every format written back from a linked folder reads back as the edit", async () => {
    const folder = fresh("formats");
    fs.copyFileSync(path.join(HASD, "5.xml"), path.join(folder, "5.xml"));
    copy("chordpro/cho/Silent Night.cho", folder);
    copy("songselect/TestSong2023.txt", folder);
    copy("creados-a-mano/openlyrics-pt-castelo-forte-utf16-bom.xml", folder);
    copy("creados-a-mano/chordpro-es-sublime-gracia-windows-1252.cho", folder);
    const listed = await listSongFolder(folder);
    expect(listed).toHaveLength(5);
    for (const original of listed) {
      writeBack(original.id, (s) => ({
        ...s,
        title: `${s.title} — ñ & «x»`,
        sections: [...s.sections, ...parseLyrics("[Puente]\nNueva línea: ¡Gloria! & <paz>", "es").sections],
      }));
    }
    for (const file of fs.readdirSync(folder)) touch(path.join(folder, file), 20);
    for (const read of await listSongFolder(folder)) {
      expect(read.title, read.file ?? "").toContain("— ñ & «x»");
      expect(read.sections.at(-1)?.slides[0]?.lines, read.file ?? "").toEqual(["Nueva línea: ¡Gloria! & <paz>"]);
      expect(JSON.stringify(read), read.file ?? "").not.toMatch(/Ã|Â|�/);
    }
    // The HASD file stays Windows-1252 (every edit fits it), and says so.
    const hasd = fs.readFileSync(path.join(folder, "5.xml"));
    expect(hasd.toString("latin1").startsWith("<?xml version='1.0' encoding='windows-1252'?>")).toBe(true);
    expect(readOpenLyrics(decodeText(hasd))?.title).toBe("5 - Supremo Criador — ñ & «x»");
  });
});

describe("writing over the file", () => {
  test("a file the operator made read-only is refused (SONG_FILE_UNWRITABLE), never replaced", async () => {
    const folder = fresh("readonly");
    const file = path.join(folder, "protegido.cho");
    fs.writeFileSync(file, "{title: Protegido}\n{start_of_verse}\nNo me cambies\n{end_of_verse}\n");
    fs.chmodSync(file, 0o444);
    const [protegido] = await listSongFolder(folder);
    try {
      expect(() => writeBack(protegido!.id, (s) => ({ ...s, title: "Cambiado" }))).toThrow(
        expect.objectContaining({ code: "SONG_FILE_UNWRITABLE" }),
      );
      expect(fs.readFileSync(file, "utf8")).toContain("{title: Protegido}");
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });

  test("an edit that never reaches the file is never refused because of it: notes on a read-only .txt of either kind (review 2026-11-06)", async () => {
    const folder = fresh("readonly-txt");
    fs.writeFileSync(path.join(folder, "a.txt"), "Santo santo santo\n\nVerse 1\nSanto santo santo\n\nReginald Heber\nCCLI Song # 1156\n© Public Domain\n");
    fs.writeFileSync(path.join(folder, "b.txt"), "{title: Roca txt}\n{start_of_verse}\nRoca de la eternidad\n{end_of_verse}\n");
    for (const name of ["a.txt", "b.txt"]) fs.chmodSync(path.join(folder, name), 0o444);
    try {
      const listed = await listSongFolder(folder);
      expect(listed).toHaveLength(2);
      for (const s of listed) expect(writeBack(s.id, (x) => ({ ...x, notes: "solo una nota" })).notes).toBe("solo una nota");
      // What does reach it is still refused.
      expect(() => writeBack(listed[0]!.id, (x) => ({ ...x, title: "Cambiado" }))).toThrow(
        expect.objectContaining({ code: "SONG_FILE_UNWRITABLE" }),
      );
    } finally {
      for (const name of ["a.txt", "b.txt"]) fs.chmodSync(path.join(folder, name), 0o644);
    }
  });

  test("a file system that keeps no permissions (a share, exFAT): the song is written all the same (review 2026-11-06)", async () => {
    const folder = fresh("no-chmod");
    const file = path.join(folder, "compartida.cho");
    fs.writeFileSync(file, "{title: Compartida}\n{start_of_verse}\nUna\n{end_of_verse}\n");
    const [listed] = await listSongFolder(folder);
    const chmod = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeBack(listed!.id, (s) => ({ ...s, title: "Compartida (2)" }));
      expect(chmod).toHaveBeenCalled();
    } finally {
      chmod.mockRestore();
      warn.mockRestore();
    }
    expect(fs.readFileSync(file, "utf8")).toContain("{title: Compartida (2)}");
  });

  test("a file's permissions are kept when it is written", async () => {
    const folder = fresh("mode");
    const file = path.join(folder, "permisos.cho");
    fs.writeFileSync(file, "{title: Permisos}\n{start_of_verse}\nUna\n{end_of_verse}\n");
    fs.chmodSync(file, 0o640);
    const [permisos] = await listSongFolder(folder);
    writeBack(permisos!.id, (s) => ({ ...s, title: "Permisos (2)" }));
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  test("a symbolic link to a song file: listed in its folder, and saving writes the file it points at, the link kept", async () => {
    const real = path.join(fresh("symlink-target"), "real.cho");
    fs.writeFileSync(real, "{title: Enlazada}\n{start_of_verse}\nLetra enlazada\n{end_of_verse}\n");
    const folder = fresh("symlink-folder");
    const link = path.join(folder, "enlace.cho");
    fs.symlinkSync(real, link);
    const [enlazada] = await listSongFolder(folder);
    expect(enlazada?.title).toBe("Enlazada");
    writeBack(enlazada!.id, (s) => ({ ...s, title: "Enlazada (editada)" }));
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toContain("Enlazada (editada)");

    const imported = path.join(fresh("symlink-link"), "importada.cho");
    fs.symlinkSync(real, imported);
    expect(importSongFiles([imported]).imported).toBe(1);
    writeBack(inLibrary("Enlazada (editada)").id, (s) => ({ ...s, title: "Por enlace" }));
    expect(fs.lstatSync(imported).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toContain("Por enlace");
  });
});

describe.skipIf(!hasCorpus)("imports of real files", () => {
  const openLpRows = (file: string) => {
    const opened = new Database(file, { readonly: true });
    try {
      return (opened.prepare("SELECT COUNT(*) AS n FROM songs").get() as { n: number }).n;
    } finally {
      opened.close();
    }
  };

  test("OpenLP's songs.sqlite: honest counts, and a second import is all repeats", () => {
    const file = copy("openlp-sqlite/ftw-ingles/songs.sqlite", fresh("openlp"), "songs.sqlite");
    const first = importSongFiles([file]);
    expect(first.imported + first.repeated + first.problems).toBe(openLpRows(file));
    expect(first.imported).toBeGreaterThan(150);
    expect(importSongFiles([file])).toEqual({ imported: 0, repeated: first.imported + first.repeated, problems: first.problems, unsupported: 0 });
  });

  test("OpenLP 1.9.7, 2.4.6 and the invalid-version 2.2 databases", () => {
    for (const fixture of ["fixture-1.9.7", "fixture-2.4.6", "fixture-2.2-version-invalida"]) {
      const result = importSongFiles([copy(`openlp-sqlite/${fixture}/songs.sqlite`, fresh(fixture), "songs.sqlite")]);
      expect(result.imported + result.repeated, fixture).toBe(1);
    }
  });

  test("EasyWorship 6, picked by either of its databases: three songs, Danish letters right; again = all repeats", () => {
    const data = path.join(fresh("ew6"), "Databases", "Data");
    fs.mkdirSync(data, { recursive: true });
    for (const name of ["Songs.db", "SongWords.db"]) {
      fs.copyFileSync(path.join(FORMATS, "easyworship6/openlp-fixture/Databases/Data", name), path.join(data, name));
    }
    const first = importSongFiles([path.join(data, "SongWords.db")]);
    expect(first.imported + first.repeated).toBe(3);
    expect(first.problems).toBe(1);
    const danish = repo.listLibrary().find((s) => s.title.startsWith("Vi pl"));
    expect(danish?.title).toMatch(/ø/);
    expect(JSON.stringify(danish)).not.toMatch(/Ã|�/);
    expect(importSongFiles([path.join(data, "Songs.db")])).toEqual({ imported: 0, repeated: 3, problems: 1, unsupported: 0 });
  });

  test("EasyWorship 2009's Songs.DB is refused as an old EasyWorship, not as «no database here»", () => {
    const folder = fresh("ew2009");
    copy("easyworship2009-MB-formato-viejo/Songs.DB", folder);
    copy("easyworship2009-MB-formato-viejo/Songs.MB", folder);
    expect(() => importSongFiles([path.join(folder, "Songs.DB")])).toThrow(expect.objectContaining({ code: "EW_OLD" }));
  });

  test("other programs' files are counted apart from songs without words; every song file twice is all repeats", () => {
    const folder = fresh("all");
    const files: string[] = [];
    for (const sub of ["chordpro", "creados-a-mano", "openlyrics", "songselect", "otros-formatos"]) {
      for (const name of fs.readdirSync(path.join(FORMATS, sub), { recursive: true }) as string[]) {
        const from = path.join(FORMATS, sub, name);
        if (!fs.statSync(from).isFile() || !/\.(xml|txt|cho|chordpro|chopro|crd|pro)$/i.test(name)) continue;
        const to = path.join(folder, `${sub}-${name.replaceAll("/", "-")}`);
        fs.copyFileSync(from, to);
        files.push(to);
      }
    }
    const first = importSongFiles(files);
    expect(first.unsupported).toBeGreaterThanOrEqual(15);
    expect(first.problems).toBeLessThan(5);
    const second = importSongFiles(files);
    expect(second).toEqual({ imported: 0, repeated: first.imported + first.repeated, problems: first.problems, unsupported: first.unsupported });
  });

  test("the same file twice in one pick: one song, one repeat", () => {
    const file = path.join(fresh("twice"), "dos-veces.cho");
    fs.writeFileSync(file, "{title: Dos veces}\n{start_of_verse}\nLa misma letra\n{end_of_verse}\n");
    expect(importSongFiles([file, file])).toEqual({ imported: 1, repeated: 1, problems: 0, unsupported: 0 });
  });

  test("a library song's file renamed: saved in the app and untied, the renamed file untouched", () => {
    const folder = fresh("untie");
    const file = path.join(folder, "mover.cho");
    fs.writeFileSync(file, "{title: Mover}\n{start_of_verse}\nUna letra para mover\n{end_of_verse}\n");
    importSongFiles([file]);
    fs.renameSync(file, path.join(folder, "movido.cho"));
    expect(writeBack(inLibrary("Mover").id, (s) => ({ ...s, title: "Mover (editada)" })).file).toBeNull();
    expect(fs.readFileSync(path.join(folder, "movido.cho"), "utf8")).toContain("{title: Mover}");
  });
});
