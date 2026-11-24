/**
 * The schedule's row on air (`programs.liveRow`) is what the next launch puts back in PREVIEW, so it must survive
 * everything but a clean close: the control window's page answering «close» clears it (`window:closeDecision`,
 * `forgetLiveRow`), and a crash, a killed process, a power cut or a hung window closed by the grace never get there
 * (owner, 2026-11-23, DU-6). The renderer's half is `tests/renderer/live-row-restore.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { getSettingsRepo, initRepos } from "../../src/main/services/repos";
import type { CloseDecision } from "../../src/shared/types/window";

const { win, resolveClose } = vi.hoisted(() => ({ win: {}, resolveClose: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: { fromWebContents: () => win },
  screen: {},
}));
vi.mock("../../src/main/slides/deck-service", () => ({ pinDecks: () => undefined }));
vi.mock("../../src/main/media/engine-sessions", () => ({ stopPreviewEngine: () => undefined }));
vi.mock("../../src/main/windows/close-guard", () => ({ resolveClose }));

const { forgetLiveCopy, programDraftHandlers } = await import("../../src/main/ipc/handlers/program-draft");

const mark = { position: 6, row: JSON.stringify({ kind: "song", songId: 3, title: "Himno 7" }) };
let tmpDir: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];

/** Read back from the table, not the cache: what a launch after a crash finds. */
function storedMark(): unknown {
  getSettingsRepo().forget();
  return getSettingsRepo().getAll()["programs.liveRow"];
}

function answer(decision: CloseDecision): void {
  void programDraftHandlers["window:closeDecision"]({ decision }, { sender: {} } as IpcMainInvokeEvent);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-live-row-"));
  const opened = openDatabase(path.join(tmpDir, "live-row.db"));
  sqlite = opened.sqlite;
  runMigrations(opened.db, path.join(process.cwd(), "drizzle"));
  initRepos(opened.db, sqlite);
});

beforeEach(() => {
  getSettingsRepo().setMany({ "programs.liveRow": mark });
  resolveClose.mockClear();
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("the page answering «close» clears the row on air before the window closes; the database keeps it until then", () => {
  expect(storedMark()).toEqual(mark);
  answer("hold");
  answer("cancel");
  expect(storedMark()).toEqual(mark);
  answer("close");
  // Fails if a clean close leaves the mark: every normal launch would open with a row in PREVIEW.
  expect(storedMark()).toBeNull();
  expect(resolveClose).toHaveBeenLastCalledWith(win, "close");
});

test("a window closed with no answer keeps the row on air (a hung page closed by the grace)", () => {
  // What the window's `closed` runs, whoever closed it.
  forgetLiveCopy();
  // Fails if the grace's close clears the mark: the frozen app the operator ended by hand comes back with nothing.
  expect(storedMark()).toEqual(mark);
});
