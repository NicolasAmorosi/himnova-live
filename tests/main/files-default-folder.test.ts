/**
 * A file folder on a share that does not answer (a NAS turned off) held main ~21 s on Windows when «Agregar» asked
 * whether it was a folder: a synchronous stat to an IP that does not answer (measured 2026-11-16 on the owner's PC).
 * The dialog now opens within a second, in the system's folder (2026-11-15 audit, A26). The share is faked: a
 * synchronous stat that blocks 3 s, an asynchronous one that never answers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { expect, test, vi } from "vitest";

const NAS = "\\\\10.255.255.1\\Videos";
const h = vi.hoisted(() => ({ system: "", opened: [] as OpenDialogOptions[] }));
h.system = fs.mkdtempSync(path.join(os.tmpdir(), "files-default-folder-"));

vi.mock("../../src/main/paths", () => ({ systemMediaFolder: () => h.system }));
vi.mock("../../src/main/services/repos", () => ({ getSettingsRepo: () => ({ get: () => ({ video: NAS }) }) }));
vi.mock("../../src/main/ipc/open-dialog", () => ({
  showOpenDialogFor: (_sender: unknown, options: OpenDialogOptions) => {
    h.opened.push(options);
    return Promise.resolve({ canceled: true, filePaths: [] });
  },
}));
vi.mock("../../src/main/media/thumbnail-service", () => ({ canDecodeImage: () => true }));

const realStatSync = fs.statSync;
vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, ...rest: never[]) => {
  if (target !== NAS) return realStatSync(target, ...rest);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  throw Object.assign(new Error("UNKNOWN: unknown error, stat"), { code: "UNKNOWN" });
}) as typeof fs.statSync);
const realStat = fs.promises.stat;
const stat = vi
  .spyOn(fs.promises, "stat")
  .mockImplementation(((target: fs.PathLike, ...rest: never[]) =>
    target === NAS ? new Promise(() => undefined) : realStat(target, ...rest)) as typeof fs.promises.stat);

const event = { sender: {} } as IpcMainInvokeEvent;

test("a default folder on a share that does not answer opens the dialog within a second, in the system's folder", async () => {
  const { filesHandlers } = await import("../../src/main/ipc/handlers/files");
  const t0 = performance.now();
  await filesHandlers["files:pick"]({ kind: "video", multiple: false }, event);
  expect(performance.now() - t0).toBeLessThan(1500);
  expect(h.opened.at(-1)?.defaultPath).toBe(h.system);

  // A second «Agregar» while the first question still hangs asks nothing new: one stuck thread, not one per click.
  await filesHandlers["files:pick"]({ kind: "video", multiple: false }, event);
  expect(stat.mock.calls.filter(([target]) => target === NAS)).toHaveLength(1);
});
