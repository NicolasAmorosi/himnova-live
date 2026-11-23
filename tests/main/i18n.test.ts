/**
 * The dictionary mechanics both processes share (`shared/i18n.ts`), and main's
 * reading of an OS language tag.
 */
import { describe, expect, test } from "vitest";
import { interpolate } from "../../src/shared/i18n";
import { toLocale } from "../../src/main/i18n";
import mainEs from "../../src/main/i18n/messages/es";
import mainEn from "../../src/main/i18n/messages/en";
import mainIt from "../../src/main/i18n/messages/it";
import mainPt from "../../src/main/i18n/messages/pt";

const items = "{count, plural, one {# item} other {# items}}";

describe("interpolate", () => {
  test("fills placeholders and leaves unknown ones alone", () => {
    expect(interpolate("{name} (copy)", { name: "Easter" }, "en")).toBe("Easter (copy)");
    expect(interpolate("{name} of {total}", { name: "1" }, "en")).toBe("1 of {total}");
  });

  test("picks the plural form by the locale's rules", () => {
    expect(interpolate(items, { count: 1 }, "en")).toBe("1 item");
    expect(interpolate(items, { count: 0 }, "en")).toBe("0 items");
    // Portuguese counts 0 as singular; Spanish and English do not.
    expect(interpolate(items, { count: 0 }, "pt")).toBe("0 item");
    expect(interpolate(`Hay ${items} sin convertir.`, { count: 3 }, "es")).toBe("Hay 3 items sin convertir.");
  });

  test("an exact form wins over the category", () => {
    expect(interpolate("{n, plural, =0 {none} one {# file} other {# files}}", { n: 0 }, "pt")).toBe("none");
  });
});

describe("toLocale", () => {
  test("reduces an OS tag to a supported locale", () => {
    expect(toLocale("pt-BR")).toBe("pt");
    expect(toLocale("en_GB")).toBe("en");
    expect(toLocale("es-419")).toBe("es");
    expect(toLocale("fr-FR")).toBeNull();
    expect(toLocale("")).toBeNull();
  });
});

/** The renderer's dictionaries sit outside this project's tsconfig: a computed path keeps the type checker out
 *  of them, and their strings are all these tests read. */
const [es, en, it, pt] = await Promise.all(
  ["es", "en", "it", "pt"].map(async (locale) => {
    const path = `../../src/renderer/src/lib/i18n/messages/${locale}.ts`;
    const { default: dictionary } = (await import(path)) as { default: object };
    return dictionary;
  }),
);

/** Every string of a dictionary as `[key.path, value]`. */
function strings(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, child]) => strings(child, path ? `${path}.${key}` : key));
}

describe("dictionaries", () => {
  const dictionaries = Object.entries({ es, en, it, pt, mainEs, mainEn, mainIt, mainPt });

  // The owner's rule for text people read: no long dash, and no spaced hyphen or
  // en dash as a pause either (an en dash inside a range, «1–2», is fine).
  test.each(dictionaries)("%s has no long dash nor a spaced dash", (_name, dictionary) => {
    const dashed = strings(dictionary).filter(([, value]) => /\u2014| [-\u2013] /.test(value));
    expect(dashed.map(([key, value]) => `${key}: ${value}`)).toEqual([]);
  });

  // en, it and pt call the order of service a schedule, a scaletta and a roteiro: their word
  // for «program» is left to other software (OBS, vMix, an installer, a song file's editor).
  const software = /^(settings\.ndi\.|welcome\.stream\.|settings\.updatesErrors\.install$|songs\.file)/;
  const program = { en: /\bprograms?\b/i, it: /programm/i, pt: /\bprogramas?\b/i };
  test.each([["en", en, mainEn], ["it", it, mainIt], ["pt", pt, mainPt]] as const)(
    "%s says program only for other software",
    (locale, dictionary, main) => {
      const found = [...strings(dictionary), ...strings(main)].filter(
        ([key, value]) => program[locale].test(value) && !software.test(key),
      );
      expect(found.map(([key, value]) => `${key}: ${value}`)).toEqual([]);
    },
  );
});
