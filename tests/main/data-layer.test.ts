/**
 * The data layer, without Electron: migrations, the Bible seed and FTS5, every
 * repository, the unsaved-schedule draft, the `settings:set` validators and the
 * WAL-aware pre-migration backup.
 *
 * This is the former `scripts/db-smoke.ts`, assertion for assertion. It ran as
 * a script because there was no runner; now that there is one, the same checks
 * report per case, fail with a name instead of a stack, and stop being
 * something a person has to remember to run.
 *
 * The cases share ONE database on purpose, built up in order — several of them
 * assert about what earlier ones left behind (the manual list order, the
 * duplicate-bytes deck, the draft's dead reference). Vitest runs the tests of a
 * file in declaration order, which is what keeps that chain honest.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/main/db/client";
import { backupBeforeMigrate, runMigrations } from "../../src/main/db/migrate";
import { bibleFileHash, seedBuiltinBibles } from "../../src/main/db/seed/seed-bible";
import { bibleBooks, bibleVersions, mediaAssets } from "../../src/main/db/schema";
import { BibleRepo } from "../../src/main/db/repositories/bible.repo";
import { SettingsRepo } from "../../src/main/db/repositories/settings.repo";
import { ProgramsRepo } from "../../src/main/db/repositories/programs.repo";
import { MediaRepo } from "../../src/main/db/repositories/media.repo";
import { SlidesRepo } from "../../src/main/db/repositories/slides.repo";
import { DraftRepo } from "../../src/main/db/repositories/draft.repo";
import { UtilityRepo } from "../../src/main/db/repositories/utility.repo";
import { seedUtilityScenes } from "../../src/main/db/seed/seed-utility-scenes";
import { getOverlaysRepo, initRepos } from "../../src/main/services/repos";
import { readBinarySlideTimings } from "../../src/main/slides/ppt-binary";
import { BIBLE_RECENTS_MAX, SNIPPET_MARK_END, SNIPPET_MARK_START, parseSnippet } from "../../src/shared/types/bible";
import { DEFAULT_SETTINGS, SETTINGS_VALIDATORS, isSettingsKey } from "../../src/shared/types/settings";
import { BUILTIN_BIBLE_CODE, SLIDES_CONVERTER_VERSION, SLIDES_MODEL_VERSION, SLIDES_NATIVE_VERSION } from "../../src/shared/constants";
import { defaultUtilityScenes } from "../../src/shared/types/utility";
import mainEs from "../../src/main/i18n/messages/es";
import { removeUtilityScene } from "../../src/main/services/utility-scene-removal";
import { removeOverlayPlate } from "../../src/main/services/overlay-plate-removal";
import { DEFAULT_PLATE_STYLE, type Plate } from "../../src/shared/types/overlay";
import { IpcError } from "../../src/shared/ipc/result";
import type { UtilityScene } from "../../src/shared/types/utility";
import { buildLegacyPpt } from "../fixtures/legacy-ppt";
import type { ProgramSummary } from "../../src/shared/types/program";
import type { MediaAsset } from "../../src/shared/types/media";

const DEFAULT_UTILITY_SCENES = defaultUtilityScenes(mainEs.seed);

/** Keeps the original script's one-line diagnostics: every message below says
 *  what the invariant is, which is worth more on a failure than a diff. */
function assert(condition: unknown, message: string): asserts condition {
  expect(condition, message).toBeTruthy();
}

const drizzleDir = path.join(process.cwd(), "drizzle");
const biblesDir = path.join(process.cwd(), "resources/bibles");

let tmpDir: string;
let dbFile: string;
let sqlite: ReturnType<typeof openDatabase>["sqlite"];
let db: ReturnType<typeof openDatabase>["db"];

let bibleRepo: BibleRepo;
let settingsRepo: SettingsRepo;
let programsRepo: ProgramsRepo;
let mediaRepo: MediaRepo;
let slidesRepo: SlidesRepo;
let utilityRepo: UtilityRepo;

let versionId: number;
let bookIds: number[];
let saved: ProgramSummary;
let duplicateInherited: ProgramSummary;
let duplicateOverridden: ProgramSummary;
let mediaDir: string;
let filePaths: string[];
let statted: { path: string; stat: fs.Stats }[];
let inserted: MediaAsset[];
let firstAsset: MediaAsset;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-data-layer-"));
  dbFile = path.join(tmpDir, "smoke.db");
  const opened = openDatabase(dbFile);
  sqlite = opened.sqlite;
  db = opened.db;
  runMigrations(db, drizzleDir);

  bibleRepo = new BibleRepo(db, sqlite);
  settingsRepo = new SettingsRepo(db);
  // After the repo exists: the seed reads (and sets) `bible.builtinSeeded`.
  seedBuiltinBibles(db, sqlite, biblesDir, settingsRepo);
  programsRepo = new ProgramsRepo(db, sqlite);
  mediaRepo = new MediaRepo(db, sqlite);
  slidesRepo = new SlidesRepo(db, sqlite);
  utilityRepo = new UtilityRepo(db, sqlite);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Bible seed", () => {
  test("seeds exactly one version with every verse and book", () => {
    const versions = bibleRepo.listVersions();
    assert(versions.length === 1, `expected 1 Bible version, got ${versions.length}`);
    assert(versions[0]!.verseCount === 31102, `expected 31102 verses, got ${versions[0]!.verseCount}`);
    versionId = versions[0]!.id;

    const books = bibleRepo.listBooks(versionId);
    assert(books.length === 66, `expected 66 books, got ${books.length}`);
    assert(books[0]!.name === "Génesis", `expected first book "Génesis", got "${books[0]!.name}"`);

    // The testament split, over the bible that is actually in the box.
    // It used to be derived from a hand-written set of 39 abbreviations that
    // did not match this file's own spellings (`1s` vs `1sm`, `sal` vs `ps`,
    // `abd` vs `ob`, …): 23 of the 39 Old Testament books were stored as
    // "NT". Nothing read the column, so nothing ever showed it.
    const ot = books.filter((b) => b.testament === "OT");
    assert(ot.length === 39, `expected 39 OT books, got ${ot.length}`);
    assert(books[38]!.testament === "OT", `expected Malaquías in the OT, got ${books[38]!.testament}`);
    assert(books[39]!.testament === "NT", `expected Mateo in the NT, got ${books[39]!.testament}`);
    bookIds = books.map((book) => book.id);
  });

  test("chapter lookup returns the whole chapter", () => {
    const genesis1 = bibleRepo.getChapter(bookIds[0]!, 1);
    assert(genesis1.length === 31, `expected 31 verses in Génesis 1, got ${genesis1.length}`);
  });

  test("FTS5 search is accent-insensitive and its snippets are never markup", () => {
    const hits = bibleRepo.search(versionId, "espiritu");
    assert(hits.length > 0, "expected FTS search for 'espiritu' to match 'Espíritu'");

    // The snippet must not be markup. It used to be wrapped in `<mark>` tags and
    // handed to `dangerouslySetInnerHTML`, which made the text of a verse — from
    // whatever JSON the operator imported — executable in the control window.
    const marked = hits.find((hit) => hit.snippet.includes(SNIPPET_MARK_START));
    assert(marked !== undefined, "expected at least one snippet to carry a match marker");
    assert(
      !hits.some((hit) => hit.snippet.includes("<")),
      "snippets must never contain markup — see SNIPPET_MARK_START in shared/types/bible.ts",
    );
    const segments = parseSnippet(marked.snippet);
    assert(
      segments.some((segment) => segment.match) && segments.some((segment) => !segment.match),
      "parseSnippet should split a marked snippet into matched and plain runs",
    );
    assert(
      segments.map((segment) => segment.text).join("") ===
        marked.snippet.split(SNIPPET_MARK_START).join("").split(SNIPPET_MARK_END).join(""),
      "parseSnippet must preserve every character except the markers",
    );
  });

  test("the bundled file is known by its bytes, so importing it again can be refused", () => {
    const [builtin] = bibleRepo.listVersions();
    expect(bibleRepo.findVersionBySourceHash(bibleFileHash(path.join(biblesDir, "rv1909.json")))?.id).toBe(builtin?.id);
    expect(bibleRepo.findVersionBySourceHash("0".repeat(64))).toBeNull();
  });
});

