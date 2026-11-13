/**
 * One «Locate…» for a whole moved folder, drive or computer
 * (`services/relocate-move.ts`): what changed between the old path and the new
 * one, and everything the app keeps under the old part that follows it: only
 * what is gone AND has its twin at the new place.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { MediaRepo } from "../../src/main/db/repositories/media.repo";
import { ProgramsRepo } from "../../src/main/db/repositories/programs.repo";
import { SettingsRepo } from "../../src/main/db/repositories/settings.repo";
import { SongsRepo } from "../../src/main/db/repositories/songs.repo";
import { followMove, moveBetween, movedPath, namesOf } from "../../src/main/services/relocate-move";
import { parseLyrics } from "../../src/shared/song-text";
import type { SongUpsert } from "../../src/shared/types/song";

describe("the move between two paths", () => {
  test("is the part that changed: a drive letter, a user folder", () => {
    expect(moveBetween(namesOf("D:\\Iglesia\\Videos\\Navidad"), namesOf("E:\\Iglesia\\Videos\\Navidad"))).toEqual({
      from: ["D:"],
      to: ["E:"],
    });
    expect(moveBetween(namesOf("C:\\Users\\juan\\Videos"), namesOf("C:\\Users\\maria\\Videos"))).toEqual({
      from: ["C:", "Users", "juan"],
      to: ["C:", "Users", "maria"],
    });
    expect(moveBetween(namesOf("/Volumes/USB/Iglesia"), namesOf("/Users/ana/Iglesia"))).toEqual({
      from: ["", "Volumes", "USB"],
      to: ["", "Users", "ana"],
    });
  });

  test("is nothing when the folder did not change", () => {
    expect(moveBetween(namesOf("D:\\Iglesia"), namesOf("D:\\Iglesia"))).toBeNull();
    expect(moveBetween(namesOf("D:\\Iglesia"), namesOf("d:\\iglesia"), true)).toBeNull();
  });

  test("moves a path under its old part, name by name, never a look-alike", () => {
    const move = { from: ["D:"], to: ["E:", "Copia"] };
    expect(movedPath("D:\\Iglesia\\Fotos\\a.png", move, "\\")).toBe("E:\\Copia\\Iglesia\\Fotos\\a.png");
    expect(movedPath("C:\\Iglesia\\a.png", move, "\\")).toBeNull();
    const deeper = { from: ["D:", "Iglesia"], to: ["E:", "Iglesia2"] };
    expect(movedPath("D:\\IglesiaVieja\\a.png", deeper, "\\")).toBeNull();
    expect(movedPath("d:\\iglesia\\a.png", deeper, "\\", true)).toBe("E:\\Iglesia2\\a.png");
    expect(movedPath("d:\\iglesia\\a.png", deeper, "\\", false)).toBeNull();
  });

  test("keeps a lone drive or root a folder, and a share a share", () => {
    expect(movedPath("D:\\Medios", { from: ["D:", "Medios"], to: ["E:"] }, "\\")).toBe("E:\\");
    expect(movedPath("/Medios", { from: ["", "Medios"], to: [""] }, "/")).toBe("/");
    expect(movedPath("\\\\server\\share\\Iglesia\\a.mp4", { from: ["", "", "server", "share"], to: ["E:"] }, "\\")).toBe(
      "E:\\Iglesia\\a.mp4",
    );
    expect(movedPath("E:\\Iglesia\\a.mp4", { from: ["E:"], to: ["", "", "server", "share"] }, "\\")).toBe(
      "\\\\server\\share\\Iglesia\\a.mp4",
    );
  });

  test("brings a Windows profile's paths to a Mac or Linux", () => {
    const move = moveBetween(namesOf("C:\\Users\\juan\\Videos"), namesOf("/Users/maria/Movies/Videos"))!;
    expect(movedPath("C:\\Users\\juan\\Videos\\Navidad\\x.mp4", move, "/")).toBe("/Users/maria/Movies/Videos/Navidad/x.mp4");
  });
});

describe("following a move", () => {
  let dir: string;
  let handle: ReturnType<typeof openDatabase>;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-relocate-move-"));
    handle = openDatabase(path.join(dir, "worship.db"));
    runMigrations(handle.db, path.join(process.cwd(), "drizzle"));
  });

  afterAll(() => {
    handle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, path.basename(file));
  };
  const song = (title: string): Omit<SongUpsert, "id"> => ({
    title,
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: parseLyrics("[Coro]\nAleluya", "es").sections,
    order: [],
    themeId: null,
  });

  test("moves what the move explains, keeping every id, and nothing else", async () => {
    const media = new MediaRepo(handle.db, handle.sqlite);
    const songs = new SongsRepo(handle.db, handle.sqlite);
    const settings = new SettingsRepo(handle.db);
    const programs = new ProgramsRepo(handle.db, handle.sqlite);

    const oldRoot = path.join(dir, "D", "Iglesia");
    const newRoot = path.join(dir, "E", "Iglesia");
    const at = (root: string, ...names: string[]) => path.join(root, ...names);
    for (const names of [
      ["Videos", "a.mp4"],
      ["Videos", "b.mp4"],
      ["Decks", "kept.mp4"],
      ["Fotos", "sub", "c.png"],
      ["Decks", "d.pptx"],
      ["Audio", "d.mp3"],
      ["Cantos", "uno.txt"],
      ["Cantos", "dos.cho"],
    ]) {
      write(at(oldRoot, ...names));
    }
    const outside = path.join(dir, "otra", "x.mp4");
    write(outside);
    write(at(oldRoot, "Videos", "gone.mp4"));

    const a = media.upsertFromPath(at(oldRoot, "Videos", "a.mp4"), "video", true);
    const b = media.upsertFromPath(at(oldRoot, "Videos", "b.mp4"), "video", true);
    const kept = media.upsertFromPath(at(oldRoot, "Decks", "kept.mp4"), "video", true);
    const gone = media.upsertFromPath(at(oldRoot, "Videos", "gone.mp4"), "video", true);
    const c = media.upsertFromPath(at(oldRoot, "Fotos", "sub", "c.png"), "image", false);
    const d = media.upsertFromPath(at(oldRoot, "Decks", "d.pptx"), "ppt", true);
    const x = media.upsertFromPath(outside, "video", true);
    media.setLinkedAudio(d.id, at(oldRoot, "Audio", "d.mp3"));
    const program = programs.save({ name: "Culto", items: [{ kind: "media", mediaAssetId: c.id, title: null }] });

    const [folderSong] = songs.syncFile(at(oldRoot, "Cantos"), "uno.txt", 1, [{ song: song("Uno"), index: 0 }], "songselect");
    const librarySong = songs.create(song("Dos"), { path: at(oldRoot, "Cantos", "dos.cho"), index: 0, mtime: 1, format: "chordpro" });

    const otherFolder = path.join(dir, "otra");
    settings.setMany({
      "library.linkedFolders": { video: [at(oldRoot, "Videos"), otherFolder], image: [], audio: [], ppt: [] },
      "library.activeView": { video: at(oldRoot, "Videos"), image: "recent", audio: "recent", ppt: "recent" },
      "songs.linkedFolders": [at(oldRoot, "Cantos")],
      "songs.activeView": at(oldRoot, "Cantos"),
    });

    // The whole folder moved; one file went missing for good on the way, and
    // one was copied back to its old place (it still works there: untouched).
    fs.mkdirSync(path.dirname(newRoot), { recursive: true });
    fs.renameSync(oldRoot, newRoot);
    fs.rmSync(at(newRoot, "Videos", "gone.mp4"));
    write(at(oldRoot, "Decks", "kept.mp4"));

    // The operator locates `a` …
    media.relocate(a.id, at(newRoot, "Videos", "a.mp4"));
    const move = moveBetween(namesOf(at(oldRoot, "Videos")), namesOf(at(newRoot, "Videos")))!;
    const { fixed, kinds } = await followMove(move, { media, songs, settings });

    // … and the rest follows: b, c, the deck, its soundtrack, the tied song
    // file, the two linked folders (Cantos also being the folder songs').
    expect(fixed.size).toBe(7);
    expect([...kinds].sort()).toEqual(["image", "ppt", "video"]);
    expect(media.getById(b.id)?.path).toBe(at(newRoot, "Videos", "b.mp4"));
    expect(media.getById(c.id)).toMatchObject({ path: at(newRoot, "Fotos", "sub", "c.png"), missingSince: null });
    expect(media.getById(d.id)).toMatchObject({ path: at(newRoot, "Decks", "d.pptx"), linkedAudioPath: at(newRoot, "Audio", "d.mp3") });
    expect(programs.load(program.id).items.map((item) => (item.kind === "media" ? item.mediaAssetId : null))).toEqual([c.id]);
    expect(media.getById(kept.id)?.path).toBe(at(oldRoot, "Decks", "kept.mp4"));
    expect(media.getById(gone.id)?.path).toBe(at(oldRoot, "Videos", "gone.mp4"));
    expect(media.getById(x.id)?.path).toBe(outside);

    expect(songs.get(folderSong!.id)?.sourceFolder).toBe(at(newRoot, "Cantos"));
    expect(songs.source(librarySong.id)?.path).toBe(at(newRoot, "Cantos", "dos.cho"));
    expect(settings.get("library.linkedFolders").video).toEqual([at(newRoot, "Videos"), otherFolder]);
    expect(settings.get("library.activeView").video).toBe(at(newRoot, "Videos"));
    expect(settings.get("songs.linkedFolders")).toEqual([at(newRoot, "Cantos")]);
    expect(settings.get("songs.activeView")).toBe(at(newRoot, "Cantos"));

    // Following the same move again finds nothing left to do.
    expect((await followMove(move, { media, songs, settings })).fixed.size).toBe(0);
  });

  test("a folder linked by hand at the new place keeps its own songs and is not linked twice", async () => {
    const songs = new SongsRepo(handle.db, handle.sqlite);
    const settings = new SettingsRepo(handle.db);
    const media = new MediaRepo(handle.db, handle.sqlite);
    const before = path.join(dir, "F", "Cantos");
    const after = path.join(dir, "G", "Cantos");
    write(path.join(after, "tres.txt"));
    const [old] = songs.syncFile(before, "tres.txt", 1, [{ song: song("Tres"), index: 0 }], "songselect");
    const [mine] = songs.syncFile(after, "tres.txt", 1, [{ song: song("Tres"), index: 0 }], "songselect");
    settings.setMany({ "songs.linkedFolders": [before, after] });

    const { fixed } = await followMove(moveBetween(namesOf(before), namesOf(after))!, { media, songs, settings });

    expect(fixed.has(before)).toBe(true);
    expect(settings.get("songs.linkedFolders")).toEqual([after]);
    expect(songs.get(old!.id)?.sourceFolder).toBe(before);
    expect(songs.get(mine!.id)?.sourceFolder).toBe(after);
  });
});
