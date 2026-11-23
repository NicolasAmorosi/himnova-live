/**
 * The schedule's row on air (`programs.liveRow`) is what the next launch puts back in PREVIEW, so it must survive
 * everything but a clean close: the control window closing clears it (`forgetLiveCopy`, from its `closed`), and a
 * crash, a killed process or a power cut never get there (owner, 2026-11-23, DU-6). The renderer's half is
 * `tests/renderer/live-row-restore.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { getSettingsRepo, initRepos } from "../../src/main/services/repos";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: {}, screen: {} }));
vi.mock("../../src/main/slides/deck-service", () => ({ pinDecks: () => undefined }));
vi.mock("../../src/main/media/engine-sessions", () => ({ stopPreviewEngine: () => undefined }));
vi.mock("../../src/main/windows/close-guard", () => ({ resolveClose: () => undefined }));

const { forgetLiveCopy } = await import("../../src/main/ipc/handlers/program-draft");

let tmpDir: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-live-row-"));
  const opened = openDatabase(path.join(tmpDir, "live-row.db"));
  sqlite = opened.sqlite;
  runMigrations(opened.db, path.join(process.cwd(), "drizzle"));
  initRepos(opened.db, sqlite);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("a clean close of the control window clears the row on air; the database keeps it until then", () => {
  const mark = { position: 6, row: JSON.stringify({ kind: "song", songId: 3, title: "Himno 7" }) };
  getSettingsRepo().setMany({ "programs.liveRow": mark });
  getSettingsRepo().forget();
  // Read back from the table, not the cache: what a launch after a crash finds.
  expect(getSettingsRepo().getAll()["programs.liveRow"]).toEqual(mark);
  forgetLiveCopy();
  getSettingsRepo().forget();
  // Fails if a clean close leaves the mark: every normal launch would open with a row in PREVIEW.
  expect(getSettingsRepo().getAll()["programs.liveRow"]).toBeNull();
});
