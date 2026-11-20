/**
 * `MediaRepo.relocate` onto a file the library already has a row for.
 *
 * The normal case, not an edge one: most of a real library comes from linked
 * folders, so once a drive comes back under another letter and its folder is
 * re-linked, the file the operator relocates a missing item to is already a
 * row. That used to break `ux_media_path`'s UNIQUE. Now the two rows merge into
 * the one the schedule references, and nothing that pointed at either is lost.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { MediaRepo } from "../../src/main/db/repositories/media.repo";
import { ProgramsRepo } from "../../src/main/db/repositories/programs.repo";
import { OverlaysRepo } from "../../src/main/db/repositories/overlays.repo";
import { DEFAULT_PLATE_STYLE } from "../../src/shared/types/overlay";
import { SlidesRepo } from "../../src/main/db/repositories/slides.repo";
import { SLIDES_NATIVE_VERSION } from "../../src/shared/constants";
import { upsertFile } from "./support/upsert-file";

let dir: string;
let handle: ReturnType<typeof openDatabase>;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-relocate-"));
  handle = openDatabase(path.join(dir, "worship.db"));
  runMigrations(handle.db, path.join(process.cwd(), "drizzle"));
});

afterAll(() => {
  handle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("relocating onto a file the library already has merges the two rows", () => {
  const media = new MediaRepo(handle.db, handle.sqlite);
  const programs = new ProgramsRepo(handle.db, handle.sqlite);
  const plates = new OverlaysRepo(handle.db, handle.sqlite);

  const oldPath = path.join(dir, "E", "logo.png");
  const newPath = path.join(dir, "F", "logo.png");
  for (const file of [oldPath, newPath]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "png");
  }
  const original = upsertFile(media, oldPath, "image", true);
  // The re-linked folder registered the same file at its new letter.
  const duplicate = upsertFile(media, newPath, "image", false);
  fs.rmSync(oldPath);

  const program = programs.save({
    name: "Culto",
    items: [
      { kind: "media", mediaAssetId: original.id, title: null },
      { kind: "media", mediaAssetId: duplicate.id, title: null },
    ],
  });
  const plate = plates.create({
    name: "Mosca",
    kind: "bug",
    position: "top-right",
    title: null,
    subtitle: null,
    imageAssetId: duplicate.id,
    style: DEFAULT_PLATE_STYLE,
  });

  const relocated = media.relocate(original.id, newPath);

  expect(relocated?.asset).toMatchObject({ id: original.id, path: newPath, inLibrary: true, missingSince: null });
  expect(media.getById(duplicate.id)).toBeNull();
  // Named, so the renderer moves the open order of service off the deleted id too (audit D4): left on it, «Guardar»
  // failed on its foreign key and the draft dropped those rows at the next launch.
  expect(relocated?.merged).toEqual({ from: duplicate.id, to: original.id });
  // What is on the air keeps the id it went out with: its file keeps coming under it, for the ranges a video reads
  // as it plays and for a projector reopened.
  expect(media.survivingId(duplicate.id)).toBe(original.id);
  expect(media.getPathById(media.survivingId(duplicate.id))).toBe(newPath);
  expect(media.survivingId(9999)).toBe(9999);
  // Never in the shared getter: a deck read under the dead id would write rows its foreign key refuses.
  expect(media.getPathById(duplicate.id)).toBeNull();
  expect(programs.load(program.id).items.map((item) => (item.kind === "media" ? item.mediaAssetId : null))).toEqual([
    original.id,
    original.id,
  ]);
  expect(plates.list().find((p) => p.id === plate.id)?.imageAssetId).toBe(original.id);
});

test("a deck read before its file moved is served from where the file is now, once relocated (audit D1)", () => {
  // The hymnal read last week from E:, the stick back as F: with the same file and the same date. «Locate…» moved the
  // library row and left the deck row at E:: its size and date still matched, so it was served as is, and every
  // picture of it came back 410 (blank PREVIEW and projector).
  const media = new MediaRepo(handle.db, handle.sqlite);
  const slides = new SlidesRepo(handle.db, handle.sqlite);
  const oldPath = path.join(dir, "USB-E", "Himnario", "035.pps");
  const newPath = path.join(dir, "USB-F", "Himnario", "035.pps");
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(oldPath, "pps bytes");
  const asset = upsertFile(media, oldPath, "ppt", false);
  const stat = fs.statSync(oldPath);
  const deckId = slides.insertDeck(
    {
      contentHash: "h035",
      renderWidth: 0,
      imageFormat: "native",
      converterVersion: SLIDES_NATIVE_VERSION,
      mediaAssetId: asset.id,
      sourcePath: oldPath,
      sourceSizeBytes: stat.size,
      sourceMtimeMs: Math.trunc(stat.mtimeMs),
      cacheDir: "",
      aspectRatio: "4:3",
      timingsSource: "none",
      bytesOnDisk: 0,
    },
    [
      {
        slideIndex: 1,
        imageFile: "",
        thumbFile: "",
        widthPx: 1,
        heightPx: 1,
        bytes: 0,
        advanceMs: null,
        advanceOnClick: true,
        transition: null,
        hidden: false,
        title: null,
        notes: null,
        layers: "[]",
      },
    ],
    [],
  );
  fs.renameSync(oldPath, newPath);

  media.relocate(asset.id, newPath);

  expect(slides.findSourceDeckByAsset(asset.id, "native")?.sourcePath).toBe(newPath);
  expect(slides.getSlideImage(deckId, 1, "full")?.sourcePath).toBe(newPath);
});

test("a merge counts once committed: one rolled back with a later move of the same relocate never happened", () => {
  // A whole moved folder is one transaction (`relocateMany`). A later move throwing rolls the merge back and the twin
  // is a row again; recorded anyway, its file was served from the other row for the rest of the session.
  const media = new MediaRepo(handle.db, handle.sqlite);
  const file = (name: string) => {
    const at = path.join(dir, "rollback", name);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, "mp4");
    return at;
  };
  const moved = upsertFile(media, file("moved.mp4"), "video", true);
  const twin = upsertFile(media, file("twin.mp4"), "video", false);
  const other = upsertFile(media, file("other.mp4"), "video", true);
  const failing = { get size(): number { throw new Error("the drive went away"); }, mtimeMs: 1 } as fs.Stats;

  expect(() =>
    media.relocateMany([
      { id: moved.id, path: twin.path, stat: fs.statSync(twin.path) },
      { id: other.id, path: file("other-new.mp4"), stat: failing },
    ]),
  ).toThrow("the drive went away");

  expect(media.getById(twin.id)?.path).toBe(twin.path);
  expect(media.survivingId(twin.id)).toBe(twin.id);

  // The same merge committed is recorded, nested in `relocateMany` as it is.
  expect(media.relocateMany([{ id: moved.id, path: twin.path, stat: fs.statSync(twin.path) }]).merged).toEqual([
    { from: twin.id, to: moved.id },
  ]);
  expect(media.survivingId(twin.id)).toBe(moved.id);
});
