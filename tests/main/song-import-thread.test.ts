/**
 * An OpenLP or EasyWorship database is read on its own thread (`song-db-worker.ts`), never on main: its SQL is a
 * file's from anywhere, and a query that never ended held main, the projector and the engine's video with it, for
 * good (2026-11-22 audit, SE3). A read that does not answer is given up on at the clock, with the same error as a
 * database that cannot be read. The thread is electron-vite's `?nodeWorker`, replaced here by one that never answers:
 * a real one stuck inside SQLite cannot be stopped, and would hold this suite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import type { IpcError } from "../../src/shared/ipc/result";

const h = vi.hoisted(() => ({ jobs: [] as unknown[], terminated: 0 }));

vi.mock("../../src/main/services/repos", () => ({
  getSettingsRepo: () => ({ get: () => "es" }),
  getSongsRepo: () => ({ listLibrary: () => [], create: (song: unknown) => song }),
  getDbHandle: () => ({ sqlite: { transaction: (write: () => void) => write } }),
}));
vi.mock("../../src/main/songs/song-db-worker?nodeWorker", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: ({ workerData }: { workerData: unknown }) => {
      h.jobs.push(workerData);
      return Object.assign(new EventEmitter(), { terminate: () => ((h.terminated += 1), Promise.resolve(1)) });
    },
  };
});

const { SONG_DB_READ_TIMEOUT_MS, importEasyWorshipFolder, importOpenLpDatabase } = await import(
  "../../src/main/services/song-import"
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-import-thread-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

/** A database that reads well on main: without the thread the import ends at once, with the song. */
function sqlite(file: string, schema: string, insert: string): void {
  const db = new Database(file);
  db.exec(schema);
  db.exec(insert);
  db.close();
}
const openLp = path.join(dir, "songs.sqlite");
sqlite(
  openLp,
  "CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, lyrics TEXT, verse_order TEXT, copyright TEXT, comments TEXT, ccli_number TEXT)",
  `INSERT INTO songs (title, lyrics) VALUES ('Uno', '<song version="1.0"><lyrics><verse type="v" label="1"><![CDATA[uno]]></verse></lyrics></song>')`,
);
const easyWorship = path.join(dir, "Data");
fs.mkdirSync(easyWorship);
sqlite(
  path.join(easyWorship, "Songs.db"),
  "CREATE TABLE song (rowid INTEGER PRIMARY KEY, title TEXT, author TEXT, copyright TEXT, administrator TEXT, reference_number TEXT, vendor_id INTEGER)",
  "INSERT INTO song (rowid, title) VALUES (1, 'Uno')",
);
sqlite(
  path.join(easyWorship, "SongWords.db"),
  "CREATE TABLE word (rowid INTEGER PRIMARY KEY, song_id INTEGER, words TEXT)",
  "INSERT INTO word (song_id, words) VALUES (1, 'Verse 1\nuno')",
);

/** Real time, with `setTimeout` faked: `setInterval` stays real. */
const wait = (ms: number) =>
  new Promise<void>((done) => {
    const timer = setInterval(() => (clearInterval(timer), done()), ms);
  });

test.each([
  ["OpenLP", () => importOpenLpDatabase(openLp), { openLp }, "OPENLP_UNREADABLE"],
  ["EasyWorship", () => importEasyWorshipFolder(easyWorship), { easyWorship, locale: "es" }, "EW_UNREADABLE"],
])("%s: a read that never answers ends at the clock as unreadable, and main runs on meanwhile", async (_, run, job, code) => {
  // Fails without the thread: the read runs on main, and the import ends at once with the song.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  h.jobs = [];
  h.terminated = 0;
  let outcome = "pending";
  void run().then(
    () => (outcome = "imported"),
    (error: IpcError) => (outcome = error.code),
  );
  let ticks = 0;
  const beat = setInterval(() => (ticks += 1), 5);
  await wait(100);
  clearInterval(beat);
  expect(ticks).toBeGreaterThan(5);
  expect(outcome).toBe("pending");
  expect(h.jobs).toEqual([job]);

  await vi.advanceTimersByTimeAsync(SONG_DB_READ_TIMEOUT_MS - 1);
  expect(outcome).toBe("pending");
  await vi.advanceTimersByTimeAsync(1);
  expect(outcome).toBe(code);
  expect(h.terminated).toBe(1);
});
