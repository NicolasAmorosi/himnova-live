import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { eq, max } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { Db } from "../client";
import type { SettingsRepo } from "../repositories/settings.repo";
import { bibleBooks, bibleVersions } from "../schema";
import { BibleFormatError, parseBibleFile } from "./bible-formats";
import { BUILTIN_BIBLE_CODE } from "@shared/constants";
import { mt } from "../../i18n";
import { BUNDLED_BIBLES, type BundledBible } from "./bundled-bibles";

/** The column's own default, and what a file that does not say gets. */
const DEFAULT_LANGUAGE = "es";

export type SeedBibleOptions = {
  /** Stable identity: what a re-seed compares against and what
   *  `bible_favorites` rows point at. Never derived from the file's contents. */
  code: string;
  /** Used only when neither the stored row nor the file itself names the
   *  bible — in practice the file's own base name. */
  fallbackName: string;
  isBuiltin?: boolean;
};

/** One slot past the current bottom of the list. Duplicated from
 *  `BibleRepo.nextSortOrder` rather than imported: the seed runs before the
 *  repositories are registered (`services/repos.ts`), and it already talks to
 *  `db` directly for everything else it writes. */
function nextSortOrder(db: Db): number {
  const highest = db.select({ value: max(bibleVersions.sortOrder) }).from(bibleVersions).get()?.value ?? null;
  return highest === null ? 0 : highest + 1;
}

/** A Bible file's identity, `bible_versions.source_hash`: what a re-seed
 *  compares, and how an import knows the file is already installed. */
