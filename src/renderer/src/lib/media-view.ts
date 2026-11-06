import { normalizeForSearch } from "./utils";
import type { MediaAsset, MediaSortOrder } from "@shared/types/media";

/**
 * How a resource grid turns one view's assets into what is on screen: the
 * name filter the operator typed, then the order they picked.
 *
 * Pure and outside React on purpose — it is the only part of the resource
 * panel with real rules in it (numeric collation, the date being the library's
 * and not the file's, the tie-breaks), and a component is not a place that can
 * be tested.
 */

/** `numeric` is the whole point: a hymnal folder is "Himno 2", "Himno 10",
 *  "Himno 100", and a plain code-unit comparison puts 100 before 2. `base`
 *  sensitivity makes "Ángel" and "angel" neighbours instead of putting every
 *  accented name after Z, which is what a church library is full of. */
const collator = new Intl.Collator("es", { numeric: true, sensitivity: "base" });

/** In «Biblioteca», «newest first» means newest in Lumina, not on the disk
 *  (owner, 2026-11-06): `createdAt` is when the asset joined the library
 *  (`MediaRepo` moves it when a linked folder's file is added), and the id
 *  breaks the tie of one import — every file of a chunk shares its timestamp —
 *  in the order they came in. */
function byAdded(a: MediaAsset, b: MediaAsset): number {
  return a.createdAt - b.createdAt || a.id - b.id;
}

/** A linked folder is the computer's: nothing in it was «added», and its rows
 *  all date from the one read that found them, tied in the disk's own order
 *  (a hash on APFS). Its dates are the files'. `mtimeMs` is null only for an
 *  asset never stat'd. A tie — a folder copied in one go — goes to the name,
 *  A → Z whichever way the dates go (`comparator`). */
function byFileDate(a: MediaAsset, b: MediaAsset): number {
  return (a.mtimeMs ?? a.createdAt) - (b.mtimeMs ?? b.createdAt);
}

/** Which date the two date orders go by: the library's or the files'. */
export type MediaDates = "library" | "file";

function sizeOf(asset: MediaAsset): number {
  return asset.sizeBytes ?? 0;
}

/** Every other order ends in a name comparison, A → Z in both directions (the
 *  library's dates never tie: the id breaks theirs). `Array#sort` is stable,
 *  so without it two files of the same size or date would keep whatever order
 *  the disk or the database handed over, which changes between reads of the
 *  same folder. */
type Compare = (a: MediaAsset, b: MediaAsset) => number;

function comparator(order: MediaSortOrder, dates: MediaDates): Compare {
  const byDate = dates === "library" ? byAdded : byFileDate;
  const comparators: Record<MediaSortOrder, Compare> = {
    "name-asc": (a, b) => collator.compare(a.name, b.name),
    "name-desc": (a, b) => collator.compare(b.name, a.name),
    "date-desc": (a, b) => byDate(b, a) || collator.compare(a.name, b.name),
    "date-asc": (a, b) => byDate(a, b) || collator.compare(a.name, b.name),
    "size-desc": (a, b) => sizeOf(b) - sizeOf(a) || collator.compare(a.name, b.name),
    "size-asc": (a, b) => sizeOf(a) - sizeOf(b) || collator.compare(a.name, b.name),
  };
  return comparators[order];
}

/** Never in place: the array handed in is the one the library store holds, and
 *  sorting it there would reorder the store's own copy of the view without any
 *  subscriber being told. */
export function sortAssets(assets: readonly MediaAsset[], order: MediaSortOrder, dates: MediaDates = "library"): MediaAsset[] {
  return [...assets].sort(comparator(order, dates));
}

/**
 * Filters by name, accent- and case-insensitively (`normalizeForSearch`, the
 * same normalizer the Bible book finder and the programs list use).
 *
 * Returns the input array itself when there is nothing to filter, so an empty
 * box costs no allocation and the `useMemo` above it keeps its identity — the
 * prewarm effect downstream is keyed off this list.
 */
export function filterAssetsByName(assets: readonly MediaAsset[], query: string): readonly MediaAsset[] {
  const needle = normalizeForSearch(query);
  if (needle === "") return assets;
  return assets.filter((asset) => normalizeForSearch(asset.name).includes(needle));
}
