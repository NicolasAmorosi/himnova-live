import { describe, expect, test } from "vitest";
import { alpha, roman } from "../../src/main/slides/list-number";

describe("a list's number in roman numerals and letters", () => {
  test("roman numerals use the subtractive pairs", () => {
    expect([1, 4, 9, 14, 40, 90, 400, 1994, 3999].map(roman)).toEqual(["i", "iv", "ix", "xiv", "xl", "xc", "cd", "mcmxciv", "mmmcmxcix"]);
  });

  test("letters run a..z, then aa..az, ba.., like a spreadsheet's columns", () => {
    expect([1, 26, 27, 52, 53, 702, 703].map(alpha)).toEqual(["a", "z", "aa", "az", "ba", "zz", "aaa"]);
  });

  test("zero has no numeral", () => {
    expect([roman(0), alpha(0)]).toEqual(["", ""]);
  });
});
