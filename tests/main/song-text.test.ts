/**
 * The lyrics text format: headers in four languages, the guess for text
 * pasted without any, the order line, the round trip, and the editor's caret
 * ↔ slide link.
 */
import { describe, expect, test } from "vitest";
import {
  caretAtSlide,
  formatOrder,
  missingOrderKeys,
  parseLyrics,
  parseOrder,
  sectionLabel,
  sectionsIn,
  serializeLyrics,
  slideAtCaret,
  songDeckSlides,
  splitSection,
  withTranslation,
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

describe("the caret and the slides", () => {
  /** The song as projected, the way `resolveSong` builds it. */
  const deck = (text: string, maxLines = 0, order?: string[]) => {
    const parsed = parseLyrics(text, "es");
    const sections = parsed.sections.map((section) => splitSection(section, maxLines));
    return songDeckSlides(sections, order ?? parsed.sequence);
  };
  /** The slide (0-based) under the caret placed right before `needle`. */
  const at = (text: string, needle: string, maxLines = 0, preferred: number | null = null, order?: string[]) =>
    slideAtCaret(text, text.indexOf(needle), "es", maxLines, deck(text, maxLines, order), preferred);
  /** The line the caret lands on for slide `index`. */
  const landsOn = (text: string, index: number, maxLines = 0) => {
    const offset = caretAtSlide(text, "es", maxLines, deck(text, maxLines)[index]!);
    return offset === null ? null : text.slice(offset).split("\n")[0];
  };

  const headed = "[Estrofa 1]\nuno\ndos\n\ntres\n\n[Coro]\ncoro a\ncoro b\n\n[Estrofa 2]\ncuatro\n\n[Coro]";

  test("with headers: a lyric line is its slide; a header or a blank line, the slide that comes next", () => {
    expect(at(headed, "uno")).toBe(0);
    expect(at(headed, "dos")).toBe(0);
    expect(at(headed, "tres")).toBe(1);
    expect(at(headed, "[Coro]")).toBe(2);
    expect(at(headed, "\n\n[Estrofa 2]")).toBe(2); // the end of «coro b» is still the chorus
    expect(at(headed, "\n[Estrofa 2]")).toBe(3); // the blank line after it belongs to what follows
    expect(at(headed, "cuatro")).toBe(3);
  });

  test("a chorus the order sings twice: the pass chosen stays, else the first", () => {
    // The bare «[Coro]» at the end is the chorus again: E1 E1 C E2 C.
    expect(deck(headed).map((s) => s.lines[0])).toEqual(["uno", "tres", "coro a", "cuatro", "coro a"]);
    expect(at(headed, "coro a")).toBe(2);
    expect(at(headed, "coro a", 0, 4)).toBe(4);
    expect(at(headed, "coro a", 0, 3)).toBe(2);
  });

  test("without headers: the block that comes back is the chorus, wherever it is written", () => {
    // Not «coro»: a bare section name at the start of a block is a header.
    const text = "uno\n\nven ya\n\ndos\n\nven ya";
    expect(deck(text).map((s) => s.sectionKey)).toEqual(["v1", "c1", "v2", "c1"]);
    expect(at(text, "dos")).toBe(2);
    expect(at(text, "ven ya")).toBe(1);
    expect(at(text, "ven ya", 0, 3)).toBe(3);
    expect(landsOn(text, 3)).toBe("ven ya");
    expect(text.indexOf("ven ya")).toBe(caretAtSlide(text, "es", 0, deck(text)[3]!));
  });

  test("double blank lines and padding change nothing", () => {
    const text = "[Coro]\n  a  \n\n\n\nb\n\n\n";
    expect(at(text, "  a")).toBe(0);
    expect(at(text, "\n\n\nb")).toBe(1);
    expect(at(text, "b")).toBe(1);
    expect(slideAtCaret(text, text.length, "es", 0, deck(text), null)).toBe(1);
    expect(landsOn(text, 1)).toBe("b");
  });

  test("a theme that splits long slides: the caret follows the piece, and back", () => {
    const text = "[Estrofa 1]\n1\n2\n3\n4\n5\n\n6\n[Coro]\nc";
    // 2 lines a slide: [1 2] [3 4] [5] [6] [c]
    expect(deck(text, 2).map((s) => s.lines.join(" "))).toEqual(["1 2", "3 4", "5", "6", "c"]);
    expect(at(text, "4", 2)).toBe(1);
    expect(at(text, "5", 2)).toBe(2);
    expect(at(text, "6", 2)).toBe(3);
    expect(at(text, "c", 2)).toBe(4);
    expect([0, 1, 2, 3, 4].map((i) => landsOn(text, i, 2))).toEqual(["1", "3", "5", "6", "c"]);
  });

  test("a section out of the order is not projected: no slide", () => {
    expect(at(headed, "cuatro", 0, null, ["v1", "c1"])).toBeNull();
    expect(slideAtCaret("", 0, "es", 0, [], null)).toBeNull();
  });

  test("Windows line ends count as one line", () => {
    const text = "[Estrofa 1]\r\nuno\r\n\r\n[Coro]\r\ncoro";
    expect(at(text, "coro")).toBe(1);
    expect(landsOn(text.replace(/\r/g, ""), 1)).toBe("coro");
    expect(text.slice(caretAtSlide(text, "es", 0, deck(text)[1]!)!)).toBe("coro");
  });
});

describe("chords (2026-11-05)", () => {
  test("written inline, read apart from the words, and written back the same", () => {
    const text = "[Estrofa 1]\n[G]Sublime [C]gracia\ndel Señor\n\n[Coro]\n[D]Aleluya";
    const { sections } = parseLyrics(text, "es");
    expect(sections[0]?.slides[0]).toEqual({
      lines: ["Sublime gracia", "del Señor"],
      chords: [
        [
          { at: 0, name: "G" },
          { at: 8, name: "C" },
        ],
        [],
      ],
    });
    expect(serializeLyrics(sections, "es")).toBe(text);
  });

  test("a word in brackets is not a chord, and a chorus with its chords is still the same chorus", () => {
    const { sections, sequence } = parseLyrics("[Coro]\n[G]Santo [sic]\n\n[Estrofa]\nuno\n\n[Coro]\n[G]Santo [sic]", "es");
    expect(sections[0]?.slides[0]).toEqual({ lines: ["Santo [sic]"], chords: [[{ at: 0, name: "G" }]] });
    expect(sequence).toEqual(["c1", "v1", "c1"]);
  });

  test("split with their lines, kept by a translation, and never over one", () => {
    const [section] = parseLyrics("[Estrofa 1]\n[G]uno\n[C]dos\n[D]tres", "es").sections;
    const split = splitSection(section!, 2);
    expect(split.slides.map((slide) => slide.chords)).toEqual([
      [[{ at: 0, name: "G" }], [{ at: 0, name: "C" }]],
      [[{ at: 0, name: "D" }]],
    ]);
    const translated = withTranslation([section!], parseLyrics("[Estrofa 1]\none\ntwo\nthree", "es").sections);
    expect(translated[0]?.slides[0]?.chords).toEqual(section!.slides[0]?.chords);
    expect(sectionsIn(translated, "translation")[0]?.slides[0]).toEqual({ lines: ["one", "two", "three"] });
    expect(sectionsIn(translated, "original")[0]?.slides[0]?.chords).toEqual(section!.slides[0]?.chords);
  });
});

test("a line that ends on a chord is a line, not a header", () => {
  const { sections } = parseLyrics("[Estrofa 1]\n[G]Cuán grande es [D]\n\n[Coro]\ncoro", "es");
  expect(sections.map((section) => section.key)).toEqual(["v1", "c1"]);
  expect(sections[0]?.slides[0]).toEqual({ lines: ["Cuán grande es"], chords: [[{ at: 0, name: "G" }, { at: 14, name: "D" }]] });
});
