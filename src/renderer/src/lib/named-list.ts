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

/**
 * «Duplicate»'s name — `fill` is the language's «{name} (copy)» — cut to fit
 * `max`, the limit main checks the copy's name against: a name typed up to its
 * field's own limit had no room left for the suffix, and main refused the
 * copy. The name is what gets cut, never the suffix — and never half an
 * emoji: a cut through a surrogate pair drops its first half too.
 */
export function copyName(name: string, max: number, fill: (name: string) => string): string {
  const overflow = fill(name).length - max;
  if (overflow <= 0) return fill(name);
  return fill(name.slice(0, Math.max(0, name.length - overflow)).replace(/[\uD800-\uDBFF]$/, "").trimEnd());
}
