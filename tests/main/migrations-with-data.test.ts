/**
 * Upgrading a database WITH ROWS from older schemas (2026-11-10 review, agent6 and agent3).
 *
 * The data-layer suite only ever migrated an empty file from 0000 to the last
 * migration, so a migration dropping rows or a backup never taken passed it all. Users upgrade a profile full of rows from whatever build they had:
 * this builds the database an old build left (migrations applied up to N, the
 * way that build applied them: one connection with `foreign_keys = ON`), fills
 * it with rows of every kind that schema had, and then upgrades it with the
 * app's own `backupBeforeMigrate` + `runMigrations`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDatabase } from "../../src/main/db/client";
import { backupBeforeMigrate, openForLaunch, repairDanglingReferences, runMigrations } from "../../src/main/db/migrate";
import { ProgramsRepo } from "../../src/main/db/repositories/programs.repo";

const drizzleDir = path.join(process.cwd(), "drizzle");
const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf-8")) as {
  entries: { idx: number; tag: string; when: number }[];
};

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worship-migrations-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A copy of `drizzle/` whose journal stops after the first `count` entries:
 *  the migrations folder of an older build. */
function folderUpTo(count: number): string {
  const dir = path.join(tmp, `drizzle-${count}`);
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  const entries = journal.entries.slice(0, count);
  for (const e of entries) fs.copyFileSync(path.join(drizzleDir, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return dir;
}

function migrateWith(file: string, count: number): void {
  const { sqlite, db } = openDatabase(file);
  try {
    migrate(db, { migrationsFolder: folderUpTo(count) });
  } finally {
    sqlite.close();
  }
}

const now = 1_789_000_000_000;

/** Every kind of row the schema of 0000..0003 holds (tables `services`,
 *  `service_items`… before the rename), as a 2.1-era profile would. */
function seedAtStage3(file: string): void {
  const s = new Database(file);
  s.pragma("foreign_keys = ON");
  s.exec(`
    INSERT INTO settings (key, value, updated_at) VALUES ('ui.theme', '"dark"', ${now}), ('logo.path', '"/x/logo.png"', ${now});
    INSERT INTO media_assets (id, kind, path, path_key, name, ext, size_bytes, mtime_ms, created_at, updated_at)
      VALUES (1, 'video', '/m/a.mp4', '/m/a.mp4', 'a', 'mp4', 10, 1, ${now}, ${now}),
             (2, 'ppt', '/m/h.pps', '/m/h.pps', 'h', 'pps', 20, 2, ${now}, ${now}),
             (3, 'audio', '/m/s.mp3', '/m/s.mp3', 's', 'mp3', 30, 3, ${now}, ${now});
    INSERT INTO bible_versions (id, code, name, installed_at) VALUES (1, 'rv1960', 'Reina-Valera 1960', ${now}), (2, 'kjv', 'Mine', ${now});
    INSERT INTO bible_books (id, version_id, position, abbrev, name, testament, chapter_count) VALUES (1, 1, 43, 'jn', 'Juan', 'NT', 21);
    INSERT INTO bible_verses (version_id, book_id, chapter, verse, text) VALUES (1, 1, 3, 16, 'Porque de tal manera amó Dios al mundo');
    INSERT INTO bible_favorites (version_code, book_abbrev, chapter, verse_from, verse_to, reference, created_at)
      VALUES ('rv1960', 'jn', 3, 16, 16, 'Juan 3:16', ${now});
    INSERT INTO services (id, name, service_date, created_at, updated_at, last_opened_at)
      VALUES (1, 'Culto sábado', ${now}, ${now}, ${now}, ${now}), (2, 'Culto miércoles', NULL, ${now}, ${now + 5}, NULL);
    INSERT INTO service_items (id, service_id, position, kind, media_asset_id, created_at) VALUES (10, 1, 0, 'media', 1, ${now});
    INSERT INTO service_items (id, service_id, position, kind, media_asset_id, created_at) VALUES (11, 1, 1, 'ppt', 2, ${now});
    INSERT INTO service_items (id, service_id, position, kind, bible_version_id, bible_book_id, bible_chapter, bible_verse_from, bible_verse_to, bible_reference, bible_text, created_at)
      VALUES (12, 1, 2, 'bible', 1, 1, 3, 16, 16, 'Juan 3:16', 'Porque de tal manera', ${now});
    INSERT INTO service_items (id, service_id, position, kind, media_asset_id, created_at) VALUES (13, 2, 0, 'media', 3, ${now});
    INSERT INTO projection_history (projected_at, kind, media_asset_id, service_id, snapshot_json) VALUES (${now}, 'media', 1, 1, '{}');
    INSERT INTO slide_decks (id, content_hash, render_width, image_format, converter_version, media_asset_id, source_path,
      source_size_bytes, source_mtime_ms, cache_dir, slide_count, status, created_at, updated_at, last_used_at)
      VALUES (5, 'abc', 1920, 'webp', 1, 2, '/m/h.pps', 20, 2, '/cache/abc', 2, 'ready', ${now}, ${now}, ${now});
    INSERT INTO deck_slides (deck_id, slide_index, image_file, thumb_file, width_px, height_px, bytes, advance_ms)
      VALUES (5, 0, '0.webp', '0t.webp', 1920, 1080, 100, 5000), (5, 1, '1.webp', '1t.webp', 1920, 1080, 100, NULL);
    INSERT INTO deck_audio (deck_id, audio_file, ext, bytes, origin, scope, loop) VALUES (5, 'a.wma', 'wma', 9, 'embedded', 'deck', 0);
  `);
  s.close();
}

/** What 0004..0018 added (2.2.0's schema): time scenes, plates, items of both
 *  kinds, a slide clip, a conversion row and the unsaved draft. */
function seedAtStage19(file: string): void {
  const s = new Database(file);
  s.pragma("foreign_keys = ON");
  s.exec(`
    INSERT INTO utility_scenes (id, name, tool, config_json, style_json, created_at, updated_at)
      VALUES (1, 'Cuenta regresiva', 'countdown', '{}', '{}', ${now}, ${now});
    INSERT INTO overlay_plates (id, name, kind, position, title, image_asset_id, style_json, created_at, updated_at)
      VALUES (1, 'Pastor', 'lower-third', 'bottom', 'Pr. Juan', NULL, '{}', ${now}, ${now});
    INSERT INTO program_items (id, program_id, position, kind, utility_scene_id, created_at) VALUES (20, 2, 1, 'utility', 1, ${now});
    INSERT INTO program_items (id, program_id, position, kind, overlay_plate_id, created_at) VALUES (21, 2, 2, 'plate', 1, ${now});
    INSERT INTO deck_videos (deck_id, slide_index, video_file, ext, bytes, rect_x, rect_y, rect_width, rect_height) VALUES (5, 1, 'v.mp4', 'mp4', 9, 0, 0, 1, 1);
    INSERT INTO media_conversions (media_asset_id, source_size, source_mtime_ms, probe_version, updated_at) VALUES (1, 10, 1, 1, ${now});
    INSERT INTO program_draft (id, program_id, name, items, updated_at) VALUES (1, 1, 'Culto sábado', '[]', ${now});
  `);
  s.close();
}

function count(s: Database.Database, table: string): number {
  return (s.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("upgrading a full profile from an older build", () => {
  test("0003 → 0018 → latest keeps every row, every id and every FK", () => {
    const file = path.join(tmp, "upgrade.db");
    migrateWith(file, 4);
    seedAtStage3(file);
    migrateWith(file, 19);
    seedAtStage19(file);

    const backupDir = path.join(tmp, "backups");
    const backup = backupBeforeMigrate(file, backupDir, drizzleDir);
    expect(backup.status).toBe("ok");

    const { sqlite, db } = openDatabase(file);
    runMigrations(db, drizzleDir);

    expect(count(sqlite, "programs")).toBe(2);
    expect(count(sqlite, "program_items")).toBe(6);
    expect(sqlite.prepare("SELECT id FROM program_items ORDER BY id").all().map((r) => (r as { id: number }).id)).toEqual([
      10, 11, 12, 13, 20, 21,
    ]);
    expect(count(sqlite, "deck_slides")).toBe(2);
    expect(count(sqlite, "deck_audio")).toBe(1);
    expect(count(sqlite, "deck_videos")).toBe(1);
    expect(count(sqlite, "projection_history")).toBe(1);
    expect(count(sqlite, "bible_verses")).toBe(1);
    expect(count(sqlite, "bible_favorites")).toBe(1);
    expect(count(sqlite, "utility_scenes")).toBe(1);
    expect(count(sqlite, "overlay_plates")).toBe(1);
    expect(count(sqlite, "program_draft")).toBe(1);
    expect(count(sqlite, "settings")).toBe(2);
    expect(sqlite.prepare("SELECT name FROM bible_versions ORDER BY id").all()).toEqual([
      { name: "Reina-Valera 1909" },
      { name: "Mine" },
    ]);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    // The table-level CHECK survived every rebuild.
    const ddl = (sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'program_items'").get() as { sql: string }).sql;
    expect(ddl).toContain("CHECK");
    expect(ddl).toContain("'song'");
    // FTS of the verse still finds it.
    expect(count(sqlite, "bible_verses_fts WHERE bible_verses_fts MATCH 'amo'")).toBe(1);

    // And the app reads it back.
    const programs = new ProgramsRepo(db, sqlite);
    const loaded = programs.peek(1);
    expect(loaded.items.map((i) => i.kind)).toEqual(["media", "ppt", "bible"]);
    sqlite.close();
  });

  test("every intermediate build N → latest, on an empty profile of that build", () => {
    for (let n = 1; n < journal.entries.length; n += 1) {
      const file = path.join(tmp, `step-${n}.db`);
      migrateWith(file, n);
      const { sqlite, db } = openDatabase(file);
      runMigrations(db, drizzleDir);
      expect(sqlite.pragma("foreign_key_check"), `from ${n}`).toEqual([]);
      sqlite.close();
    }
  });

  /**
   * The rebuilds of `program_items` (0009/0011/0015/0019) copy every row with
   * `foreign_keys = ON`: a single program row that already points at nothing —
   * the same kind of dangling reference as the 184 orphan deck rows of
   * 2026-09-15, whose cause was never found — aborts the WHOLE upgrade, and the
   * app refuses to start on every launch after that.
   */
  test("one dangling reference in program_items is repaired, and the upgrade goes on", () => {
    const file = path.join(tmp, "dangling.db");
    migrateWith(file, 19);
    const s = new Database(file);
    s.exec(`
      INSERT INTO media_assets (id, kind, path, path_key, name, ext, created_at, updated_at) VALUES (7, 'video', '/v', '/v', 'v', 'mp4', 1, 1);
      INSERT INTO media_assets (id, kind, path, path_key, name, ext, created_at, updated_at) VALUES (8, 'video', '/w', '/w', 'w', 'mp4', 1, 1);
      INSERT INTO programs (id, name, created_at, updated_at) VALUES (1, 'p', 1, 1);
      INSERT INTO program_items (program_id, position, kind, media_asset_id, created_at) VALUES (1, 0, 'media', 7, 1);
      INSERT INTO program_items (program_id, position, kind, media_asset_id, created_at) VALUES (1, 1, 'media', 8, 1);
    `);
    // Writes done with foreign keys OFF (another connection: a tool, the sqlite3 CLI, …).
    s.pragma("foreign_keys = OFF");
    s.exec(`
      DELETE FROM media_assets WHERE id = 7;
      INSERT INTO program_items (program_id, position, kind, bible_version_id, bible_book_id, bible_chapter, bible_verse_from, bible_verse_to, bible_reference, bible_text, created_at)
        VALUES (1, 2, 'bible', 99, 99, 3, 16, 16, 'Juan 3:16', 'Porque de tal manera', 1);
    `);
    s.close();

    const { sqlite, db } = openDatabase(file);
    // RESTRICT (the media row) goes; SET NULL (the verse's version and book) is cleared and stays.
    expect(repairDanglingReferences(sqlite)).toBe(3);
    runMigrations(db, drizzleDir);
    expect(count(sqlite, "__drizzle_migrations")).toBe(journal.entries.length);
    expect(sqlite.prepare("SELECT kind, media_asset_id AS asset FROM program_items ORDER BY position").all()).toEqual([
      { kind: "media", asset: 8 },
      { kind: "bible", asset: null },
    ]);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    sqlite.close();
  });
});


function userTableCounts(sqlite: ReturnType<typeof openDatabase>["sqlite"]): Record<string, number> {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' AND sql NOT LIKE 'CREATE VIRTUAL%'")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables
      .filter(({ name }) => !/_fts(_|$)/.test(name))
      .map(({ name }) => [name, (sqlite.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n]),
  );
}

test("a profile one migration behind is backed up, then migrated without losing a row", () => {
  const dbFile = path.join(tmp, "worship.db");
  const backups = path.join(tmp, "backups-previous");
  const old = openDatabase(dbFile);
  runMigrations(old.db, folderUpTo(journal.entries.length - 1));
  const now = Date.now();
  old.sqlite
    .prepare("INSERT INTO songs (title, sections_json, order_json, lyrics_text, created_at, updated_at) VALUES (?, '[]', '[]', ?, ?, ?)")
    .run("Cuán grande es Él", "Señor mi Dios", now, now);
  const before = userTableCounts(old.sqlite);
  old.sqlite.close();

  // The launch of the new release, as `index.ts` runs it: a verified snapshot first, because a migration IS
  // pending. Fails if the launch migrates before the backup (M11): nothing is pending by then, so no copy.
  const fresh = openForLaunch(dbFile, backups, drizzleDir, () => {});
  expect(fresh.backup.status).toBe("ok");
  const after = userTableCounts(fresh.sqlite);
  fresh.sqlite.close();
  for (const [table, rows] of Object.entries(before)) expect({ table, rows: after[table] }).toEqual({ table, rows });

  // The next launch has nothing pending: no copy that would rotate the pre-migration one out.
  expect(backupBeforeMigrate(dbFile, backups, drizzleDir).status).toBe("skipped");
});
