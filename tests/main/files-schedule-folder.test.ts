/**
 * The schedule's «+» opens where it last added from (owner, 2026-11-24), kept across launches in
 * `files.scheduleFolder`; a folder that is gone falls back to the OS's choice, and a Media tab's «Agregar» keeps its
 * kind's folder and remembers nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  system: "",
  settings: new Map<string, unknown>(),
  opened: [] as OpenDialogOptions[],
  answer: [] as string[],
}));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "files-schedule-folder-"));
h.system = fs.mkdtempSync(path.join(root, "videos-"));
h.settings.set("files.scheduleFolder", null);
h.settings.set("files.defaultFolders", { video: null, image: null, audio: null, ppt: null });

vi.mock("../../src/main/paths", () => ({ systemMediaFolder: () => h.system }));
vi.mock("../../src/main/services/repos", () => ({
  getSettingsRepo: () => ({
    get: (key: string): unknown => h.settings.get(key),
    setMany: (partial: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(partial)) h.settings.set(key, value);
    },
  }),
}));
vi.mock("../../src/main/ipc/open-dialog", () => ({
  showOpenDialogFor: (_sender: unknown, options: OpenDialogOptions) => {
    h.opened.push(options);
    return Promise.resolve({ canceled: h.answer.length === 0, filePaths: h.answer });
  },
}));
vi.mock("../../src/main/media/thumbnail-service", () => ({ canDecodeImage: () => true }));

const event = { sender: {} } as IpcMainInvokeEvent;

test("the schedule's «+» opens where it last added from, until that folder is gone", async () => {
  const { filesHandlers } = await import("../../src/main/ipc/handlers/files");
  const pick = filesHandlers["files:pick"];
  const hymns = fs.mkdtempSync(path.join(root, "hymns-"));

  // First time: nothing remembered, the OS decides.
  h.answer = [path.join(hymns, "522.pps"), path.join(hymns, "23.pps")];
  await pick({ kind: "all", multiple: true }, event);
  expect(h.opened.at(-1)?.defaultPath).toBeUndefined();
  expect(h.settings.get("files.scheduleFolder")).toBe(hymns);

  // Next time, there; a cancelled pick remembers nothing new.
  h.answer = [];
  await pick({ kind: "all", multiple: true }, event);
  expect(h.opened.at(-1)?.defaultPath).toBe(hymns);
  expect(h.settings.get("files.scheduleFolder")).toBe(hymns);

  // A Media tab's «Agregar» keeps its kind's folder and does not move the schedule's.
  h.answer = [path.join(root, "clip.mp4")];
  await pick({ kind: "all", multiple: true, startIn: "video" }, event);
  expect(h.opened.at(-1)?.defaultPath).toBe(h.system);
  expect(h.settings.get("files.scheduleFolder")).toBe(hymns);

  // The pen drive is gone: the OS decides again.
  fs.rmSync(hymns, { recursive: true });
  h.answer = [];
  await pick({ kind: "all", multiple: true }, event);
  expect(h.opened.at(-1)?.defaultPath).toBeUndefined();
});
