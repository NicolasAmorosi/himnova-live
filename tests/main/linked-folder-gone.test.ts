/**
 * A linked folder's rows (`inLibrary = 0`) are not in the sweep: a file deleted from the folder kept a row with no
 * `missingSince`, and every reconcile probed it again. Listing the folder marks the ones that did not come back, and
 * nothing else: not the library's own rows, not a subfolder's, not another folder's, never a delete.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { MediaRepo } from "../../src/main/db/repositories/media.repo";

let tmpDir: string;
let opened: ReturnType<typeof openDatabase>;
let repo: MediaRepo;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-linked-gone-"));
  opened = openDatabase(path.join(tmpDir, "media.db"));
  runMigrations(opened.db, path.join(process.cwd(), "drizzle"));
  repo = new MediaRepo(opened.db, opened.sqlite);
});

afterAll(() => {
  opened.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function files(...names: string[]) {
  return names.map((name) => {
    const file = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name);
    return { path: file, stat: fs.statSync(file) };
  });
}

test("the rows of a listed folder that did not come back are marked missing, nothing else", () => {
  const folder = path.join(tmpDir, "Videos");
  const [kept, gone, sub, other] = repo.upsertBatch(files("Videos/kept.mp4", "Videos/gone.mp4", "Videos/sub/deep.mp4", "Otra/x.mp4"), "video", false).assets;
  const [library] = repo.upsertBatch(files("Videos/library.mp4"), "video", true).assets;

  repo.markAbsentFromFolder("video", folder, [kept!.path, library!.path]);

  expect(repo.getById(gone!.id)?.missingSince).not.toBeNull();
  for (const row of [kept, sub, other, library]) expect(repo.getById(row!.id)?.missingSince).toBeNull();

  // Back in the folder: the next listing's import clears it, as it always did.
  repo.upsertBatch(files("Videos/gone.mp4"), "video", false);
  expect(repo.getById(gone!.id)?.missingSince).toBeNull();
});
