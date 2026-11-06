import { describe, expect, test } from "vitest";
import { copyName, viewNamed } from "../../src/renderer/src/lib/named-list";
import es from "../../src/renderer/src/lib/i18n/messages/es";
import en from "../../src/renderer/src/lib/i18n/messages/en";
import it from "../../src/renderer/src/lib/i18n/messages/it";
import pt from "../../src/renderer/src/lib/i18n/messages/pt";
import { isSongThemeUpsert } from "../../src/shared/song-validators";
import { isPlateName, PLATE_NAME_MAX_LENGTH } from "../../src/shared/overlay-validators";
import { isSceneName, SCENE_NAME_MAX_LENGTH } from "../../src/shared/scene-validators";
import { DEFAULT_SONG_THEME, SONG_THEME_NAME_MAX_LENGTH } from "../../src/shared/types/song";

const items = [
  { id: 1, name: "Cuenta regresiva" },
  { id: 2, name: "Reloj" },
  { id: 3, name: "Anuncio café" },
];
const names = (list: readonly { name: string }[]) => list.map((item) => item.name);

describe("a Functions list searched and ordered (owner, 2026-11-05)", () => {
  test("«own» keeps the editor's order; the rest sort by name or by when it came in", () => {
    expect(names(viewNamed(items, "own", "", "es"))).toEqual(["Cuenta regresiva", "Reloj", "Anuncio café"]);
    expect(names(viewNamed(items, "name-asc", "", "es"))).toEqual(["Anuncio café", "Cuenta regresiva", "Reloj"]);
    expect(names(viewNamed(items, "name-desc", "", "es"))).toEqual(["Reloj", "Cuenta regresiva", "Anuncio café"]);
    expect(names(viewNamed(items, "date-desc", "", "es"))).toEqual(["Anuncio café", "Reloj", "Cuenta regresiva"]);
  });

  test("the search is by name, without accents or case", () => {
    expect(names(viewNamed(items, "own", "CAFE", "es"))).toEqual(["Anuncio café"]);
    expect(viewNamed(items, "own", "", "es")).toBe(items);
  });
});

describe("«Duplicate»'s name (QA, 2026-11-06)", () => {
  const fill = (pattern: string) => (name: string) => pattern.replace("{name}", name);

  test("a name with room left only gains the suffix", () => {
    expect(copyName("Reloj", SCENE_NAME_MAX_LENGTH, fill(es.scenes.copyName))).toBe("Reloj (copia)");
  });

  // A name typed up to its field's own limit used to be refused by main as a copy.
  for (const [locale, messages] of [
    ["es", es],
    ["en", en],
    ["it", it],
    ["pt", pt],
  ] as const) {
    test(`${locale}: the copy of a name at the limit is still a valid name, suffix whole`, () => {
      const theme = copyName("x".repeat(SONG_THEME_NAME_MAX_LENGTH), SONG_THEME_NAME_MAX_LENGTH, fill(messages.songThemes.copyName));
      const scene = copyName("x".repeat(SCENE_NAME_MAX_LENGTH), SCENE_NAME_MAX_LENGTH, fill(messages.scenes.copyName));
      const plate = copyName("x".repeat(PLATE_NAME_MAX_LENGTH), PLATE_NAME_MAX_LENGTH, fill(messages.plates.copyName));
      expect(isSongThemeUpsert({ name: theme, style: DEFAULT_SONG_THEME })).toBe(true);
      expect(isSceneName(scene)).toBe(true);
      expect(isPlateName(plate)).toBe(true);
      expect(scene.endsWith(messages.scenes.copyName.replace("{name}", ""))).toBe(true);
    });
  }

  test("the cut never splits an emoji in half", () => {
    // 71 + 🙏 (two UTF-16 units) + 7: the cut at 72 lands between its halves.
    const copy = copyName(`${"x".repeat(71)}🙏${"y".repeat(7)}`, SCENE_NAME_MAX_LENGTH, fill(es.scenes.copyName));
    expect(copy).toBe(`${"x".repeat(71)} (copia)`);
    expect(isSceneName(copy)).toBe(true);
  });
});
