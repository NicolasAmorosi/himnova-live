/**
 * The operator's five explicit saves (a program, a song, a song theme, a plate, a scene) reach the disk before they
 * answer: their write runs with `synchronous = FULL`, and the database is back on NORMAL after it, also when the save
 * throws. Everything else, the order of service's draft every 600 ms included, stays on NORMAL (2026-11-22 review,
 * DU-2). A TEMP trigger records the level SQLite sees at the very moment of each write, through the real handlers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { initRepos } from "../../src/main/services/repos";
import { listSongFolder } from "../../src/main/services/song-files";
import { DEFAULT_PLATE_STYLE } from "../../src/shared/types/overlay";
import { DEFAULT_SONG_THEME, type SongUpsert } from "../../src/shared/types/song";
import { defaultUtilityScenes } from "../../src/shared/types/utility";
import { parseLyrics } from "../../src/shared/song-text";
import mainEs from "../../src/main/i18n/messages/es";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: {}, screen: {} }));
vi.mock("../../src/main/slides/deck-service", () => ({ pinDecks: () => undefined }));
vi.mock("../../src/main/media/engine-sessions", () => ({ stopPreviewEngine: () => undefined }));
vi.mock("../../src/main/windows/close-guard", () => ({ resolveClose: () => undefined }));
vi.mock("../../src/main/songs/song-db-worker?nodeWorker", () => import("./support/song-db-worker-in-process"));

const { programsHandlers } = await import("../../src/main/ipc/handlers/programs");
const { songsHandlers } = await import("../../src/main/ipc/handlers/songs");
const { overlaysHandlers } = await import("../../src/main/ipc/handlers/overlays");
const { utilityHandlers } = await import("../../src/main/ipc/handlers/utility");
const { programDraftHandlers } = await import("../../src/main/ipc/handlers/program-draft");

const event = { sender: {} } as IpcMainInvokeEvent;
const FULL = 2;
const NORMAL = 1;
const WATCHED = ["programs", "songs", "song_themes", "overlay_plates", "utility_scenes", "program_draft"];

let tmpDir: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-durable-saves-"));
  const opened = openDatabase(path.join(tmpDir, "durable.db"));
  sqlite = opened.sqlite;
  runMigrations(opened.db, path.join(process.cwd(), "drizzle"));
  initRepos(opened.db, sqlite);
  sqlite.exec("CREATE TEMP TABLE seen (tbl TEXT, level INTEGER)");
  for (const table of WATCHED) {
    for (const op of ["INSERT", "UPDATE"]) {
      sqlite.exec(
        `CREATE TEMP TRIGGER seen_${table}_${op} AFTER ${op} ON main.${table} BEGIN ` +
          `INSERT INTO seen SELECT '${table}', synchronous FROM pragma_synchronous; END`,
      );
    }
  }
});

beforeEach(() => {
  sqlite.exec("DELETE FROM seen");
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The levels seen by the writes since the last reset, and the level now. */
function levels(): { during: number[]; after: number } {
  const during = sqlite.prepare("SELECT level FROM seen").pluck().all() as number[];
  return { during, after: sqlite.pragma("synchronous", { simple: true }) as number };
}

const song = (title: string): Omit<SongUpsert, "id"> => ({
  title,
  number: null,
  authors: null,
  copyright: null,
  ccliNumber: null,
  notes: null,
  sections: parseLyrics("[Estrofa 1]\nSublime gracia", "es").sections,
  order: [],
  themeId: null,
});

const plate = { name: "Pastor", kind: "lower-third", position: "bottom-left", title: "Juan", subtitle: "Pastor",
  imageAssetId: null, style: DEFAULT_PLATE_STYLE } as const;

describe("an explicit save syncs to disk", () => {
  test("a program: saved whole, and its name and notes", async () => {
    const saved = await programsHandlers["programs:save"]({ name: "Culto", notes: null, items: [] }, event);
    // Then the handler opens it (`lastOpenedAt`): not the operator's work, so NORMAL.
    expect(levels()).toEqual({ during: [FULL, NORMAL], after: NORMAL });
    sqlite.exec("DELETE FROM seen");
    await programsHandlers["programs:updateMeta"]({ id: saved.id, name: "Culto 2", notes: "n" }, event);
    expect(levels()).toEqual({ during: [FULL], after: NORMAL });
  });

  test("a song, created and saved again", async () => {
    const created = await songsHandlers["song:create"](song("Sublime gracia"), event);
    await songsHandlers["song:update"]({ ...song("Sublime gracia (2)"), id: created.id }, event);
    expect(levels()).toEqual({ during: [FULL, FULL], after: NORMAL });
  });

  test("a song of a file: the database write after the file's, still synced", async () => {
    const folder = path.join(tmpDir, "songbook");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "libro.cho"), "{title: Uno}\n{start_of_verse}\nLetra uno\n{end_of_verse}\n");
    const [uno] = await listSongFolder(folder);
    sqlite.exec("DELETE FROM seen");
    await songsHandlers["song:update"]({ ...song("Uno (2)"), id: uno!.id }, event);
    // First the file's new mtime, then the song: the second commit's sync takes the first along (one `-wal`).
    expect(levels()).toEqual({ during: [NORMAL, FULL], after: NORMAL });
    expect(fs.readFileSync(path.join(folder, "libro.cho"), "utf8")).toContain("Uno (2)");
  });

  test("a song theme, a plate and a scene, each created and saved again", async () => {
    const theme = await songsHandlers["songTheme:create"]({ name: "Tema", style: DEFAULT_SONG_THEME }, event);
    await songsHandlers["songTheme:update"]({ id: theme.id, name: "Tema 2", style: DEFAULT_SONG_THEME }, event);
    const created = await overlaysHandlers["overlay:create"](plate, event);
    await overlaysHandlers["overlay:update"]({ ...plate, id: created.id, name: "Pastor 2" }, event);
    const scene = defaultUtilityScenes(mainEs.seed)[0]!;
    const made = await utilityHandlers["utility:create"](scene, event);
    await utilityHandlers["utility:update"]({ ...scene, id: made.id, name: "Otra" }, event);
    expect(levels()).toEqual({ during: [FULL, FULL, FULL, FULL, FULL, FULL], after: NORMAL });
  });

  test("a save that throws leaves the database on NORMAL", () => {
    const missing = () =>
      programsHandlers["programs:save"]({ id: 999_999, name: "Nada", notes: null, items: [] }, event);
    expect(missing).toThrow();
    expect(levels()).toEqual({ during: [], after: NORMAL });
  });
});

test("the order of service's draft stays on NORMAL", async () => {
  const draft = { programId: null, name: "", notes: null, items: [], updatedAt: 1 };
  await programDraftHandlers["program:saveDraft"](draft, event);
  expect(levels()).toEqual({ during: [NORMAL], after: NORMAL });
});

test("the connection asks macOS for F_FULLFSYNC, without which a sync stops in the drive's cache", () => {
  expect(sqlite.pragma("fullfsync", { simple: true })).toBe(1);
});
