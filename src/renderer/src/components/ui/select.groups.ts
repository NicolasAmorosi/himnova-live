import { normalizeForSearch } from "@renderer/lib/utils";
import type { SelectOption } from "./select";

/**
 * The options in the order the menu lists them. With groups, each group's options together, the groups in the order
 * they first appear and each one's options in their own order — the caller's list is the operator's arrangement
 * (the installed bibles), and grouping must not reorder it beyond gathering. Without groups, `options` itself.
 */
export function orderByGroup(options: readonly SelectOption[]): readonly SelectOption[] {
  if (!options.some((option) => option.group !== undefined)) return options;
  const groups = new Map<string | undefined, SelectOption[]>();
  for (const option of options) {
    const members = groups.get(option.group);
    if (members) members.push(option);
    else groups.set(option.group, [option]);
  }
  return [...groups.values()].flat();
}

/** What the search box leaves: the matching options, still grouped. */
export function filterOptions(options: readonly SelectOption[], query: string): readonly SelectOption[] {
  const needle = normalizeForSearch(query);
  return needle === "" ? options : options.filter((option) => normalizeForSearch(option.label).includes(needle));
}

/** The group header to draw above `visible[index]`: its group's name at the first option of each run, else `null`.
 *  Headers are drawn, never indexed — the keyboard's highlight walks the options alone and steps over them. */
export function groupHeaderAt(visible: readonly SelectOption[], index: number): string | null {
  const group = visible[index]?.group;
  return group !== undefined && group !== visible[index - 1]?.group ? group : null;
}
