/**
 * `lib/media-view.ts` — the rules behind a resource tab's grid.
 *
 * It is the only part of the resource panel with real decisions in it: a
 * hymnal is named "Himno 2 … Himno 100", half a church library is accented,
 * and `mtimeMs`/`sizeBytes` are both nullable columns. Every case here is one
 * of those, and none of them is visible from the component that calls it.
 */
import { describe, expect, test } from "vitest";
import { filterAssetsByName, sortAssets } from "@renderer/lib/media-view";
import type { MediaAsset } from "@shared/types/media";

function asset(partial: Partial<MediaAsset> & { name: string }): MediaAsset {
  return {
    id: 1,
    kind: "ppt",
    ext: "pptx",
    path: `/library/${partial.name}`,
    sizeBytes: 1000,
    mtimeMs: 1000,
    durationMs: null,
    linkedAudioPath: null,
    inLibrary: true,
    missingSince: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  };
}

const names = (assets: readonly MediaAsset[]): string[] => assets.map((a) => a.name);

describe("sortAssets", () => {
  test("names sort numerically, not by code unit", () => {
    // The case the whole collator exists for: a real hymnal folder. Plain
    // string comparison puts "Himno 100" between 10 and 2.
    const list = [asset({ name: "Himno 100" }), asset({ name: "Himno 2" }), asset({ name: "Himno 10" })];
    expect(names(sortAssets(list, "name-asc"))).toEqual(["Himno 2", "Himno 10", "Himno 100"]);
    expect(names(sortAssets(list, "name-desc"))).toEqual(["Himno 100", "Himno 10", "Himno 2"]);
  });

  test("an accent does not banish a name past Z", () => {
    const list = [asset({ name: "Biblia" }), asset({ name: "Ángeles" }), asset({ name: "culto" })];
    expect(names(sortAssets(list, "name-asc"))).toEqual(["Ángeles", "Biblia", "culto"]);
  });

  test("date is when the file joined the library, not the file's own mtime", () => {
    const list = [
      asset({ id: 1, name: "viejo", mtimeMs: 900, createdAt: 100 }),
      asset({ id: 2, name: "nuevo", mtimeMs: 100, createdAt: 300 }),
      asset({ id: 3, name: "medio", mtimeMs: null, createdAt: 200 }),
    ];
    expect(names(sortAssets(list, "date-desc"))).toEqual(["nuevo", "medio", "viejo"]);
    expect(names(sortAssets(list, "date-asc"))).toEqual(["viejo", "medio", "nuevo"]);
  });

  test("one import shares a timestamp: the id keeps the order they came in", () => {
    const list = [
      asset({ id: 3, name: "a", createdAt: 500 }),
      asset({ id: 1, name: "c", createdAt: 500 }),
      asset({ id: 2, name: "b", createdAt: 500 }),
    ];
    expect(names(sortAssets(list, "date-asc"))).toEqual(["c", "b", "a"]);
    expect(names(sortAssets(list, "date-desc"))).toEqual(["a", "b", "c"]);
  });

  test("a linked folder goes by the files' own dates: nothing in it was added", () => {
    const list = [
      asset({ id: 1, name: "viejo", mtimeMs: 100, createdAt: 900 }),
      asset({ id: 2, name: "nuevo", mtimeMs: 300, createdAt: 900 }),
      // Never stat'd: the row's date rather than 1970.
      asset({ id: 3, name: "sin-mtime", mtimeMs: null, createdAt: 200 }),
    ];
    expect(names(sortAssets(list, "date-desc", "file"))).toEqual(["nuevo", "sin-mtime", "viejo"]);
    expect(names(sortAssets(list, "date-asc", "file"))).toEqual(["viejo", "sin-mtime", "nuevo"]);
  });

  test("a folder copied in one go ties by name A → Z in BOTH date orders, as the size orders do", () => {
    const folder = [
      asset({ id: 3, name: "Himno 2", mtimeMs: 5000 }),
      asset({ id: 1, name: "Himno 10", mtimeMs: 5000 }),
      asset({ id: 2, name: "Himno 1", mtimeMs: 5000 }),
    ];
    expect(names(sortAssets(folder, "date-desc", "file"))).toEqual(["Himno 1", "Himno 2", "Himno 10"]);
    expect(names(sortAssets(folder, "date-asc", "file"))).toEqual(["Himno 1", "Himno 2", "Himno 10"]);
  });

  test("a size tie falls back to the name", () => {
    const list = [asset({ name: "c" }), asset({ name: "a" }), asset({ name: "b" })];
    expect(names(sortAssets(list, "size-desc"))).toEqual(["a", "b", "c"]);
  });

  test("a null size counts as zero rather than dropping the file", () => {
    const list = [asset({ name: "grande", sizeBytes: 900 }), asset({ name: "desconocido", sizeBytes: null })];
    expect(names(sortAssets(list, "size-desc"))).toEqual(["grande", "desconocido"]);
    expect(names(sortAssets(list, "size-asc"))).toEqual(["desconocido", "grande"]);
  });

  test("the input array is never reordered in place", () => {
    // It is the library store's own copy of the view: sorting it there would
    // change what every other subscriber sees, with nothing notified.
    const list = [asset({ name: "b" }), asset({ name: "a" })];
    const sorted = sortAssets(list, "name-asc");
    expect(names(list)).toEqual(["b", "a"]);
    expect(names(sorted)).toEqual(["a", "b"]);
  });
});

describe("filterAssetsByName", () => {
  const list = [asset({ name: "Cántico de María" }), asset({ name: "Sermón 3" }), asset({ name: "video culto" })];

  test("matches ignoring case, accents and surrounding space", () => {
    expect(names(filterAssetsByName(list, "  CANTICO "))).toEqual(["Cántico de María"]);
    expect(names(filterAssetsByName(list, "maria"))).toEqual(["Cántico de María"]);
  });

  test("matches anywhere in the name, not just at the start", () => {
    expect(names(filterAssetsByName(list, "culto"))).toEqual(["video culto"]);
  });

  test("an empty or blank query returns the very same array", () => {
    // Identity, not just equality: the prewarm effect downstream is keyed off
    // this list, and a fresh array on every render would re-arm it.
    expect(filterAssetsByName(list, "")).toBe(list);
    expect(filterAssetsByName(list, "   ")).toBe(list);
  });

  test("no match is an empty list, not the whole view", () => {
    expect(filterAssetsByName(list, "himno")).toEqual([]);
  });
});
