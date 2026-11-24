/**
 * The five editors' unsaved forms (`editor_drafts`, owner 2026-11-23, DU-1): one row per editor, through the real
 * migrations and handlers. The renderer's half (the hook, the notice) is `tests/renderer/editor-drafts.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { initRepos } from "../../src/main/services/repos";
import type { EditorDraft } from "../../src/shared/types/editor-draft";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: {}, screen: {} }));

const { editorDraftsHandlers } = await import("../../src/main/ipc/handlers/editor-drafts");

const event = { sender: {} } as IpcMainInvokeEvent;
let tmpDir: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-editor-drafts-"));
  const opened = openDatabase(path.join(tmpDir, "drafts.db"));
  sqlite = opened.sqlite;
  runMigrations(opened.db, path.join(process.cwd(), "drizzle"));
  initRepos(opened.db, sqlite);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const song: EditorDraft = {
  v: 1,
  editor: "song",
  id: null,
  name: "Himno nuevo",
  state: { currentId: null, draft: { title: "Himno nuevo", lyrics: "[Estrofa 1]\nuna línea" } },
  updatedAt: 2,
};
const plate: EditorDraft = { v: 1, editor: "plate", id: 4, name: "Bienvenida", state: { plateId: 4 }, updatedAt: 1 };
const save = (draft: EditorDraft | null, editor = draft?.editor ?? "song") =>
  editorDraftsHandlers["editors:saveDraft"]({ editor, draft }, event);
const load = () => editorDraftsHandlers["editors:loadDrafts"](undefined, event);

test("one row per editor, rewritten in place, read back oldest first, and gone once dropped", async () => {
  await save(song);
  await save(plate);
  await save({ ...song, name: "Himno nuevo 2", updatedAt: 3 });
  // Fails without the table and its channels: what the editors typed would not outlive the process.
  expect(await load()).toEqual([plate, { ...song, name: "Himno nuevo 2", updatedAt: 3 }]);
  await save(null, "song");
  await save(null, "plate");
  expect(await load()).toEqual([]);
});

test("a row this build cannot read is skipped, and a draft that is none is refused", async () => {
  sqlite.prepare("INSERT INTO editor_drafts (editor, draft, updated_at) VALUES ('scene', '{not json', 1)").run();
  sqlite.prepare("INSERT INTO editor_drafts (editor, draft, updated_at) VALUES ('program', ?, 1)").run(
    JSON.stringify({ ...plate, v: 2, editor: "program" }),
  );
  expect(await load()).toEqual([]);
  expect(() => save({ ...song, editor: "nope" } as unknown as EditorDraft, "song")).toThrow();
  expect(() => save(song, "plate")).toThrow();
  sqlite.prepare("DELETE FROM editor_drafts").run();
});
