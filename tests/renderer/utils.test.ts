/**
 * `lib/utils.ts` — the four things the whole renderer leans on.
 *
 * `cn`'s shadow case and `normalizeForSearch` are both former bugs: the
 * semantic shadow scale is not in tailwind-merge's default value list, and the
 * accent normalizer existed in three slightly different copies, two of which
 * spelled the combining range out as raw invisible characters.
 */
import { describe, expect, test } from "vitest";
import { cn, createBoundedSet, formatBytes, formatClock, languageName, normalizeForSearch } from "@renderer/lib/utils";

describe("cn", () => {
  test("the later class wins a conflict", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  test("the semantic shadow scale conflicts with itself", () => {
    // Without the `extendTailwindMerge` config both survive, and cascade order
    // — not className order — picks the winner.
    expect(cn("shadow-surface", "shadow-none")).toBe("shadow-none");
    expect(cn("shadow-raised", "shadow-overlay")).toBe("shadow-overlay");
  });

  test("the two added type steps are sizes, not colours", () => {
    // Unknown to tailwind-merge, `text-dense` is a colour and erases the
    // `text-foreground` beside it — the text turns the inherited colour.
    expect(cn("text-dense", "text-foreground")).toBe("text-dense text-foreground");
    expect(cn("text-sm", "text-dense")).toBe("text-dense");
    expect(cn("text-2xs", "text-xs")).toBe("text-xs");
  });

  test("falsy values drop out, so a conditional class needs no ternary", () => {
    expect(cn("p-2", false, undefined, null, "m-1")).toBe("p-2 m-1");
  });
});

describe("normalizeForSearch", () => {
  test("case, accents and surrounding space all stop mattering", () => {
    expect(normalizeForSearch("  Éxodo ")).toBe("exodo");
    expect(normalizeForSearch("CANTICOS")).toBe("canticos");
    expect(normalizeForSearch("Cánticos")).toBe(normalizeForSearch("canticos"));
  });

  test("the ñ keeps its letter and loses only the tilde", () => {
    // A Spanish search box: typing "ano" has to find "Año", and the two must
    // normalize to the same thing rather than one of them losing the letter.
    expect(normalizeForSearch("Año")).toBe("ano");
  });

  test("an empty or blank string normalizes to nothing", () => {
    expect(normalizeForSearch("   ")).toBe("");
  });
});

describe("formatClock", () => {
  test("m:ss below the hour, h:mm:ss above it", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(9)).toBe("0:09");
    expect(formatClock(547)).toBe("9:07");
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3725)).toBe("1:02:05");
  });

  test("a duration that has not loaded yet reads as zero, never NaN", () => {
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(formatClock(-12)).toBe("0:00");
  });
});

describe("formatBytes", () => {
  test("the unit follows the magnitude, with a Spanish decimal comma", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1536)).toBe("1,5 kB");
    expect(formatBytes(4 * 1024 ** 3)).toBe("4,0 GB");
  });

  test("a negative size is floored at zero", () => {
    expect(formatBytes(-5)).toBe("0 B");
  });
});

describe("createBoundedSet", () => {
  test("remembers what it was told", () => {
    const set = createBoundedSet(3);
    set.add("a");
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(false);
  });

  test("forgets its oldest entries past the cap", () => {
    // A long session browsing a large library would otherwise grow these
    // registries without end.
    const set = createBoundedSet(2);
    set.add("a");
    set.add("b");
    set.add("c");
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
  });

  test("re-adding a known value does not evict anything", () => {
    const set = createBoundedSet(2);
    set.add("a");
    set.add("b");
    set.add("a");
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
  });
});

describe("languageName", () => {
  test("in the interface's language, capitalized; an unknown tag as it is", () => {
    expect(languageName("en", "es")).toBe("Inglés");
    expect(languageName("pt", "it")).toBe("Portoghese");
    expect(languageName("es", "en")).toBe("Spanish");
    expect(languageName("it", "pt")).toBe("Italiano");
    expect(languageName("zz", "es")).toBe("zz");
    expect(languageName("?", "es")).toBe("?");
  });
});
