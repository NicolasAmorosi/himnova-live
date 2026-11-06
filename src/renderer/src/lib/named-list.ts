import type { NamedSortOrder } from "@shared/types/settings";
import { normalizeForSearch } from "./utils";

/**
 * A Functions list (time scenes, plates) as the operator asked for it:
 * filtered by name, without accents or case (`normalizeForSearch`, like
 * Media's), and in the chosen order — «own» being the order its editor gives
 * it. The id is the order items came in, like the Songs tab's «date».
 */
export function viewNamed<T extends { id: number; name: string }>(
  items: readonly T[],
  order: NamedSortOrder,
  query: string,
  locale: string,
): readonly T[] {
  const needle = normalizeForSearch(query);
  const shown = needle === "" ? items : items.filter((item) => normalizeForSearch(item.name).includes(needle));
  if (order === "own") return shown;
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const byName = (a: T, b: T) => collator.compare(a.name, b.name) || a.id - b.id;
  const compare: Record<Exclude<NamedSortOrder, "own">, (a: T, b: T) => number> = {
    "name-asc": byName,
    "name-desc": (a, b) => byName(b, a),
    "date-desc": (a, b) => b.id - a.id,
    "date-asc": (a, b) => a.id - b.id,
  };
  return [...shown].sort(compare[order]);
}
