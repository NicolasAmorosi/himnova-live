import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { MediaRepo } from "../../src/main/db/repositories/media.repo";
import { SlidesRepo } from "../../src/main/db/repositories/slides.repo";
import { SLIDES_CONVERTER_VERSION } from "../../src/shared/constants";

/** A profile copied elsewhere: its rows still name the original's folders. */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-cache-root-"));
const { db, sqlite } = openDatabase(path.join(tmpDir, "worship.db"));
runMigrations(db, path.join(process.cwd(), "drizzle"));
const slidesRepo = new SlidesRepo(db, sqlite);
const mediaRepo = new MediaRepo(db, sqlite);

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function deckAt(cacheDir: string, name: string): number {
  const file = path.join(tmpDir, `${name}.pptx`);
  fs.writeFileSync(file, name);
  const asset = mediaRepo.upsertFromPath(file, "ppt", true);
  return slidesRepo.insertDeck(
    {
      contentHash: name.padEnd(64, "0"),
      renderWidth: 1920,
      imageFormat: "webp",
      converterVersion: SLIDES_CONVERTER_VERSION,
      mediaAssetId: asset.id,
      sourcePath: file,
      sourceSizeBytes: name.length,
      sourceMtimeMs: 1,
      cacheDir,
      aspectRatio: "16:9",
      timingsSource: "none",
      bytesOnDisk: 1,
    },
    [],
    [],
  );
}

test("a copied profile's decks point at this cache, and nothing outside it is touched", () => {
  const original = path.join(tmpDir, "original", "slides-cache");
  const here = path.join(tmpDir, "copy", "slides-cache");
  for (const name of ["aaa-1920-webp", "bbb-1920-webp"]) fs.mkdirSync(path.join(original, name), { recursive: true });
  // The copy brought one of the two folders along.
  fs.mkdirSync(path.join(here, "aaa-1920-webp"), { recursive: true });

  const copied = deckAt(path.join(original, "aaa-1920-webp"), "aaa");
  const lost = deckAt(path.join(original, "bbb-1920-webp"), "bbb");
  const windows = deckAt("C:\\Users\\ana\\AppData\\Roaming\\worship-app\\slides-cache\\aaa-1920-webp", "ccc");
  const local = deckAt(path.join(here, "aaa-1920-webp"), "ddd");

  expect(slidesRepo.adoptCacheRoot(here)).toEqual({ rebased: 2, forgotten: 1 });
  expect(slidesRepo.getDeckById(copied)?.cacheDir).toBe(path.join(here, "aaa-1920-webp"));
  expect(slidesRepo.getDeckById(windows)?.cacheDir).toBe(path.join(here, "aaa-1920-webp"));
  expect(slidesRepo.getDeckById(lost)).toBeNull();
  expect(slidesRepo.getDeckById(local)?.cacheDir).toBe(path.join(here, "aaa-1920-webp"));
  // Forgetting a row never deletes its folder: it belongs to the original.
  expect(fs.existsSync(path.join(original, "bbb-1920-webp"))).toBe(true);
  // Idempotent: a second launch has nothing left to adopt.
  expect(slidesRepo.adoptCacheRoot(here)).toEqual({ rebased: 0, forgotten: 0 });
});
