/**
 * Reading an EasyWorship database opens two files (`Songs.db`, `SongWords.db`): whatever fails, both are closed, so
 * the app never keeps EasyWorship's own file open until it quits (on Windows, that is a lock on it).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, expect, test, vi } from "vitest";
import { readEasyWorship } from "../../src/main/songs/easyworship";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-close-"));

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Songs.db is closed when SongWords.db cannot be opened", () => {
  const songs = new Database(path.join(dir, "Songs.db"));
  songs.exec("CREATE TABLE song (title TEXT, author TEXT, copyright TEXT, administrator TEXT, reference_number TEXT, vendor_id TEXT)");
  songs.close();
  // SongWords.db gone between the folder check and the read (moved, a drive unplugged).
  const close = vi.spyOn(Database.prototype, "close");

  expect(() => readEasyWorship(dir, "es")).toThrow();
  expect(close).toHaveBeenCalledOnce();
});
