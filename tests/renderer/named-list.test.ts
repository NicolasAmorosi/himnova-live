import { describe, expect, test } from "vitest";
import { viewNamed } from "../../src/renderer/src/lib/named-list";

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
