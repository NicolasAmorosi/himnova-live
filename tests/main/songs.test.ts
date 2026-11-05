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