export function bibleFileHash(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * Imports (or re-imports, if the source file changed) a Bible into the
 * relational tables + FTS5 index. Runs as ONE transaction so a crash mid-seed
 * never leaves a half-imported version. Deliberately writes nothing back to
 * the source file's own directory — the legacy `import-bible` bug it replaces
 * wrote into the app bundle itself, which fails on a packaged install.
 *
 * The format is decided by `parseBibleFile` from the file's bytes — JSON,
 * Zefania/USFX/OSIS XML, or a MyBible/MySword SQLite module — and nothing
 * below this line knows which one it was.
 */
export function seedBibleFromFile(
  db: Db,
  sqlite: Database.Database,
  filePath: string,
  { code, fallbackName, isBuiltin = false }: SeedBibleOptions,
): { versionId: number; verseCount: number } | null {
  // Read as bytes, not as a string: the unchanged case (every launch after
  // the first) only needs the digest, and decoding 4 MB of UTF-8 into a JS
  // string just to throw it away is the larger half of the cost. The parser
  // below reads the file again, on purpose — it has to work from a PATH, both
  // because a SQLite module is opened rather than read and because a zipped
  // one is read entry by entry.
  const sourceHash = bibleFileHash(filePath);

  const existing = db.select().from(bibleVersions).where(eq(bibleVersions.code, code)).get();
  if (existing && existing.sourceHash === sourceHash) {
    return { versionId: existing.id, verseCount: existing.verseCount };
  }

  const parsed = parseBibleFile(filePath);
  const totalVerses = parsed.books.reduce((sum, book) => sum + book.verses.length, 0);
  if (totalVerses === 0) {
    // Parsed as SOMETHING and yielded nothing — a module of only
    // deuterocanonical books, an XML whose verses are all empty elements.
    // Refused rather than stored: a version with no verses in the list is a
    // bug report waiting to happen, and the operator can still act on this.
    throw new BibleFormatError(mt("bible.noVerses", { file: path.basename(filePath) }));
  }

  // A re-seed KEEPS the name the row already has. The bundled bible can be
  // renamed like any other (it is what the projector prints under a verse),
  // and a corrected `rv1909.json` shipping in a later build must not quietly
  // undo that rename on the next launch.
  const name = existing?.name ?? parsed.name?.trim() ?? fallbackName;
  const language = parsed.language ?? existing?.language ?? DEFAULT_LANGUAGE;
  const now = Date.now();

  const run = sqlite.transaction(() => {
    if (existing) {
      // ON DELETE CASCADE removes bible_books/bible_verses (and the FTS rows via triggers).
      db.delete(bibleVersions).where(eq(bibleVersions.id, existing.id)).run();
    }

    const versionId = db
      .insert(bibleVersions)
      .values({
        code,
        name,
        language,
        isBuiltin: isBuiltin ? 1 : 0,
        verseCount: totalVerses,
        sourceHash,
        // A re-seed KEEPS the row's place in the operator's arrangement for
        // the same reason it keeps its name: the row is deleted and
        // re-inserted (cascade is how the verses go), so without this a
        // corrected `rv1909.json` in a later build would silently send the
        // bundled bible to the bottom of the picker. A brand new one lands at
        // the bottom — see `BibleRepo.nextSortOrder`.
        sortOrder: existing?.sortOrder ?? nextSortOrder(db),
        installedAt: existing?.installedAt ?? now,
      })
      .run().lastInsertRowid as number;

    // The insert trigger indexes one row at a time: ~0.5 s of a whole bible's
    // ~0.6 s load, ten times what the rows cost (measured 2026-11-09). It is set
    // aside for the bulk load — DDL is part of this transaction, so a failure
    // puts it back — and the new rows are indexed in one statement below.
    const trigger = sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'bible_verses_ai'`)
      .get() as { sql: string } | undefined;
    if (trigger) sqlite.exec(`DROP TRIGGER bible_verses_ai`);

    const insertVerse = sqlite.prepare(
      `INSERT INTO bible_verses (version_id, book_id, chapter, verse, text) VALUES (?, ?, ?, ?, ?)`,
    );

    parsed.books.forEach((book, index) => {
      const bookId = db
        .insert(bibleBooks)
        .values({
          versionId,
          position: index + 1,
          abbrev: book.abbrev,
          name: book.name,
          testament: book.testament,
          chapterCount: book.chapterCount,
        })
        .run().lastInsertRowid as number;

      for (const v of book.verses) {
        insertVerse.run(versionId, bookId, v.chapter, v.verse, v.text);
      }
    });

    // Only this version's rows: a 'rebuild' would re-index every installed
    // version (it is what this used to do, on top of the trigger — not instead
    // of it), so each new bible took longer to install than the one before.
    sqlite
      .prepare(`INSERT INTO bible_verses_fts(rowid, text) SELECT id, text FROM bible_verses WHERE version_id = ?`)
      .run(versionId);
    if (trigger) sqlite.exec(trigger.sql);

    return { versionId, verseCount: totalVerses };
  });

  return run();
}

/** Installs a version of the catalog, or re-seeds it when its file changed (the hash short-circuit makes an
 *  unchanged one a digest). Every bundled version is `isBuiltin`; its name is the file's own — the catalog's —
 *  unless the row was renamed. */
function seedBundled(db: Db, sqlite: Database.Database, biblesDir: string, bible: BundledBible) {
  return seedBibleFromFile(db, sqlite, path.join(biblesDir, bible.file), {
    code: bible.code,
    fallbackName: bible.name,
    isBuiltin: true,
  });
}

/** `bible:installBundled`: the version's id, installed now or already. */
export function installBundledBible(db: Db, sqlite: Database.Database, biblesDir: string, code: string): number {
  const bible = BUNDLED_BIBLES.find((entry) => entry.code === code);
  const seeded = bible ? seedBundled(db, sqlite, biblesDir, bible) : null;
  if (!seeded) throw new BibleFormatError(mt("bible.bundledNotFound"));
  return seeded.versionId;
}

/**
 * The bundled versions at launch (`bundled-bibles.ts`).
 *
 * A NEW profile gets every version of its interface language — the locale
 * `initDatabase` set from the OS —, in the catalog's order, and the first one
 * becomes the default. Every other version is installed from Settings only.
 *
 * An EXISTING profile is never given a version on its own, with the one rule
 * kept from before the catalog: the RV1909 of a database that has never been
 * offered it (`bible.builtinSeeded` unset — a profile of the legacy app). The
 * flag is consulted ONLY when that row is gone, and that asymmetry is the whole
 * design:
 *
 * - row present → seed anyway. `seedBibleFromFile` short-circuits on an
 *   unchanged hash, so this costs a digest per launch and is the path by which
 *   a corrected file in a later build reaches an existing install — for every
 *   bundled version that is installed, not only the RV1909.
 * - row gone, flag set → the operator deleted it. Leave it deleted; this is
 *   what makes «delete» mean delete, exactly like `utility.seeded`. A deleted
 *   bundled version is just «not installed» again in Settings.
 * - row gone, flag unset → a database that never had it. Seed, and set the flag.
 *
 * Checking only the flag would break the upgrade path; checking only the row
 * would resurrect a deleted bible on every launch. Both are needed.
 *
 * A file that fails costs that version, never the launch: it is logged and the
 * others go on.
 */
export function seedBuiltinBibles(
  db: Db,
  sqlite: Database.Database,
  biblesDir: string,
  settings: SettingsRepo,
  isNewProfile: boolean,
): void {
  const installed = new Set(db.select({ code: bibleVersions.code }).from(bibleVersions).all().map((row) => row.code));
  const offered = settings.get("bible.builtinSeeded");
  const locale = settings.get("ui.locale");
  const wanted = BUNDLED_BIBLES.filter((bible) =>
    isNewProfile
      ? bible.language === locale
      : installed.has(bible.code) || (bible.code === BUILTIN_BIBLE_CODE && !offered),
  );

  let firstId: number | null = null;
  for (const bible of wanted) {
    if (!fs.existsSync(path.join(biblesDir, bible.file))) continue;
    try {
      const seeded = seedBundled(db, sqlite, biblesDir, bible);
      firstId ??= seeded?.versionId ?? null;
    } catch (error) {
      console.error(`[bible] the bundled ${bible.code} could not be seeded`, error);
    }
  }

  if (isNewProfile && firstId !== null) settings.setMany({ "bible.defaultVersionId": firstId });
  if (!offered) settings.setMany({ "bible.builtinSeeded": true });
}
