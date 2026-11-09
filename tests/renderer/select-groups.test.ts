/**
 * `Select`'s option groups (`components/ui/select.groups.ts`): what the menu lists and in which order, and where a
 * group's heading goes. The keyboard's highlight indexes the listed options only, so a heading is never a stop.
 */
import { describe, expect, test } from "vitest";
import { filterOptions, groupHeaderAt, orderByGroup } from "@renderer/components/ui/select.groups";
import type { SelectOption } from "@renderer/components/ui/select";

const option = (label: string, group?: string): SelectOption => ({ label, value: label, ...(group ? { group } : {}) });
const labels = (options: readonly SelectOption[]) => options.map((o) => o.label);
const headers = (options: readonly SelectOption[]) => options.map((_, i) => groupHeaderAt(options, i));

describe("Select option groups", () => {
  test("without groups the list is the caller's, untouched, with no headings", () => {
    const options = [option("b"), option("a")];
    expect(orderByGroup(options)).toBe(options);
    expect(headers(options)).toEqual([null, null]);
  });

  test("groups gather in the order they first appear, each keeping its own order", () => {
    const ordered = orderByGroup([
      option("RV1909", "Español"),
      option("KJV", "Inglés"),
      option("Prueba", "Español"),
      option("ASV", "Inglés"),
      option("Almeida", "Portugués"),
    ]);
    expect(labels(ordered)).toEqual(["RV1909", "Prueba", "KJV", "ASV", "Almeida"]);
    expect(headers(ordered)).toEqual(["Español", null, "Inglés", null, "Portugués"]);
  });

  test("a search keeps the matching options under their own headings", () => {
    const ordered = orderByGroup([
      option("Reina-Valera", "Español"),
      option("King James", "Inglés"),
      option("Revised", "Inglés"),
    ]);
    const found = filterOptions(ordered, "re");
    expect(labels(found)).toEqual(["Reina-Valera", "Revised"]);
    expect(headers(found)).toEqual(["Español", "Inglés"]);
    expect(filterOptions(ordered, "")).toBe(ordered);
    // Accent-blind, like every search in the app.
    expect(labels(filterOptions([option("Bíblia Livre", "Portugués")], "biblia"))).toEqual(["Bíblia Livre"]);
  });
});
