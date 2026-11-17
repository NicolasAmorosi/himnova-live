/**
 * A deck read again puts its new clips folder where the old one was (`replaceFolder`). The old one was deleted first:
 * when the new one then could not be moved in (a clip held by Defender or by PREVIEW's engine) or the row could not
 * be written, the ready row was left over a deleted folder and its clips answered 404 (review of the 2026-11-15
 * audit, D6).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { replaceFolder } from "../../src/main/fs-retry";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "replace-folder-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function folder(name: string, content: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "clip.txt"), content);
  return dir;
}
const read = (dir: string) => fs.readFileSync(path.join(dir, "clip.txt"), "utf8");

test("the new folder takes the old one's place, and the old one goes once the row is written", async () => {
  const target = folder("ok", "old");
  const staging = folder("ok.tmp", "new");
  expect(await replaceFolder(target, staging, () => 7)).toBe(7);
  expect(read(target)).toBe("new");
  expect(fs.readdirSync(root).filter((name) => name.startsWith("ok"))).toEqual(["ok"]);
});

test("a new folder that cannot be moved in leaves the old one where it was", async () => {
  const target = folder("held", "old");
  const missing = path.join(root, "held.tmp");
  await expect(replaceFolder(target, missing, () => 7)).rejects.toThrow();
  expect(read(target)).toBe("old");
  expect(fs.readdirSync(root).filter((name) => name.startsWith("held"))).toEqual(["held"]);
});

test("a row that cannot be written puts the old folder back and drops the new one", async () => {
  const target = folder("row", "old");
  const staging = folder("row.tmp", "new");
  await expect(
    replaceFolder(target, staging, () => {
      throw new Error("SQLITE_FULL");
    }),
  ).rejects.toThrow("SQLITE_FULL");
  expect(read(target)).toBe("old");
  expect(fs.readdirSync(root).filter((name) => name.startsWith("row"))).toEqual(["row"]);
});

test("no new folder: the old one goes once the row is written, and nothing is there before", async () => {
  const target = folder("none", "old");
  await replaceFolder(target, null, () => undefined);
  expect(fs.existsSync(target)).toBe(false);
  const fresh = path.join(root, "fresh");
  const staging = folder("fresh.tmp", "new");
  await replaceFolder(fresh, staging, () => undefined);
  expect(read(fresh)).toBe("new");
});

test("a first folder whose row cannot be written does not stay behind", async () => {
  const target = path.join(root, "first");
  const staging = folder("first.tmp", "new");
  await expect(
    replaceFolder(target, staging, () => {
      throw new Error("SQLITE_FULL");
    }),
  ).rejects.toThrow("SQLITE_FULL");
  expect(fs.readdirSync(root).filter((name) => name.startsWith("first"))).toEqual([]);
});
