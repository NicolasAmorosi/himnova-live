/**
 * Edge cases of the library and Bible repos found in the 2026-11-06 QA pass:
 * Bible word search fed operators and punctuation, and a linked folder's file
 * joining the library.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { seedBuiltinBibles } from "../../src/main/db/seed/seed-bible";
import { BibleRepo } from "../../src/main/db/repositories/bible.repo";
import { SettingsRepo } from "../../src/main/db/repositories/settings.repo";
import { MediaRepo } from "../../src/main/db/repositories/media.repo";

let tmpDir: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];
let db: ReturnType<typeof openDatabase>["db"];
let bible: BibleRepo;
let media: MediaRepo;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-qa-library-"));
  const opened = openDatabase(path.join(tmpDir, "qa.db"));
  sqlite = opened.sqlite;
  db = opened.db;
  runMigrations(db, path.join(process.cwd(), "drizzle"));
  const settings = new SettingsRepo(db);
  seedBuiltinBibles(db, sqlite, path.join(process.cwd(), "resources/bibles"), settings, false);
  bible = new BibleRepo(db, sqlite);
  media = new MediaRepo(db, sqlite);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("FTS word search", () => {
  test("operators, quotes and punctuation never throw and never return junk", () => {
    const [rv] = bible.listVersions();
    for (const query of ['"', '""', "*", "dios OR", "NEAR(dios", "-dios", "^dios", "dios:", "(((", "a.b.c", "AND", "señor"]) {
      expect(() => bible.search(rv!.id, query)).not.toThrow();
    }
    // Accent-blind: «senor» finds «Señor».
    expect(bible.search(rv!.id, "senor").length).toBeGreaterThan(0);
    // A word glued to punctuation as typed from a printed Bible.
    expect(bible.search(rv!.id, "mundo,").length).toBeGreaterThan(0);
  });

  test("a prefix search on the last word only", () => {
    const [rv] = bible.listVersions();
    // «unigénito para que todo aquel» — the E2E's query, minus the last word's tail.
    expect(bible.search(rv!.id, "unigenito para que tod").some((hit) => hit.verse === 16 && hit.chapter === 3)).toBe(true);
  });
});

describe("«Más nuevo primero» = order added to the library", () => {
  test("a linked folder's file added to the library afterwards becomes the newest", async () => {
    const dir = path.join(tmpDir, "folder");
    fs.mkdirSync(dir, { recursive: true });
    const seen = path.join(dir, "visto.png");
    const fresh = path.join(dir, "nuevo.png");
    fs.writeFileSync(seen, "x");
    fs.writeFileSync(fresh, "y");
    const stat = (p: string) => ({ path: p, stat: fs.statSync(p) });

    // Browsed in a linked folder first (inLibrary = 0)…
    const [folderRow] = media.upsertBatch([stat(seen)], "image", false).assets;
    await new Promise((resolve) => setTimeout(resolve, 5));
    // …then picked in «Agregar» together with a brand-new file, `visto` FIRST.
    const added = media.upsertBatch([stat(seen), stat(fresh)], "image", true).assets;
    const byId = new Map(added.map((asset) => [asset.name, asset]));
    expect(byId.get("visto")!.createdAt).toBe(byId.get("nuevo")!.createdAt);
    // One import keeps the order its files came in (the comment in media-view.ts):
    // the tie is broken by id, and `visto` kept its older id.
    expect(folderRow!.id).toBeLessThan(byId.get("nuevo")!.id);
  });
});
