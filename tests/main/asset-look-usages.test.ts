/**
 * `ProgramsRepo.findUsages` names the looks drawn over a library file — the
 * LOGO's and the verse's backgrounds, a song theme's, a time scene's, a bug
 * plate's picture — next to the saved programs, so removing it warns first
 * (owner, 2026-11-06). No FK reaches a JSON style: this answer is the only
 * thing that does.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openDatabase } from "../../src/main/db/client";
import { runMigrations } from "../../src/main/db/migrate";
import { MediaRepo } from "../../src/main/db/repositories/media.repo";
import { ProgramsRepo } from "../../src/main/db/repositories/programs.repo";
import { SettingsRepo } from "../../src/main/db/repositories/settings.repo";
import { DEFAULT_BIBLE_STYLE } from "../../src/shared/types/bible-style";

let tmpDir: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];
let programsRepo: ProgramsRepo;
let used: number;
let unused: number;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-look-usages-"));
  const opened = openDatabase(path.join(tmpDir, "looks.db"));
  sqlite = opened.sqlite;
  runMigrations(opened.db, path.join(process.cwd(), "drizzle"));
  programsRepo = new ProgramsRepo(opened.db, sqlite);

  const files = ["fondo.png", "otra.png"].map((name) => {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, name);
    return { path: file, stat: fs.statSync(file) };
  });
  const [first, second] = new MediaRepo(opened.db, sqlite).upsertBatch(files, "image", true).assets;
  used = first!.id;
  unused = second!.id;

  const image = { kind: "image", assetId: used, fit: "cover" } as const;
  new SettingsRepo(opened.db).setMany({
    "logo.background": image,
    "bible.style": { ...DEFAULT_BIBLE_STYLE, background: image },
  });
  const now = Date.now();
  const insert = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params);
  insert(
    "INSERT INTO song_themes (name, style_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
    "Domingo",
    JSON.stringify({ background: { kind: "video", assetId: used, fit: "cover" } }),
    now,
    now,
  );
  insert(
    "INSERT INTO song_themes (name, style_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
    "Liso",
    JSON.stringify({ background: { kind: "solid", color: "#000000" } }),
    now,
    now,
  );
  const scene = "INSERT INTO utility_scenes (name, tool, config_json, style_json, created_at, updated_at) VALUES (?, 'clock', '{}', ?, ?, ?)";
  insert(scene, "Reloj", JSON.stringify({ background: image }), now, now);
  // A row that is not JSON costs that row, never the answer.
  insert(scene, "Rota", "not json", now, now);
  insert(
    "INSERT INTO overlay_plates (name, kind, position, image_asset_id, style_json, created_at, updated_at) VALUES ('Marca', 'bug', 'top-right', ?, '{}', ?, ?)",
    used,
    now,
    now,
  );
  programsRepo.save({ name: "Culto", items: [{ kind: "media", mediaAssetId: used, title: null }] });
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("a file under every kind of look is named in each, beside its saved program", () => {
  const { programs, looks } = programsRepo.findUsages(used);
  expect(programs.map((usage) => usage.programName)).toEqual(["Culto"]);
  expect(looks).toEqual(
    expect.arrayContaining([
      { kind: "logo", name: null },
      { kind: "verse", name: null },
      { kind: "songTheme", name: "Domingo" },
      { kind: "scene", name: "Reloj" },
      { kind: "plate", name: "Marca" },
    ]),
  );
  expect(looks).toHaveLength(5);
});

test("a file nothing uses has nothing to warn about", () => {
  expect(programsRepo.findUsages(unused)).toEqual({ programs: [], looks: [] });
});