describe("Settings and programs", () => {
  test("settings and a program round-trip", () => {
    settingsRepo.setMany({ "ui.theme": "light" });
    assert(settingsRepo.get("ui.theme") === "light", "settings round-trip failed");

    saved = programsRepo.save({
      name: "Culto de prueba",
      items: [
        { kind: "bible", bibleVersionId: null, bibleBookId: null, chapter: null, verseFrom: null, verseTo: null, reference: "Juan 3:16", text: "Porque de tal manera…" },
      ],
    });
    const loaded = programsRepo.load(saved.id);
    assert(loaded.items.length === 1, "program round-trip failed");
    assert(loaded.favorite === false, "program should default to not favorite");
  });

  test("a row an older build wrote for a key that no longer exists is ignored, not an error", () => {
    // The LibreOffice keys of the builds before 2026-11-03 stay in the table.
    sqlite
      .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("slides.warnMissingSoffice", "false", Date.now());
    const fresh = new SettingsRepo(db).getAll();
    expect(fresh["ui.theme"]).toBe("light");
    expect(Object.keys(fresh)).not.toContain("slides.warnMissingSoffice");
  });

  test("favorite survives a re-save and is inherited by a duplicate", () => {
    const starred = programsRepo.setFavorite(saved.id, true);
    assert(starred.favorite === true, "setFavorite(true) did not stick");
    assert(starred.updatedAt === saved.updatedAt, "setFavorite must not bump updatedAt");

    const resavedWithoutFavorite = programsRepo.save({
      id: saved.id,
      name: "Culto de prueba",
      items: [
        { kind: "bible", bibleVersionId: null, bibleBookId: null, chapter: null, verseFrom: null, verseTo: null, reference: "Juan 3:16", text: "Porque de tal manera…" },
      ],
    });
    assert(resavedWithoutFavorite.favorite === true, "save() without favorite must not clobber it");

    duplicateInherited = programsRepo.duplicate({ id: saved.id, name: "Culto de prueba (copia)" });
    assert(duplicateInherited.favorite === true, "duplicate() without favorite should inherit the source's");

    duplicateOverridden = programsRepo.duplicate({
      id: saved.id,
      name: "Culto de prueba (copia 2)",
      favorite: false,
      notes: "nota de la copia",
    });
    assert(duplicateOverridden.favorite === false, "duplicate() with favorite should respect it");
    assert(duplicateOverridden.notes === "nota de la copia", "duplicate() with notes should respect it");
  });

  test("the list keeps its manual order, counts items, and opening never reshuffles", () => {
    // `saved` was the first row created and has since been `load()`ed (which
    // bumps `lastOpenedAt`), so finding it last proves the list is ordered by
    // `sortOrder` and that opening a program no longer reshuffles it.
    const byOrder = programsRepo.list().map((p) => p.id);
    assert(
      byOrder.join() === [duplicateOverridden.id, duplicateInherited.id, saved.id].join(),
      `new programs should land on top, got ${byOrder.join()}`,
    );

    // `itemCount` comes from a LEFT JOIN + GROUP BY, so the case that can break
    // silently is the one with nothing to join against: an empty program must
    // still be listed, and at 0 rather than at the 1 the join's null row counts.
    const empty = programsRepo.save({ name: "Programa vacío", items: [] });
    const counts = new Map(programsRepo.list().map((p) => [p.id, p.itemCount]));
    assert(counts.get(empty.id) === 0, `an empty program should list with itemCount 0, got ${counts.get(empty.id)}`);
    assert(counts.get(saved.id) === 1, `itemCount should count the program's items, got ${counts.get(saved.id)}`);
    assert(counts.size === 4, `every program must survive the join, got ${counts.size} of 4`);
    programsRepo.delete(empty.id);

    const desired = [saved.id, duplicateOverridden.id, duplicateInherited.id];
    const reordered = programsRepo.reorder(desired);
    assert(reordered.map((p) => p.id).join() === desired.join(), "reorder() did not apply the given order");
    assert(
      programsRepo.list().map((p) => p.id).join() === desired.join(),
      "reorder() did not survive a re-read",
    );
    const afterReopen = programsRepo.load(duplicateInherited.id);
    assert(afterReopen.id === duplicateInherited.id, "load() failed after a reorder");
    assert(
      programsRepo.list().map((p) => p.id).join() === desired.join(),
      "opening a program must not change the manual order",
    );
  });
});

