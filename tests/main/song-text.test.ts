/**
 * The lyrics text format: headers in four languages, the guess for text
 * pasted without any, the order line, and the round trip.
 */
import { describe, expect, test } from "vitest";
import {
  formatOrder,
  missingOrderKeys,
  parseLyrics,
  parseOrder,
  sectionLabel,
  serializeLyrics,
  songDeckSlides,
} from "../../src/shared/song-text";

const keysOf = (text: string, locale: "es" | "en" | "it" | "pt" = "es") =>
  parseLyrics(text, locale).sections.map((s) => s.key);

describe("headers", () => {
  test("a blank line is another slide of the same section", () => {
    const { sections, sequence } = parseLyrics("[Estrofa 1]\nuno\ndos\n\ntres\n\n[Coro]\ncoro", "es");
    expect(sections).toEqual([
      { key: "v1", type: "verse", number: 1, slides: [{ lines: ["uno", "dos"] }, { lines: ["tres"] }] },
      { key: "c1", type: "chorus", number: 1, slides: [{ lines: ["coro"] }] },
    ]);
    expect(sequence).toEqual(["v1", "c1"]);
  });

  test("every language's names and the short forms are read", () => {
    expect(keysOf("[Verse 2]\na\n[Pre-Chorus]\nb\n[Bridge]\nc\n[Ending]\nd", "en")).toEqual(["v2", "pc1", "b1", "e1"]);
    expect(keysOf("[Strofa 1]\na\n[Ritornello]\nb\n[Ponte]\nc", "it")).toEqual(["v1", "c1", "b1"]);
    expect(keysOf("[Estrofe 1]\na\n[Pré-refrão]\nb\n[Refrão]\nc", "pt")).toEqual(["v1", "pc1", "c1"]);
    expect(keysOf("[V1]\na\n[C]\nb\n[P]\nc")).toEqual(["v1", "c1", "b1"]);
    expect(keysOf("[PRECORO]\na\n[estribillo]\nb\n[Introducción]\nc")).toEqual(["pc1", "c1", "i1"]);
  });

  test("the interface's language decides an ambiguous letter", () => {
    expect(keysOf("[E]\na", "es")).toEqual(["v1"]);
    expect(keysOf("[E]\na", "en")).toEqual(["e1"]);
    expect(keysOf("[Outro]\na", "en")).toEqual(["e1"]);
    expect(keysOf("[Outro]\na", "pt")).toEqual(["o1"]);
  });

  test("a bare label at the start of a block is a header; inside a block it is lyrics", () => {
    const { sections } = parseLyrics("Coro:\nla la\n\nVerse 2\nb", "es");
    expect(sections.map((s) => s.key)).toEqual(["c1", "v2"]);
    expect(parseLyrics("[Estrofa 1]\nCoro\notra", "es").sections[0]!.slides[0]!.lines).toEqual(["Coro", "otra"]);
  });

  test("an unknown bracketed name is a section of its own, never lost", () => {
    expect(parseLyrics("[Ministración]\nalgo", "es").sections).toEqual([
      { key: "o1", type: "other", number: 1, slides: [{ lines: ["algo"] }] },
    ]);
  });

  test("a repeated header is a repetition in the sequence, and different words a new section", () => {
    const repeated = parseLyrics("[Estrofa 1]\na\n[Coro]\nc\n[Estrofa 2]\nb\n[Coro]\n\n[Coro]\nc", "es");
    expect(repeated.sections.map((s) => s.key)).toEqual(["v1", "c1", "v2"]);
    expect(repeated.sequence).toEqual(["v1", "c1", "v2", "c1", "c1"]);
    const differs = parseLyrics("[Coro]\nuno\n[Coro]\ndos", "es");
    expect(differs.sections.map((s) => s.key)).toEqual(["c1", "c2"]);
  });

  test("lines above the first header are a verse; a header named before its words resolves", () => {
    expect(parseLyrics("sin título\n[Coro]\nc", "es").sections.map((s) => s.key)).toEqual(["v1", "c1"]);
    const early = parseLyrics("[Coro]\n\n[Estrofa 1]\na\n[Coro]\nc", "es");
    expect(early.sequence).toEqual(["c1", "v1", "c1"]);
  });
});

describe("text pasted without headers", () => {
  test("each block is a verse and a block that comes back is the chorus", () => {
    const { sections, sequence } = parseLyrics("A1\nA2\n\nB\n\nC\n\nB\n\nD\n\nB", "es");
    expect(sections.map((s) => s.key)).toEqual(["v1", "c1", "v2", "v3"]);
    expect(sections[1]!.slides).toEqual([{ lines: ["B"] }]);
    expect(sequence).toEqual(["v1", "c1", "v2", "c1", "v3", "c1"]);
  });

  test("Windows line ends, padding and extra blank lines change nothing", () => {
    expect(parseLyrics("  a  \r\n\r\n\r\n\r\nb\r\n", "es").sections.map((s) => s.slides)).toEqual([
      [{ lines: ["a"] }],
      [{ lines: ["b"] }],
    ]);
  });
});

describe("the round trip", () => {
  const canonical = "[Estrofa 1]\nuno\ndos\n\ntres\n\n[Coro]\ncoro\n\n[Coro 2]\notro\n\n[Puente]\npuente";

  test("text → sections → text gives the same text", () => {
    expect(serializeLyrics(parseLyrics(canonical, "es").sections, "es")).toBe(canonical);
  });

  test("sections written in another language come back to the same sections", () => {
    const { sections } = parseLyrics(canonical, "es");
    for (const locale of ["en", "it", "pt"] as const) {
      expect(parseLyrics(serializeLyrics(sections, locale), locale).sections).toEqual(sections);
    }
  });

  test("labels: a verse always numbered, the rest only from the second", () => {
    expect(sectionLabel("verse", 1, "es")).toBe("Estrofa 1");
    expect(sectionLabel("chorus", 1, "es")).toBe("Coro");
    expect(sectionLabel("chorus", 2, "en")).toBe("Chorus 2");
  });
});

describe("the order", () => {
  test("the short line round-trips, in the interface's letters", () => {
    const keys = ["v1", "c1", "v2", "c1", "b1", "c1", "c1"];
    expect(formatOrder(keys, "es")).toBe("E1 C E2 C P C C");
    expect(parseOrder("E1 C E2 C P C C", "es")).toEqual({ keys, invalid: [] });
    expect(formatOrder(keys, "en")).toBe("V1 C V2 C B C C");
    expect(parseOrder("v1, c, v2 · c b c c", "en").keys).toEqual(keys);
  });

  test("a token naming nothing is reported, not guessed", () => {
    expect(parseOrder("E1 X9 C", "es")).toEqual({ keys: ["v1", "c1"], invalid: ["X9"] });
  });

  test("the slides follow the order, skipping a section that is gone", () => {
    const { sections } = parseLyrics("[Estrofa 1]\na\n\nb\n[Coro]\nc", "es");
    const slides = songDeckSlides(sections, ["v1", "c1", "x1", "c1"]);
    expect(slides.map((s) => [s.lines[0], s.pass, s.indexInSection])).toEqual([
      ["a", 0, 0],
      ["b", 0, 1],
      ["c", 1, 0],
      ["c", 3, 0],
    ]);
    expect(songDeckSlides(sections, []).map((s) => s.lines[0])).toEqual(["a", "b", "c"]);
    expect(missingOrderKeys(sections, ["v1", "x1", "x1"])).toEqual(["x1"]);
  });
});
