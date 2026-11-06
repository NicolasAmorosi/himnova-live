/**
 * Songs on the main side: the validator/normalizer pairs, the repo and its
 * accent-blind search, migration 0019's CHECK and FKs, a song as an
 * order-of-service row (saved, drafted, force-deleted), the history counting a
 * song once, and the default theme seeded once from the verse's look.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { SongsRepo } from "../../src/main/db/repositories/songs.repo";
import { ProgramsRepo } from "../../src/main/db/repositories/programs.repo";
import { DraftRepo } from "../../src/main/db/repositories/draft.repo";
import { HistoryRepo } from "../../src/main/db/repositories/history.repo";
import { SettingsRepo } from "../../src/main/db/repositories/settings.repo";
import { seedSongThemes } from "../../src/main/db/seed/seed-song-themes";
import { getSongsRepo, initRepos } from "../../src/main/services/repos";
import { removeSong } from "../../src/main/services/song-removal";
import {
  isSongTheme,
  isSongUpsert,
  normalizeOrder,
  normalizeSections,
  normalizeSongTheme,
} from "../../src/shared/song-validators";
import { parseLyrics, splitSection } from "../../src/shared/song-text";
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
    expect(importSongFiles([path.join(folder, "uno.cho")])).toEqual({ imported: 1, repeated: 0, problems: 0 });

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
    expect(() => writeSongFile(id, edited)).toThrow(expect.objectContaining({ code: "SONG_FILE_CHANGED" }));
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
    expect(importSongFiles([file])).toEqual({ imported: 1, repeated: 0, problems: 0 });
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

    await expect(save(roca.id, (song) => ({ ...song, notes: "mía" }))).rejects.toMatchObject({ code: "SONG_FILE_CHANGED" });
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
    expect(importSongFiles([file])).toEqual({ imported: 0, repeated: 1, problems: 0 });
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
