/**
 * Overlay plates on the main side: the validator/normalizer pair and the repo.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { OverlaysRepo } from "../../src/main/db/repositories/overlays.repo";
import { isPlateStyle, isPlateUpsert, normalizePlateStyle } from "../../src/shared/overlay-validators";
import { DEFAULT_PLATE_STYLE, type Plate } from "../../src/shared/types/overlay";

const drizzleDir = path.join(process.cwd(), "drizzle");

let tmpDir: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];
let repo: OverlaysRepo;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-overlays-"));
  const opened = openDatabase(path.join(tmpDir, "overlays.db"));
  sqlite = opened.sqlite;
  runMigrations(opened.db, drizzleDir);
  repo = new OverlaysRepo(opened.db, sqlite);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function lowerThird(overrides: Partial<Omit<Plate, "id">> = {}): Omit<Plate, "id"> {
  return {
    name: "Pastor Juan Pérez",
    kind: "lower-third",
    position: "bottom-left",
    title: "Juan Pérez",
    subtitle: "Pastor",
    imageAssetId: null,
    style: DEFAULT_PLATE_STYLE,
    ...overrides,
  };
}

function insertImage(): number {
  const file = `/tmp/logo-${Math.random()}.png`;
  return Number(
    sqlite
      .prepare(
        "INSERT INTO media_assets (kind, path, path_key, name, ext, created_at, updated_at) VALUES ('image', ?, ?, 'logo', 'png', 0, 0)",
      )
      .run(file, file).lastInsertRowid,
  );
}

describe("the plate validator", () => {
  test("accepts a whole plate and every default", () => {
    expect(isPlateUpsert(lowerThird())).toBe(true);
    expect(isPlateStyle(DEFAULT_PLATE_STYLE)).toBe(true);
  });

  test("a plate has to draw something", () => {
    expect(isPlateUpsert(lowerThird({ title: null, subtitle: "  " }))).toBe(false);
    expect(isPlateUpsert(lowerThird({ kind: "bug", position: "top-right", title: null, subtitle: null }))).toBe(
      false,
    );
    expect(
      isPlateUpsert(lowerThird({ kind: "bug", position: "top-right", title: null, subtitle: null, imageAssetId: 3 })),
    ).toBe(true);
  });

  test("a position its kind does not allow, and a lower third with an image, are refused", () => {
    expect(isPlateUpsert(lowerThird({ position: "top-right" }))).toBe(false);
    expect(isPlateUpsert(lowerThird({ imageAssetId: 3 }))).toBe(false);
  });

  test("a banner takes any position, draws text, and never carries an image", () => {
    const banner = lowerThird({ kind: "banner", position: "top-center" });
    expect(isPlateUpsert(banner)).toBe(true);
    expect(isPlateUpsert({ ...banner, imageAssetId: 3 })).toBe(false);
    expect(isPlateUpsert({ ...banner, title: null, subtitle: null })).toBe(false);
    const running = { ...DEFAULT_PLATE_STYLE, ticker: { enabled: true, speedCqw: 500 } };
    expect(isPlateUpsert({ ...banner, style: running })).toBe(false);
  });

  test("a row written before the ticker existed reads with the default ticker", () => {
    const { ticker: _ticker, ...before } = DEFAULT_PLATE_STYLE;
    const read = normalizePlateStyle({ ...before, marginCqw: 7 });
    expect(read.ticker).toEqual(DEFAULT_PLATE_STYLE.ticker);
    expect(read.marginCqw).toBe(7);
  });

  test("a row written before auto-hide existed reads with it off, and an out-of-range time is refused", () => {
    const { autoHide: _autoHide, ...before } = DEFAULT_PLATE_STYLE;
    expect(normalizePlateStyle(before).autoHide).toEqual({ enabled: false, afterMs: 10_000 });
    expect(isPlateStyle({ ...DEFAULT_PLATE_STYLE, autoHide: { enabled: true, afterMs: 500 } })).toBe(false);
  });

  test("a row written before rounded corners existed reads square, and a radius past the cap is refused", () => {
    const { cornerRadiusCqw: _corners, ...before } = DEFAULT_PLATE_STYLE;
    expect(normalizePlateStyle(before).cornerRadiusCqw).toBe(0);
    expect(normalizePlateStyle({ ...before, cornerRadiusCqw: 1.5 }).cornerRadiusCqw).toBe(1.5);
    expect(isPlateStyle({ ...DEFAULT_PLATE_STYLE, cornerRadiusCqw: 50 })).toBe(false);
  });

  test("a band never holds an image background", () => {
    const style = { ...DEFAULT_PLATE_STYLE, background: { kind: "image", assetId: 1, fit: "cover" } };
    expect(isPlateStyle(style)).toBe(false);
  });

  test("whatever the normalizer returns, the validator accepts — and one bad field costs only that field", () => {
    for (const raw of [null, "x", {}, { title: { sizeCqw: -1 } }, { ...DEFAULT_PLATE_STYLE, backgroundOpacity: 7 }]) {
      expect(isPlateStyle(normalizePlateStyle(raw))).toBe(true);
    }
    const kept = normalizePlateStyle({ ...DEFAULT_PLATE_STYLE, marginCqw: 9, backgroundOpacity: "a lot" });
    expect(kept.marginCqw).toBe(9);
    expect(kept.backgroundOpacity).toBe(DEFAULT_PLATE_STYLE.backgroundOpacity);
  });
});

describe("OverlaysRepo", () => {
  test("round-trips create, update, duplicate and delete, newest on top", () => {
    const first = repo.create(lowerThird({ name: "  Primera  " }));
    expect(first.name).toBe("Primera");
    const second = repo.create(lowerThird({ name: "Segunda" }));
    expect(repo.list().map((p) => p.id)).toEqual([second.id, first.id]);

    const updated = repo.update(first.id, lowerThird({ name: "Primera", title: "Otro" }));
    expect(updated.title).toBe("Otro");
    const copy = repo.duplicate(first.id, "Primera (copia)");
    expect(copy).toMatchObject({ name: "Primera (copia)", title: "Otro" });

    expect(repo.reorder([first.id, second.id, copy.id]).map((p) => p.id)).toEqual([first.id, second.id, copy.id]);
    for (const plate of repo.list()) repo.delete(plate.id);
    expect(repo.list()).toEqual([]);
  });

  test("a broken row still comes back as a plate that projects", () => {
    const id = Number(
      sqlite
        .prepare(
          "INSERT INTO overlay_plates (name, kind, position, title, style_json, created_at, updated_at) VALUES ('Rota', 'lower-third', 'top-left', 'Hola', '{not json', 0, 0)",
        )
        .run().lastInsertRowid,
    );
    const plate = repo.get(id)!;
    expect(plate.position).toBe("bottom-left");
    expect(plate.style).toEqual(DEFAULT_PLATE_STYLE);
    repo.delete(id);
  });

  test("removing a bug's image from the library keeps the bug, without its picture", () => {
    const assetId = insertImage();
    const bug = repo.create(lowerThird({ kind: "bug", position: "top-right", imageAssetId: assetId }));
    sqlite.prepare("DELETE FROM media_assets WHERE id = ?").run(assetId);
    expect(repo.get(bug.id)).toMatchObject({ imageAssetId: null, title: "Juan Pérez" });
    repo.delete(bug.id);
  });
});