describe("Media library", () => {
  test("a batch import inserts every file and resolves no audio eagerly", () => {
    mediaDir = path.join(tmpDir, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    filePaths = Array.from({ length: 25 }, (_, i) => {
      const p = path.join(mediaDir, `deck-${i}.pptx`);
      fs.writeFileSync(p, `fake pptx ${i}`);
      return p;
    });

    statted = filePaths.map((p) => ({ path: p, stat: fs.statSync(p) }));
    const batch = mediaRepo.upsertBatch(statted, "ppt", true);
    inserted = batch.assets;
    firstAsset = inserted[0]!;
    assert(inserted.length === 25, `expected 25 inserted assets, got ${inserted.length}`);
    assert(batch.mutated === 25, `a fresh import of 25 new files should report 25 mutated, got ${batch.mutated}`);
    assert(
      inserted.every((a) => a.linkedAudioPath === null),
      "a fresh import must never resolve linked audio eagerly",
    );
    assert(
      mediaRepo.list("ppt").length === 25,
      `expected 25 ppt assets in the library, got ${mediaRepo.list("ppt").length}`,
    );
  });

  test("re-importing unchanged files reports zero mutations", () => {
    // This is the regression test for the import→library-changed→listFolder
    // loop: a `library:listFolder` re-scan of an untouched folder must be able
    // to tell "nothing to broadcast" from "something changed", or it will
    // broadcast `library-changed` and re-trigger itself forever.
    const { assets: restatted, mutated: stableMutated } = mediaRepo.upsertBatch(statted, "ppt", true);
    assert(restatted.length === 25, "a stable re-import must still return every asset");
    assert(stableMutated === 0, `re-importing unchanged files should mutate nothing, got ${stableMutated}`);
  });

  test("reactivation is OR, not overwrite", () => {
    // Deactivate one row directly (simulating "no longer in the library, but
    // still on disk") before re-importing the same files.
    db.update(mediaAssets).set({ inLibrary: 0, createdAt: 1 }).where(eq(mediaAssets.id, firstAsset.id)).run();

    const { assets: reimported, mutated: reimportedMutated } = mediaRepo.upsertBatch(statted, "ppt", true);
    assert(reimported.length === 25, "re-import must return the same count");
    assert(reimportedMutated === 1, `only the deactivated row should count as mutated, got ${reimportedMutated}`);
    const reactivated = reimported.find((a) => a.id === firstAsset.id);
    assert(reactivated?.inLibrary === true, "re-importing with inLibrary:true must reactivate a deactivated row");
    // The media tabs' «newest first» is the order things joined the library.
    assert((reactivated?.createdAt ?? 0) > 1, "joining the library must move createdAt to now");
    const untouched = reimported.find((a) => a.id !== firstAsset.id);
    assert(untouched?.createdAt === inserted[1]?.createdAt, "a row already in the library keeps its createdAt");
  });

  test("re-importing a CHANGED file returns the new size and mtime", () => {
    // A library thumbnail's cache-buster is built from the asset DTO's
    // `sizeBytes`+`mtimeMs` (`assetThumbVersion`), and the deck cache's cheapest
    // hit compares the same two values. Both branches of the upsert used to
    // return the row as it was READ rather than as it was written, so a caller
    // acting on an edited file got the previous file's identity back and would
    // keep pointing at the previous file's thumbnail.
    const changedPath = filePaths[1]!;
    fs.writeFileSync(changedPath, "fake pptx 1 — now a different length entirely");
    // Some filesystems have coarse mtime granularity; force a distinct one so
    // this asserts the write-through, not the clock.
    const bumped = new Date(Date.now() + 5_000);
    fs.utimesSync(changedPath, bumped, bumped);
    const changedStat = fs.statSync(changedPath);

    const { assets: afterEdit } = mediaRepo.upsertBatch([{ path: changedPath, stat: changedStat }], "ppt", true);
    const editedBatch = afterEdit[0]!;
    assert(
      editedBatch.sizeBytes === changedStat.size,
      `upsertBatch must return the new size (${String(changedStat.size)}), got ${String(editedBatch.sizeBytes)}`,
    );
    assert(
      editedBatch.mtimeMs === Math.trunc(changedStat.mtimeMs),
      "upsertBatch must return the new mtime, not the row's previous one",
    );

    const editedSingle = mediaRepo.upsertFromPath(changedPath, "ppt", true);
    assert(
      editedSingle.sizeBytes === changedStat.size && editedSingle.mtimeMs === Math.trunc(changedStat.mtimeMs),
      "upsertFromPath's existing-row branch must return what it just wrote, not the stale row",
    );
    assert(
      mediaRepo.getById(editedSingle.id)?.mtimeMs === Math.trunc(changedStat.mtimeMs),
      "the persisted row must agree with the returned DTO",
    );
  });

  test("the sweep marks a vanished file and clears the mark when it comes back", async () => {
    fs.rmSync(filePaths[0]!);
    const changedOnMissing = await mediaRepo.sweep();
    assert(changedOnMissing.has("ppt"), "sweep must report 'ppt' changed when a ppt file goes missing");
    const afterMissing = mediaRepo.getById(firstAsset.id);
    assert(afterMissing?.missingSince !== null, "sweep must mark a vanished file's row as missing");

    fs.writeFileSync(filePaths[0]!, "fake pptx 0 restored");
    const changedOnReappear = await mediaRepo.sweep();
    assert(changedOnReappear.has("ppt"), "sweep must report 'ppt' changed when a missing file reappears");
    const afterReappear = mediaRepo.getById(firstAsset.id);
    assert(afterReappear?.missingSince === null, "sweep must clear missingSince once the file is back");
  });

  test("the sweep refreshes the row of a file edited in place", async () => {
    // Every stamp (deck content hash, video probe, thumbnail) is checked against
    // the row's (size, mtime): a sweep that only checked existence left an
    // edited deck or video "current" with last week's bytes.
    fs.writeFileSync(filePaths[0]!, "fake pptx 0 — edited in place, longer than before");
    const changed = await mediaRepo.sweep();
    const stat = fs.statSync(filePaths[0]!);
    const row = mediaRepo.getById(firstAsset.id);
    assert(changed.has("ppt"), "an edit must be reported, so the renderer and the conversions re-read it");
    assert(row?.sizeBytes === stat.size, `the row must carry the new size, got ${String(row?.sizeBytes)}`);
    assert(row.mtimeMs === Math.trunc(stat.mtimeMs), "the row must carry the new mtime");
    const again = await mediaRepo.sweep();
    assert(!again.has("ppt"), "a file that did not change since must not be reported again");
  });

  test("hasPath answers the worship://raster guard, and only for real rows", () => {
    // This is a security guard, not a convenience lookup: it is what lets the
    // rasterizer read a PDF that IS the source (kept wherever the operator
    // keeps it) instead of one we produced under `slidesTempDir`, so a false
    // positive would turn a capability token into an arbitrary file read.
    assert(mediaRepo.hasPath(filePaths[0]!), "a file that was imported must be recognized");
    assert(
      !mediaRepo.hasPath(path.join(mediaDir, "never-imported.pdf")),
      "a path with no row must never be served, however plausible it looks",
    );
    assert(
      !mediaRepo.hasPath(mediaDir),
      "the containing folder is not an asset — the match is exact, not a prefix",
    );
  });
});

describe("Deck status is answered by CONTENT, not by row ownership", () => {
  // The regression test for `N3` (media-chain audit §5.2). The deck cache is
  // content-addressed, but `statusesByAsset` used to ask "which deck row does
  // this asset OWN?" — and `relinkDeck` MOVES that ownership. With the same
  // file present twice (every hymn in the library that motivated this is), one
  // asset held the row and the other reported "pending" forever: 555 of 1235
  // assets offered for conversion with zero work to do, and a count that
  // oscillated instead of reaching zero, because preparing one folder stole
  // the rows back from the other.
  let dupA: MediaAsset;
  let dupB: MediaAsset;
  let deckId: number;

  test("both copies of the same bytes report ready, and point at the same deck", () => {
    const dupBytes = "fake pptx — two copies of the very same bytes";
    const dupPaths = ["dup-cantado.pps", "dup-instrumental.pps"].map((name) => {
      const full = path.join(mediaDir, name);
      fs.writeFileSync(full, dupBytes);
      return full;
    });
    const { assets: dupAssets } = mediaRepo.upsertBatch(
      dupPaths.map((p) => ({ path: p, stat: fs.statSync(p) })),
      "ppt",
      true,
    );
    assert(dupAssets[0] && dupAssets[1], "both duplicate copies must import as their own assets");
    dupA = dupAssets[0];
    dupB = dupAssets[1];

    // What the startup backfill does: same bytes → same digest, each stamped
    // with its own file's (size, mtime).
    const dupHash = "0".repeat(64);
    for (const asset of [dupA, dupB]) {
      const stat = fs.statSync(asset.path);
      mediaRepo.setContentHash(asset.id, dupHash, stat.size, Math.trunc(stat.mtimeMs));
    }

    // One deck row for those bytes, owned by the copy that happened to be opened
    // first — exactly what `relinkDeck` leaves behind.
    const dupStat = fs.statSync(dupA.path);
    deckId = slidesRepo.insertDeck(
      {
        contentHash: dupHash,
        renderWidth: 1920,
        imageFormat: "webp",
        converterVersion: SLIDES_CONVERTER_VERSION,
        mediaAssetId: dupA.id,
        sourcePath: dupA.path,
        sourceSizeBytes: dupStat.size,
        sourceMtimeMs: Math.trunc(dupStat.mtimeMs),
        cacheDir: path.join(tmpDir, "deck-dup"),
        aspectRatio: "16:9",
        timingsSource: "none",
        bytesOnDisk: 1024,
      },
      [
        {
          slideIndex: 1,
          imageFile: "1.webp",
          thumbFile: "1.thumb.webp",
          widthPx: 1920,
          heightPx: 1080,
          bytes: 1024,
          advanceMs: null,
          advanceOnClick: true,
          transition: null,
          layers: null,
          hidden: false,
          title: null,
          notes: null,
        },
      ],
      [],
    );

    const bothWays = slidesRepo.statusesByAsset([dupA.id, dupB.id]);
    assert(
      bothWays.get(dupA.id)?.status === "ready",
      "the asset that owns the deck row must report ready (it always did)",
    );
    assert(
      bothWays.get(dupB.id)?.status === "ready",
      "the OTHER copy of the same bytes must report ready too — this is N3",
    );
    assert(
      bothWays.get(dupB.id)?.deckId === deckId,
      "both copies must point at the one deck their bytes actually live in",
    );
  });

  test("reading the same bytes again keeps the deck's id, so a deck on air keeps its slides", () => {
    // The copy not hashed yet misses `findDeckByAssetContent`, is read, and its
    // row replaces this one. Windows ask for `worship://deck/<id>/<n>`: a new id
    // left a deck already on the projector asking for slides that were gone.
    const row = slidesRepo.getDeckById(deckId);
    assert(row, "the shared deck must exist");
    const { id: _id, ...before } = row;
    const stat = fs.statSync(dupB.path);
    // Another deck read since: SQLite hands a deleted LAST rowid out again, which
    // would hide the bug.
    const other = slidesRepo.insertDeck({ ...before, contentHash: "1".repeat(64), cacheDir: "" }, [], []);
    const again = slidesRepo.insertDeck(
      { ...before, mediaAssetId: dupB.id, sourcePath: dupB.path, sourceSizeBytes: stat.size, sourceMtimeMs: Math.trunc(stat.mtimeMs) },
      [{ slideIndex: 1, imageFile: "1.webp", thumbFile: "1.thumb.webp", widthPx: 1920, heightPx: 1080, bytes: 1024,
         advanceMs: null, advanceOnClick: true, transition: null, layers: null, hidden: false, title: null, notes: null }],
      [],
    );
    assert(again === deckId, `a re-read of the same identity must keep id ${deckId}, got ${again}`);
    assert(slidesRepo.getDeckById(deckId)?.slideCount === 1, "the deck and its slides must still be found by that id");
    // Back as the tests below expect it: owned by the first copy, alone.
    slidesRepo.deleteDeck(other);
    slidesRepo.relinkDeck(deckId, dupA.id, dupA.path, row.sourceSizeBytes, row.sourceMtimeMs);
  });

  test("relinking the row to one copy does not unconvert the other", () => {
    // Opening the second copy relinks the row to it. The first must not regress
    // to "pending" — that swap is what made the count oscillate.
    const dupBStat = fs.statSync(dupB.path);
    slidesRepo.relinkDeck(deckId, dupB.id, dupB.path, dupBStat.size, Math.trunc(dupBStat.mtimeMs));
    const afterRelink = slidesRepo.statusesByAsset([dupA.id, dupB.id]);
    assert(
      afterRelink.get(dupA.id)?.status === "ready" && afterRelink.get(dupB.id)?.status === "ready",
      "relinking the row to one copy must not make the other look unconverted",
    );
  });

  test("a deck from an older converter is stale, not ready", () => {
    // Opening it reconverts it, and the new row replaces this one under
    // whatever went live off it — so it must not be skipped by the prewarm.
    const setVersion = sqlite.prepare("UPDATE slide_decks SET converter_version = ? WHERE id = ?");
    setVersion.run(SLIDES_CONVERTER_VERSION - 1, deckId);
    expect(slidesRepo.statusesByAsset([dupA.id]).get(dupA.id)?.status).toBe("stale");
    setVersion.run(SLIDES_CONVERTER_VERSION, deckId);
  });

  test("a stale content-hash stamp stops matching once the file is edited", () => {
    // A file edited behind our back invalidates its own stamp: the digest on the
    // row describes bytes that no longer exist, so it must stop matching.
    fs.writeFileSync(dupA.path, "edited — these are different bytes now");
    const editedDupStat = fs.statSync(dupA.path);
    mediaRepo.refreshStat(dupA.id, editedDupStat.size, Math.trunc(editedDupStat.mtimeMs));
    const afterEditStatuses = slidesRepo.statusesByAsset([dupA.id]);
    assert(
      afterEditStatuses.get(dupA.id) === undefined,
      "a stale content-hash stamp must not match a deck (the bytes changed)",
    );
  });
});

describe("A legacy binary's auto-advance is read from its own records", () => {
  // Builds a minimal OLE2 `.ppt` so the reader is exercised without shipping
  // a real deck.
  test("the binary reader reads each slide's time, and ignores one whose flag is clear", () => {
    const legacyPath = path.join(mediaDir, "legacy-timings.ppt");
    fs.writeFileSync(legacyPath, buildLegacyPpt());

    const binaryTimings = readBinarySlideTimings(legacyPath);
    assert(binaryTimings !== null, "the synthetic legacy .ppt must parse");
    assert(binaryTimings.length === 2, `expected 2 slides, got ${binaryTimings.length}`);
    assert(
      binaryTimings[0]!.autoAdvanceMs === 12345,
      `slide 1 must carry its auto-advance time, got ${String(binaryTimings[0]!.autoAdvanceMs)}`,
    );
    assert(
      binaryTimings[1]!.autoAdvanceMs === null,
      "slide 2 has fAutoAdvance clear, so its stale slideTime must be ignored",
    );
  });
});

describe("A deck read natively owns no folder, and what LibreOffice drew goes at startup", () => {
  // `image_format = 'native'`: slides are pictures read straight from the
  // source (`ppt-binary.ts`), so the row has no cache folder at all — and every
  // path that deletes or rebases a deck's folder has to know that, or it acts
  // on the empty path (the process's working directory).
  const hash = "7".repeat(64);
  let asset: MediaAsset;
  let convertedId: number;
  let nativeId: number;
  let convertedDir: string;

  const slide = (layers: string | null) => ({
    slideIndex: 1,
    imageFile: layers === null ? "1.webp" : "",
    thumbFile: layers === null ? "1.thumb.webp" : "",
    widthPx: 960,
    heightPx: 720,
    bytes: layers === null ? 1024 : 0,
    advanceMs: 10_515,
    advanceOnClick: true,
    transition: { style: "random-bars-vertical" as const, durationMs: 750 },
    layers,
    hidden: false,
    title: null,
    notes: null,
  });

  beforeAll(() => {
    const source = path.join(mediaDir, "native-hymn.pps");
    fs.writeFileSync(source, buildLegacyPpt());
    asset = mediaRepo.upsertFromPath(source, "ppt", true);
    const stat = fs.statSync(source);
    mediaRepo.setContentHash(asset.id, hash, stat.size, Math.trunc(stat.mtimeMs));
    convertedDir = path.join(tmpDir, "converted-hymn");
    fs.mkdirSync(convertedDir);
    fs.writeFileSync(path.join(convertedDir, "1.webp"), "");
    const deck = {
      contentHash: hash,
      mediaAssetId: asset.id,
      sourcePath: source,
      sourceSizeBytes: stat.size,
      sourceMtimeMs: Math.trunc(stat.mtimeMs),
      aspectRatio: "5760:4320",
      bytesOnDisk: 0,
    };
    convertedId = slidesRepo.insertDeck(
      {
        ...deck,
        renderWidth: 1920,
        imageFormat: "webp",
        converterVersion: SLIDES_CONVERTER_VERSION,
        cacheDir: convertedDir,
        timingsSource: "binary",
        bytesOnDisk: 1024,
        lastUsedAt: Date.now() - 60_000,
      },
      [slide(null)],
      [],
    );
    nativeId = slidesRepo.insertDeck(
      {
        ...deck,
        renderWidth: 0,
        imageFormat: "native",
        converterVersion: SLIDES_NATIVE_VERSION,
        cacheDir: "",
        timingsSource: "binary",
      },
      [slide('{"width":5760,"height":4320,"layers":[]}')],
      [],
    );
  });

  test("its slides are served from the source, and it is the asset's current deck", () => {
    expect(slidesRepo.getSlideImage(nativeId, 1, "thumb")).toMatchObject({
      kind: "native",
      variant: "thumb",
      sourcePath: asset.path,
      layers: '{"width":5760,"height":4320,"layers":[]}',
    });
    expect(slidesRepo.findSourceDeckByAsset(asset.id, "native")?.id).toBe(nativeId);
    expect(slidesRepo.statusesByAsset([asset.id]).get(asset.id)).toEqual({ deckId: nativeId, status: "ready", drawnFromModel: false });
    const dto = slidesRepo.toDTO(slidesRepo.getDeckById(nativeId)!, asset.id);
    expect(dto.slides[0]).toMatchObject({ advanceAfterMs: 10_515, transition: { style: "random-bars-vertical", durationMs: 750 } });
  });

  test("it is not counted, evicted or rebased as cached content", () => {
    expect(slidesRepo.lruCandidates([], Date.now() + 1, 100).some((row) => row.id === nativeId)).toBe(false);
    expect(slidesRepo.allDeckDirs()).not.toContain("");
    slidesRepo.adoptCacheRoot(path.join(tmpDir, "some-other-cache"));
    expect(slidesRepo.getDeckById(nativeId)?.cacheDir).toBe("");
  });

  test("every deck drawn to disk goes with its folder at startup; a PDF drawn page by page stays", () => {
    // `adoptCacheRoot` above forgot the converted row (its folder is not under
    // that root); put it back the way the builds before 2026-11-03 left it.
    if (!slidesRepo.getDeckById(convertedId)) {
      convertedId = slidesRepo.insertDeck(
        {
          contentHash: hash,
          renderWidth: 1920,
          imageFormat: "webp",
          converterVersion: SLIDES_CONVERTER_VERSION,
          mediaAssetId: asset.id,
          sourcePath: asset.path,
          sourceSizeBytes: 1,
          sourceMtimeMs: 1,
          cacheDir: convertedDir,
          aspectRatio: null,
          timingsSource: "binary",
          bytesOnDisk: 1024,
          lastUsedAt: Date.now() - 60_000,
        },
        [slide(null)],
        [],
      );
    }
    const pdfDir = path.join(tmpDir, "rasterized-pdf");
    fs.mkdirSync(pdfDir);
    const pdfId = slidesRepo.insertDeck(
      {
        contentHash: "9".repeat(64),
        renderWidth: 1920,
        imageFormat: "png",
        converterVersion: SLIDES_CONVERTER_VERSION,
        mediaAssetId: null,
        sourcePath: path.join(mediaDir, "Anuncios.PDF"),
        sourceSizeBytes: 1,
        sourceMtimeMs: 1,
        cacheDir: pdfDir,
        aspectRatio: null,
        timingsSource: "none",
        bytesOnDisk: 1024,
      },
      [slide(null)],
      [],
    );

    // A PDF as this build reads it: no folder, its pages drawn when asked for.
    const onDemandId = slidesRepo.insertDeck(
      {
        contentHash: "8".repeat(64),
        renderWidth: 1920,
        imageFormat: "png",
        converterVersion: SLIDES_CONVERTER_VERSION,
        mediaAssetId: null,
        sourcePath: path.join(mediaDir, "Anuncios.PDF"),
        sourceSizeBytes: 1,
        sourceMtimeMs: 1,
        cacheDir: "",
        aspectRatio: null,
        timingsSource: "none",
        bytesOnDisk: 0,
      },
      [slide(null)],
      [],
    );

    expect(slidesRepo.deleteRasterizedDecks()).toBe(2);
    expect(slidesRepo.getDeckById(convertedId)).toBeNull();
    expect(fs.existsSync(convertedDir)).toBe(false);
    expect(slidesRepo.getDeckById(pdfId)).toBeNull();
    expect(fs.existsSync(pdfDir)).toBe(false);
    expect(slidesRepo.getDeckById(nativeId)).not.toBeNull();
    expect(slidesRepo.getSlideImage(onDemandId, 1, "thumb")).toMatchObject({ kind: "pdf", page: 1, renderWidth: 1920, imageFormat: "png" });
    expect(slidesRepo.deleteRasterizedDecks()).toBe(0);
    slidesRepo.deleteDeck(onDemandId);
  });

  test("deleting it removes no folder, whatever its row names", () => {
    const sentinel = path.join(tmpDir, "not-a-deck-folder");
    fs.mkdirSync(sentinel);
    sqlite.prepare("UPDATE slide_decks SET cache_dir = ? WHERE id = ?").run(sentinel, nativeId);
    slidesRepo.deleteDeck(nativeId);
    expect(slidesRepo.getDeckById(nativeId)).toBeNull();
    expect(fs.existsSync(sentinel)).toBe(true);
  });
});

describe("Unsaved-schedule draft", () => {
  let draftRepo: DraftRepo;

  test("round-trips, and drops items pointing at a deleted asset", () => {
    draftRepo = new DraftRepo(db);
    assert(draftRepo.load() === null, "a database with no draft row must report no draft");

    const liveAsset = mediaRepo.list("ppt")[0]!;
    const deadAssetId = 999_999;
    draftRepo.save({
      programId: null,
      name: "Culto sin guardar",
      notes: null,
      items: [
        { kind: "ppt", mediaAssetId: liveAsset.id, title: null },
        { kind: "media", mediaAssetId: deadAssetId, title: null },
        { kind: "bible", bibleVersionId: null, bibleBookId: null, chapter: null, verseFrom: null, verseTo: null, reference: "Juan 3:16", text: "Porque de tal manera…" },
      ],
      updatedAt: Date.now(),
    });
    const restored = draftRepo.load();
    assert(restored !== null, "a saved draft must come back");
    assert(restored.name === "Culto sin guardar", `draft name lost: ${restored.name}`);
    // The whole reason the items are a JSON blob and not `program_items` rows:
    // a draft may reference an asset that has since been deleted, and must come
    // back without it rather than either failing or handing the renderer a tile
    // that can never preview, never go live and never explain itself.
    assert(
      restored.items.length === 2 &&
        !restored.items.some((i) => (i.kind === "media" || i.kind === "ppt") && i.mediaAssetId === deadAssetId),
      `expected the item pointing at a deleted asset to be dropped, got ${JSON.stringify(restored.items)}`,
    );
  });

  test("there is always exactly one draft row, and clearing leaves nothing", () => {
    // One row, always: saving twice replaces rather than accumulates.
    draftRepo.save({ programId: 1, name: "Otro", notes: "n", items: [], updatedAt: Date.now() });
    const second = draftRepo.load();
    assert(second?.name === "Otro" && second.programId === 1, "the draft row must be replaced, not appended");
    draftRepo.clear();
    assert(draftRepo.load() === null, "clearing the draft must leave nothing behind");
  });
});

describe("A verse whose Bible version was deleted", () => {
  test("keeps its text, and the open schedule's dead ids neither fail a save nor come back in a draft", () => {
    const deletedVersionId = db
      .insert(bibleVersions)
      .values({ code: "deleted", name: "Borrable", installedAt: Date.now() })
      .run().lastInsertRowid as number;
    const deletedBookId = db
      .insert(bibleBooks)
      .values({ versionId: deletedVersionId, position: 43, abbrev: "Jn", name: "Juan", testament: "NT", chapterCount: 21 })
      .run().lastInsertRowid as number;
    // The row exactly as the control window holds it (`buildVerseDrag`).
    const verse = {
      kind: "bible" as const,
      bibleVersionId: deletedVersionId,
      bibleBookId: deletedBookId,
      chapter: 3,
      verseFrom: 16,
      verseTo: 16,
      reference: "Juan 3:16",
      text: "Uno.",
    };
    const first = programsRepo.save({ name: "Culto con versículo", notes: null, items: [verse] });
    bibleRepo.deleteVersion(deletedVersionId);

    // «Guardar» again with the ids the open schedule (or its draft) still
    // carries: the FK used to fail the whole save.
    programsRepo.save({ id: first.id, name: "Culto con versículo", notes: null, items: [verse] });
    expect(programsRepo.load(first.id).items).toMatchObject([
      { kind: "bible", bibleVersionId: null, bibleBookId: null, reference: "Juan 3:16", text: "Uno." },
    ]);

    const draftRepo = new DraftRepo(db);
    draftRepo.save({ programId: null, name: "Borrador", notes: null, items: [verse], updatedAt: Date.now() });
    expect(draftRepo.load()?.items).toMatchObject([{ bibleVersionId: null, bibleBookId: null, text: "Uno." }]);
    draftRepo.clear();
    programsRepo.delete(first.id);
  });
});

describe("settings:set validators reject what the types cannot", () => {
  test("an unknown key never reaches the table", () => {
    assert(!isSettingsKey("ui.themee"), "an unknown settings key must be rejected");
  });

  test("each key validates its own value", () => {
    assert(SETTINGS_VALIDATORS["ui.theme"]("dark"), "a valid theme must pass");
    // The exact value from the audit: it used to persist, be read at startup and
    // land in `document.documentElement.dataset.theme`, leaving the app with no
    // theme at all until someone edited the database by hand.
    assert(!SETTINGS_VALIDATORS["ui.theme"]("purple"), '"purple" must never reach the settings table');
    assert(!SETTINGS_VALIDATORS["projection.displayId"]("2"), 'the STRING "2" must not pass as a display id');
    assert(SETTINGS_VALIDATORS["projection.displayId"](null), "a null display id is the default and must pass");
    assert(!SETTINGS_VALIDATORS["media.volume"](1.5), "a volume outside 0..1 must be rejected");
    assert(!SETTINGS_VALIDATORS["media.volume"](Number.NaN), "NaN must be rejected — it survives JSON as null");
    assert(DEFAULT_SETTINGS["monitors.liveVideoMotion"] === true, "the LIVE monitor keeps its moving video by default");
    assert(!SETTINGS_VALIDATORS["monitors.liveVideoMotion"]("false"), 'the STRING "false" must not pass as a boolean');
    assert(
      !SETTINGS_VALIDATORS["library.linkedFolders"]({ video: [], image: [], audio: [] }),
      "a per-kind record missing a kind must be rejected",
    );
    assert(
      SETTINGS_VALIDATORS["library.linkedFolders"]({ video: [], image: [], audio: [], ppt: ["/x"] }),
      "a complete per-kind record must pass",
    );
    // `null` is the meaningful value here — "use the OS folder for this kind"
    // — so it has to pass the validator, unlike the empty array above.
    assert(
      SETTINGS_VALIDATORS["files.defaultFolders"]({ video: null, image: null, audio: null, ppt: "/decks" }),
      "a default-folder record must accept null for the kinds with no override",
    );
    assert(
      !SETTINGS_VALIDATORS["files.defaultFolders"]({ video: 0, image: null, audio: null, ppt: null }),
      "a default folder that is not a path must be rejected",
    );
  });
});

describe("The pre-migration backup is WAL-aware", () => {
  // The failure this replaces: `fs.copyFileSync` of a WAL database copies only
  // the main file, so every transaction since the last checkpoint is silently
  // missing — exactly the state a dirty shutdown or a power cut leaves behind,
  // which is when the backup is the only thing standing between the operator
  // and a lost library.
  test("VACUUM INTO captures the un-checkpointed WAL that a plain copy loses", () => {
    const walDbFile = path.join(tmpDir, "wal-backup.db");
    const walBackupDir = path.join(tmpDir, "wal-backup-dir");

    const hot = new Database(walDbFile);
    hot.pragma("journal_mode = WAL");
    hot.exec("CREATE TABLE t (n INTEGER)");
    const insertRow = hot.prepare("INSERT INTO t VALUES (?)");
    for (let i = 0; i < 5_000; i += 1) insertRow.run(i);
    const walBytes = fs.statSync(`${walDbFile}-wal`).size;
    assert(walBytes > 0, "the fixture must leave an un-checkpointed WAL behind");
    // Left deliberately open: closing would checkpoint, which is the one case
    // the old implementation did get right.

    const result = backupBeforeMigrate(walDbFile, walBackupDir, drizzleDir);
    assert(result.status === "ok", `expected a verified backup, got ${JSON.stringify(result)}`);
    const snapshot = new Database(result.path, { readonly: true });
    const snapshotRows = (snapshot.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;
    snapshot.close();

    const naiveCopy = path.join(tmpDir, "wal-naive.db");
    fs.copyFileSync(walDbFile, naiveCopy);
    const naive = new Database(naiveCopy, { readonly: true });
    const naiveRows = (naive.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;
    naive.close();
    hot.close();

    assert(snapshotRows === 5_000, `the snapshot must hold every row, got ${snapshotRows}`);
    assert(
      naiveRows < snapshotRows,
      "the fixture no longer reproduces the bug: a plain copy saw every row, so the WAL was checkpointed",
    );
  });
});

describe("Utility scenes", () => {
  test("the four built-in scenes are seeded exactly once", () => {
    seedUtilityScenes(utilityRepo, settingsRepo);
    const seeded = utilityRepo.list();
    assert(
      seeded.length === DEFAULT_UTILITY_SCENES.length,
      `expected ${DEFAULT_UTILITY_SCENES.length} seeded scenes, got ${seeded.length}`,
    );
    assert(settingsRepo.get("utility.seeded"), "seeding must record that it happened");
    // The list order is the constant's order, without any reorder() having run.
    assert(
      seeded.map((scene) => scene.tool).join() === DEFAULT_UTILITY_SCENES.map((scene) => scene.tool).join(),
      "the seeded scenes must keep the order they are declared in",
    );

    seedUtilityScenes(utilityRepo, settingsRepo);
    assert(utilityRepo.list().length === seeded.length, "seeding twice must not duplicate anything");
  });

  test("deleting every scene does NOT bring them back on the next launch", () => {
    // The whole reason the flag exists rather than a row count: an operator
    // who deletes a scene must be rid of it.
    for (const scene of utilityRepo.list()) utilityRepo.delete(scene.id);
    assert(utilityRepo.isEmpty(), "the fixture must start this case with an empty table");
    seedUtilityScenes(utilityRepo, settingsRepo);
    assert(utilityRepo.isEmpty(), "an already-seeded database must never be re-seeded");
  });

  test("a scene round-trips through create, update and duplicate", () => {
    const created = utilityRepo.create({
      name: "  Cuenta 5  ",
      tool: "countdown",
      config: {
        durationMs: 5 * 60_000,
        targetMinuteOfDay: 9 * 60 + 30,
        endMessage: "¡Empezamos!",
        format: { hour12: false, showSeconds: true, hideZeroHours: true, overrun: true },
      },
      style: {
        version: 1,
        background: { kind: "gradient", from: "#04132b", to: "#2f557f", direction: "to-bottom" },
        fontFamily: "Futura",
        verticalAlign: "bottom",
        value: { sizeCqw: 24, color: "#ffffff", weight: 300, shadow: true, shadowStrength: 0.55 },
        title: { sizeCqw: 4, color: "#84adfc", weight: 600, shadow: false, shadowStrength: 0.55 },
        message: { sizeCqw: 4.5, color: "#f5f5f5", weight: 400, shadow: true, shadowStrength: 0.55 },
        end: {
          message: { sizeCqw: 8, color: "#ffffff", weight: 700, shadow: true, shadowStrength: 0.55 },
          hideValue: true,
          hideTitle: false,
          transition: { style: "crossfade", durationMs: 600 },
        },
        triggers: { warningAtMs: 60_000, warningColor: "#cd4900", endColor: "#d0021b" },
      },
      title: "El culto comienza en",
      message: null,
    });
    assert(created.name === "Cuenta 5", "the stored name must be trimmed");
    assert(created.style.background.kind === "gradient", "the background kind must survive the JSON round trip");
    assert(created.config.format.overrun, "the format flags must survive the JSON round trip");
    assert(created.style.triggers?.warningAtMs === 60_000, "the colour triggers must survive the JSON round trip");
    assert(created.style.end.hideValue, "the end state must survive the JSON round trip");
    assert(created.style.end.message.sizeCqw === 8, "the end message keeps a type of its own");
    assert(
      created.style.end.transition.style === "crossfade" && created.style.end.transition.durationMs === 600,
      "the end fade must survive the JSON round trip",
    );

    const { id: _id, ...fields } = created;
    const renamed = utilityRepo.update(created.id, { ...fields, name: "Cuenta 5 minutos", tool: "stopwatch" });
    assert(renamed.tool === "stopwatch", "the tool is a column and must be updatable");
    assert(renamed.style.fontFamily === "Futura", "an update must not lose the stored style");

    const copy = utilityRepo.duplicate(created.id, "Cuenta 5 (copia)");
    assert(copy.id !== created.id, "a duplicate must be its own row");
    assert(copy.style.verticalAlign === "bottom", "a duplicate must carry the style over");
    assert(utilityRepo.get(created.id)?.name === "Cuenta 5 minutos", "duplicating must not touch the source");
  });

  test("a new scene lands on top and reorder renormalizes the whole column", () => {
    const first = utilityRepo.list()[0]!;
    const newest = utilityRepo.create({ ...DEFAULT_UTILITY_SCENES[0]!, name: "Recién creada" });
    assert(utilityRepo.list()[0]?.id === newest.id, "a new scene must land at the top of the list");

    const reversed = utilityRepo.list().map((scene) => scene.id).reverse();
    const reordered = utilityRepo.reorder(reversed);
    assert(
      reordered.map((scene) => scene.id).join() === reversed.join(),
      "reorder must answer with the order it persisted",
    );
    assert(utilityRepo.list()[0]?.id === reversed[0], "the persisted order must survive a fresh list()");
    assert(reversed.includes(first.id), "the fixture must still hold the scene it started from");
  });

  test("a corrupt config or style falls back field by field instead of throwing", () => {
    const scene = utilityRepo.list()[0]!;
    // Hand-written rows are the real case: a truncated write, a version that
    // wrote a shape this build does not know, somebody editing the file.
    sqlite
      .prepare("UPDATE utility_scenes SET config_json = ?, style_json = ? WHERE id = ?")
      .run("{ not json", JSON.stringify({ version: 1, verticalAlign: "sideways", value: { sizeCqw: 18, color: "#ff0000", weight: 400, shadow: true } }), scene.id);

    const read = utilityRepo.get(scene.id);
    assert(read !== null, "a corrupt row must still come back as a scene");
    assert(read.config.durationMs > 0, "an unparseable config must fall back to the defaults");
    assert(read.style.verticalAlign === "middle", "an invalid enum must fall back to its default");
    // The half of the style that WAS valid is kept: falling back wholesale
    // would hand the operator back a scene they never built.
    assert(read.style.value.color === "#ff0000", "a valid field inside an invalid style must be preserved");
  });
});

/**
 * F3: a time scene as a row of the order of service.
 *
 * The three things only the database can answer — the widened CHECK
 * constraint, the `ON DELETE restrict` FK and what a forced delete actually
 * does — plus the draft's dead-reference filter, which is the one place a
 * deleted scene can still be referenced (a draft is a JSON blob no constraint
 * can reach).
 */
describe("A time scene as an order-of-service item", () => {
  let scene: UtilityScene;
  let program: ProgramSummary;

  test("a program saves and reloads an item that points at a scene", () => {
    initRepos(db, sqlite);
    scene = utilityRepo.create({ ...DEFAULT_UTILITY_SCENES[0]!, name: "Cuenta del culto" });
    program = programsRepo.save({
      name: "Culto con cuenta regresiva",
      items: [
        { kind: "utility", utilitySceneId: scene.id, title: null },
        { kind: "utility", utilitySceneId: scene.id, title: "Antes de empezar" },
      ],
    });

    const [first, second] = programsRepo.load(program.id).items;
    assert(
      first?.kind === "utility" && first.utilitySceneId === scene.id,
      `expected a utility item pointing at ${scene.id}, got ${JSON.stringify(first)}`,
    );
    // The row holds an id and NOT a copy: the scene the operator edits later is
    // the scene this program projects.
    assert(second?.kind === "utility" && second.title === "Antes de empezar", "a per-item title must survive");
  });

  test("the CHECK constraint refuses a utility row with no scene", () => {
    // Invisible to Drizzle — it only ever lived in SQL — which is exactly why
    // it is asserted here rather than trusted.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO program_items (program_id, position, kind, created_at) VALUES (?, 99, 'utility', ?)`,
        )
        .run(program.id, Date.now()),
    ).toThrow();
  });

  test("deleting a scene a saved program uses is refused, and names the program", () => {
    const usages = programsRepo.findSceneUsages(scene.id);
    assert(usages.length === 1, `expected exactly one program to use the scene, got ${usages.length}`);
    assert(usages[0]!.programName === program.name, "the usage must carry the program's name, not just its id");
    assert(usages[0]!.itemCount === 2, `expected both items counted, got ${usages[0]!.itemCount}`);

    // The FK rejection surfaces as a code the renderer can act on, never as a
    // raw SQLite error — the confirmation has to tell this case apart from a
    // real failure.
    expect(() => removeUtilityScene(scene.id, false)).toThrow(IpcError);
    assert(utilityRepo.get(scene.id) !== null, "a refused delete must leave the scene exactly where it was");
  });

  test("a forced delete removes the referencing items and the scene together", () => {
    removeUtilityScene(scene.id, true);
    assert(utilityRepo.get(scene.id) === null, "a forced delete must remove the scene");
    assert(
      programsRepo.load(program.id).items.length === 0,
      "a forced delete must take the items that referenced it with it",
    );
    assert(programsRepo.findSceneUsages(scene.id).length === 0, "nothing may still reference a deleted scene");
  });

  test("the draft drops an item pointing at a deleted scene", () => {
    const draftRepo = new DraftRepo(db);
    const liveScene = utilityRepo.list()[0]!;
    draftRepo.save({
      programId: null,
      name: "Culto sin guardar",
      notes: null,
      items: [
        { kind: "utility", utilitySceneId: liveScene.id, title: null },
        // `scene` was force-deleted above: an FK protects a saved program, but
        // a draft is JSON and nothing can protect it but this filter.
        { kind: "utility", utilitySceneId: scene.id, title: null },
      ],
      updatedAt: Date.now(),
    });

    const restored = draftRepo.load();
    assert(restored !== null, "a saved draft must come back");
    assert(
      restored.items.length === 1 && restored.items[0]?.kind === "utility",
      `expected only the live scene to survive, got ${JSON.stringify(restored.items)}`,
    );
    draftRepo.clear();
  });
});

describe("An overlay plate as an order-of-service item", () => {
  let plate: Plate;
  let program: ProgramSummary;

  test("a program saves and reloads an item that points at a plate", () => {
    initRepos(db, sqlite);
    plate = getOverlaysRepo().create({
      name: "Pastor Juan Pérez",
      kind: "lower-third",
      position: "bottom-left",
      title: "Juan Pérez",
      subtitle: "Pastor",
      imageAssetId: null,
      style: DEFAULT_PLATE_STYLE,
    });
    program = programsRepo.save({
      name: "Culto con zócalo",
      items: [{ kind: "plate", overlayPlateId: plate.id, title: null }],
    });
    const [first] = programsRepo.load(program.id).items;
    assert(
      first?.kind === "plate" && first.overlayPlateId === plate.id,
      `expected a plate item pointing at ${plate.id}, got ${JSON.stringify(first)}`,
    );
  });

  test("the CHECK constraint refuses a plate row with no plate, or with a scene too", () => {
    const insert = (sql: string) => () => sqlite.prepare(sql).run(program.id, Date.now());
    expect(
      insert(`INSERT INTO program_items (program_id, position, kind, created_at) VALUES (?, 99, 'plate', ?)`),
    ).toThrow();
    const scene = utilityRepo.list()[0]!;
    expect(
      insert(
        `INSERT INTO program_items (program_id, position, kind, overlay_plate_id, utility_scene_id, created_at)
         VALUES (?, 99, 'plate', ${plate.id}, ${scene.id}, ?)`,
      ),
    ).toThrow();
  });

  test("deleting a plate a saved program uses is refused, and names the program", () => {
    const usages = programsRepo.findPlateUsages(plate.id);
    assert(usages.length === 1 && usages[0]!.programName === program.name, JSON.stringify(usages));
    expect(() => removeOverlayPlate(plate.id, false)).toThrow(IpcError);
    assert(getOverlaysRepo().get(plate.id) !== null, "a refused delete must leave the plate where it was");
  });

  test("a forced delete removes the referencing items and the plate together, and the draft drops it", () => {
    removeOverlayPlate(plate.id, true);
    assert(getOverlaysRepo().get(plate.id) === null, "a forced delete must remove the plate");
    assert(programsRepo.load(program.id).items.length === 0, "its program rows must go with it");

    const draftRepo = new DraftRepo(db);
    draftRepo.save({
      programId: null,
      name: "Culto sin guardar",
      notes: null,
      items: [{ kind: "plate", overlayPlateId: plate.id, title: null }],
      updatedAt: Date.now(),
    });
    assert(draftRepo.load()?.items.length === 0, "a draft row pointing at a deleted plate must be dropped");
    draftRepo.clear();
  });
});

/**
 * The order the version picker offers is the operator's, and it survives a
 * re-seed.
 *
 * Both halves matter and only one of them is visible in Settings: `sort_order`
 * also drives `bible.store`'s `versions`, which is the list the Bible tab's
 * picker is built from — so a reorder that did not persist would read as a
 * settings screen that forgets, and a re-seed that reset it would send the
 * bundled bible back to the bottom of that picker after an update.
 */
describe("Installed bibles keep the order the operator gave them", () => {
  let extraIds: number[] = [];

  beforeAll(() => {
    const now = Date.now();
    extraIds = ["test-a", "test-b"].map(
      (code, index) =>
        db
          .insert(bibleVersions)
          .values({
            code,
            name: code,
            language: "es",
            isBuiltin: 0,
            verseCount: 0,
            // What `BibleRepo.nextSortOrder` would have given them: the bundled
            // bible was backfilled to 0 by the migration.
            sortOrder: index + 1,
            installedAt: now + index,
          })
          .run().lastInsertRowid as number,
    );
  });

  afterAll(() => {
    for (const id of extraIds) db.delete(bibleVersions).where(eq(bibleVersions.id, id)).run();
    // Back to the single row every earlier case in this file assumes.
    bibleRepo.reorderVersions(bibleRepo.listVersions().map((version) => version.id));
  });

  test("a new version is imported at the BOTTOM, never on top", () => {
    const ids = bibleRepo.listVersions().map((version) => version.id);
    assert(ids[0] === versionId, `the bundled bible must stay first, got ${JSON.stringify(ids)}`);
    assert(bibleRepo.nextSortOrder() === 3, `expected the next slot to be 3, got ${bibleRepo.nextSortOrder()}`);
  });

  test("reorder persists the whole arrangement and renormalizes to 0..n-1", () => {
    const [first, second, third] = bibleRepo.listVersions().map((version) => version.id);
    const moved = bibleRepo.reorderVersions([third!, first!, second!]);
    assert(
      moved.map((version) => version.id).join(",") === [third, first, second].join(","),
      `reorder must answer with the stored order, got ${moved.map((v) => v.id).join(",")}`,
    );
    assert(
      bibleRepo.listVersions().map((version) => version.id).join(",") === [third, first, second].join(","),
      "a fresh read must see the same order",
    );
    const rows = db.select().from(bibleVersions).all();
    assert(
      rows.every((row) => row.sortOrder >= 0 && row.sortOrder < rows.length),
      `sort_order must be renormalized to 0..n-1, got ${rows.map((r) => r.sortOrder).join(",")}`,
    );
  });

  test("a re-seed of the bundled bible keeps its place", () => {
    const before = bibleRepo.listVersions().findIndex((version) => version.id === versionId);
    assert(before > 0, "this case only proves anything with the bundled bible off the top");
    // Clearing the hash is what a corrected `rv1909.json` shipping in a later
    // build looks like from here: the seed stops short-circuiting and takes the
    // delete-and-reinsert path (that is how the verses cascade), which without
    // `existing?.sortOrder` brings the row back at the bottom.
    db.update(bibleVersions).set({ sourceHash: null }).where(eq(bibleVersions.id, versionId)).run();
    seedBuiltinBibles(db, sqlite, biblesDir, settingsRepo);
    const after = bibleRepo.listVersions().findIndex((version) => version.code === BUILTIN_BIBLE_CODE);
    assert(after === before, `expected the bundled bible to stay at ${before}, found it at ${after}`);
  });
  test("0017 renames the bundled bible only while it still has its old default name", () => {
    // The migrations stopped at 0016 are a database from before the bundled text was relabelled.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-rv1909-"));
    const before0017 = path.join(dir, "drizzle");
    fs.cpSync(drizzleDir, before0017, { recursive: true });
    const journalPath = path.join(before0017, "meta/_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    // Everything from 0017 on: drizzle skips a migration older than the last
    // one applied, so leaving a later one in would hide 0017 from the upgrade.
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry) => entry.tag === "0017_builtin_bible_rv1909"),
    );
    fs.writeFileSync(journalPath, JSON.stringify(journal));

    let dbIndex = 0;
    const nameAfterUpgrade = (code: string, name: string): string => {
      const opened = openDatabase(path.join(dir, `${dbIndex++}.db`));
      runMigrations(opened.db, before0017);
      opened.sqlite.prepare("INSERT INTO bible_versions (code, name, installed_at) VALUES (?, ?, 0)").run(code, name);
      runMigrations(opened.db, drizzleDir);
      const row = opened.sqlite.prepare("SELECT name FROM bible_versions").get() as { name: string };
      opened.sqlite.close();
      return row.name;
    };

    expect(nameAfterUpgrade(BUILTIN_BIBLE_CODE, "Reina-Valera 1960")).toBe("Reina-Valera 1909");
    // The operator's own rename, and a real RV1960 they imported, are theirs.
    expect(nameAfterUpgrade(BUILTIN_BIBLE_CODE, "RV60")).toBe("RV60");
    expect(nameAfterUpgrade("imported", "Reina-Valera 1960")).toBe("Reina-Valera 1960");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("a deck's sounds", () => {
  const sound = (file: string, scope: "deck" | "slide", start: number, stop: number | null, loop = false) => ({
    audioFile: file,
    ext: path.extname(file).slice(1),
    bytes: 10,
    origin: "embedded" as const,
    scope,
    startSlideIndex: start,
    stopSlideIndex: stop,
    loop,
    volume: null,
    playable: !file.endsWith(".wma"),
  });

  function deckWith(
    name: string,
    audio: ReturnType<typeof sound>[],
    engineClip?: (kind: "audio" | "video", id: number) => boolean,
  ) {
    const source = path.join(mediaDir, `${name}.pptx`);
    fs.writeFileSync(source, name);
    const asset = mediaRepo.upsertFromPath(source, "ppt", true);
    const stat = fs.statSync(source);
    const id = slidesRepo.insertDeck(
      {
        contentHash: `sounds-${name}`,
        renderWidth: 0,
        imageFormat: "model",
        converterVersion: SLIDES_MODEL_VERSION,
        mediaAssetId: asset.id,
        sourcePath: source,
        sourceSizeBytes: stat.size,
        sourceMtimeMs: Math.trunc(stat.mtimeMs),
        cacheDir: "",
        aspectRatio: "4:3",
        timingsSource: "ooxml",
        bytesOnDisk: 0,
      },
      [],
      audio,
    );
    return slidesRepo.toDTO(slidesRepo.getDeckById(id)!, asset.id, null, engineClip);
  }

  test("the music from the first slide to the end is the soundtrack; every other sound plays on its slides", () => {
    const dto = deckWith("liturgy", [
      sound("1.mp3", "slide", 13, 14),
      sound("2.mp3", "deck", 1, null),
      sound("3.mp3", "slide", 39, 39, true),
    ]);
    expect(dto.soundtrack?.name).toBe("2.mp3");
    expect(dto.sounds.map(({ startSlideIndex, stopSlideIndex, loop }) => [startSlideIndex, stopSlideIndex, loop])).toEqual([
      [13, 14, false],
      [39, 39, true],
    ]);
  });

  test("music that starts later is a sound, not the soundtrack, and a row with no stop of its own keeps to its slide", () => {
    const dto = deckWith("communion", [sound("1.mp3", "deck", 39, null), sound("2.mp3", "slide", 5, null)]);
    expect(dto.soundtrack).toBeNull();
    expect(dto.sounds.map(({ startSlideIndex, stopSlideIndex }) => [startSlideIndex, stopSlideIndex])).toEqual([
      [5, 5],
      [39, null],
    ]);
  });

  test("a WMA is left out until the media engine takes it, and then it plays from the engine", () => {
    const audio = [sound("1.wma", "deck", 1, null), sound("2.wma", "slide", 2, 2)];
    const before = deckWith("wma-before", audio);
    expect([before.soundtrack, before.sounds]).toEqual([null, []]);
    const dto = deckWith("wma-engine", audio, (kind) => kind === "audio");
    expect(dto.soundtrack?.url).toMatch(/^worship:\/\/engine\/deck-audio\/\d+$/);
    expect(dto.sounds[0]?.url).toMatch(/^worship:\/\/engine\/deck-audio\/\d+$/);
  });
});

describe("Bible favorites and recent passages", () => {
  const bookId = (name: string) => {
    const version = bibleRepo.listVersions().find((v) => v.code === BUILTIN_BIBLE_CODE)!;
    const book = bibleRepo.listBooks(version.id).find((b) => b.name === name);
    assert(book, `expected the bundled bible to have «${name}»`);
    return book.id;
  };
  const refs = (list: { reference: string }[]) => list.map((b) => b.reference).join(" | ");

  test("starring keeps one row per verse, in Bible order, and unstarring removes it", () => {
    bibleRepo.setFavorite(bookId("Juan"), 3, 16, true);
    bibleRepo.setFavorite(bookId("Juan"), 3, 16, true);
    const list = bibleRepo.setFavorite(bookId("Génesis"), 1, 1, true);
    assert(refs(list) === "Génesis 1:1 | Juan 3:16", `got ${refs(list)}`);
    const after = bibleRepo.setFavorite(bookId("Juan"), 3, 16, false);
    assert(refs(after) === "Génesis 1:1", `unstar must remove it, got ${refs(after)}`);
  });

  test("reading on through the top chapter widens it; another chapter goes on top", () => {
    const psalms = bookId("Salmos");
    bibleRepo.recordRecent(psalms, 23, 1, 1);
    bibleRepo.recordRecent(psalms, 23, 2, 2);
    let list = bibleRepo.recordRecent(psalms, 23, 3, 3);
    assert(refs(list) === "Salmos 23:1-3", `got ${refs(list)}`);
    list = bibleRepo.recordRecent(bookId("Juan"), 3, 16, 16);
    assert(refs(list) === "Juan 3:16 | Salmos 23:1-3", `got ${refs(list)}`);
    // Back to Psalm 23 later: a fresh passage on top, not a second row for it.
    list = bibleRepo.recordRecent(psalms, 23, 6, 6);
    assert(refs(list) === "Salmos 23:6 | Juan 3:16", `got ${refs(list)}`);
  });

  test("keeps only the newest BIBLE_RECENTS_MAX passages", () => {
    const genesis = bookId("Génesis");
    for (let chapter = 1; chapter <= BIBLE_RECENTS_MAX + 5; chapter += 1) bibleRepo.recordRecent(genesis, chapter, 1, 1);
    const list = bibleRepo.listRecents();
    assert(list.length === BIBLE_RECENTS_MAX, `expected ${BIBLE_RECENTS_MAX}, got ${list.length}`);
    assert(list[0]!.reference === `Génesis ${BIBLE_RECENTS_MAX + 5}:1`, `newest first, got ${list[0]!.reference}`);
    const stored = sqlite.prepare("SELECT COUNT(*) AS n FROM bible_recents").get() as { n: number };
    assert(stored.n === BIBLE_RECENTS_MAX, `the table itself must be pruned, has ${stored.n}`);
  });

  test("both lists survive re-seeding the version they were made in", () => {
    const version = bibleRepo.listVersions().find((v) => v.code === BUILTIN_BIBLE_CODE)!;
    db.update(bibleVersions).set({ sourceHash: null }).where(eq(bibleVersions.id, version.id)).run();
    seedBuiltinBibles(db, sqlite, biblesDir, settingsRepo);
    assert(refs(bibleRepo.listFavorites()) === "Génesis 1:1", "favorites are keyed by abbrev, not by row id");
    assert(bibleRepo.listRecents().length === BIBLE_RECENTS_MAX, "recents are keyed by abbrev, not by row id");
  });
});
