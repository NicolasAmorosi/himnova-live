/**
 * A setting another build wrote (newer, older, or a hand-edited row) is read through this build's validator: a scalar
 * that is not one of its values reads as the default, never reaches a `Select` with no option for it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { SettingsRepo } from "../../src/main/db/repositories/settings.repo";
import { DEFAULT_SETTINGS } from "../../src/shared/types/settings";

let tmpDir: string;
let opened: ReturnType<typeof openDatabase>;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-settings-read-"));
  opened = openDatabase(path.join(tmpDir, "settings.db"));
  runMigrations(opened.db, path.join(process.cwd(), "drizzle"));
});

afterAll(() => {
  opened.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const store = (key: string, value: unknown) =>
  opened.sqlite
    .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run(key, JSON.stringify(value), Date.now());

test("a scalar this build has no value for reads as its default", () => {
  store("ui.locale", "fr");
  store("stage.warnMs", 123);
  store("projection.transition.style", "zoom");
  store("media.volume", 3);
  const read = new SettingsRepo(opened.db).getAll();
  expect(read["ui.locale"]).toBe(DEFAULT_SETTINGS["ui.locale"]);
  expect(read["stage.warnMs"]).toBe(DEFAULT_SETTINGS["stage.warnMs"]);
  expect(read["projection.transition.style"]).toBe(DEFAULT_SETTINGS["projection.transition.style"]);
  expect(read["media.volume"]).toBe(DEFAULT_SETTINGS["media.volume"]);
});

test("a valid value is read as stored, and a structure is left as it is", () => {
  store("ui.locale", "it");
  store("media.volume", 0.4);
  // A folder list is the operator's own: not dropped whole because one entry is off.
  const folders = { video: ["/a"], image: [], audio: [], presentation: [], extra: [] };
  store("library.linkedFolders", folders);
  const read = new SettingsRepo(opened.db).getAll();
  expect(read["ui.locale"]).toBe("it");
  expect(read["media.volume"]).toBe(0.4);
  expect(read["library.linkedFolders"]).toEqual(folders);
});
