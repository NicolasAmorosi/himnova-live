/**
 * A slide model is handed out only once its deck's embedded fonts are in (`lib/slide-models.ts`), so a slide never
 * paints in a fallback face. Two slides of one deck loading at once (GO LIVE, then the neighbour preloaded) share
 * the fonts: the second must wait for the load the first started, not take «already asked for» as «loaded».
 */
import { afterAll, expect, test, vi } from "vitest";
import { slideModelUrl } from "@shared/urls";
import { loadSlideModel } from "@renderer/lib/slide-models";
import { fontsLoadedCount } from "@renderer/components/shared/slide-view/slide-metrics";

let releaseFont!: () => void;
const fontLoaded = new Promise<void>((resolve) => (releaseFont = resolve));
const added: unknown[] = [];
const constructed: string[] = [];

class FakeFontFace {
  constructor(private readonly family: string) {
    constructed.push(family);
  }
  load(): Promise<FakeFontFace> {
    // «Stuck Sans» and «Unused Sans»: a font whose request never ends (a protocol read that never answers).
    return this.family === "Stuck Sans" || this.family === "Unused Sans" ? new Promise(() => undefined) : fontLoaded.then(() => this);
  }
}

vi.stubGlobal("FontFace", FakeFontFace);
Object.defineProperty(document, "fonts", { configurable: true, value: { add: (face: unknown) => added.push(face) } });
vi.stubGlobal(
  "fetch",
  vi.fn((url: string) => {
    // Deck 11 embeds two faces and its text names one of them.
    const family = url.includes("/10/") ? "Stuck Sans" : url.includes("/11/") ? "Used Sans" : "Deck Sans";
    const fonts = [{ family, part: "ppt/fonts/font1.fntdata", style: "regular" }];
    if (url.includes("/11/")) fonts.push({ family: "Unused Sans", part: "ppt/fonts/font2.fntdata", style: "regular" });
    const elements = [{ runs: [{ font: `"${family}", "Carlito", sans-serif` }] }];
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ fonts, elements, background: null }) });
  }),
);

afterAll(() => {
  vi.unstubAllGlobals();
});

test("the second slide of a deck waits for the embedded font the first one is still loading", async () => {
  const handed: string[] = [];
  const first = loadSlideModel(slideModelUrl(9, 0)).then(() => handed.push("slide 1"));
  const second = loadSlideModel(slideModelUrl(9, 1)).then(() => handed.push("slide 2"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Neither may reach the screen in the fallback face.
  expect(handed).toEqual([]);

  const before = fontsLoadedCount();
  releaseFont();
  await Promise.all([first, second]);
  expect(handed.sort()).toEqual(["slide 1", "slide 2"]);
  // Registered once for the window, not once per slide.
  expect(added).toHaveLength(1);
  // Added already loaded, it fires no `loadingdone`: the slides are told directly to draw again (review of 2026-11-16).
  expect(fontsLoadedCount()).toBe(before + 1);
});

test("a font whose load never ends holds a slide a few seconds at most, not for good", async () => {
  // Every slide of the deck waits for the font's one load (A42): one that never finished held them all, and the deck
  // on air never changed slide again (final pass of the 2026-11-15 audit, A42).
  vi.useFakeTimers();
  try {
    let handed = false;
    void loadSlideModel(slideModelUrl(10, 0)).then((model) => (handed = model !== null));
    await vi.advanceTimersByTimeAsync(1000);
    expect(handed).toBe(false);
    await vi.advanceTimersByTimeAsync(2500);
    expect(handed).toBe(true);
    // The next slide of that deck does not wait 3 s more: the cap is the font's, once (review of 2026-11-16).
    let next = false;
    void loadSlideModel(slideModelUrl(10, 1)).then((model) => (next = model !== null));
    await vi.advanceTimersByTimeAsync(10);
    expect(next).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("a slide waits only for the embedded fonts its own text names, not for the whole deck's", async () => {
  // Every model carries the deck's whole list: a first slide that named 5 of 24 faces waited for all 24 to be decoded
  // and loaded, and an .odp whose text names none of its 11 waited for them all (2026-11-23).
  releaseFont();
  const model = await Promise.race([
    loadSlideModel(slideModelUrl(11, 0)),
    new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 200)),
  ]);
  expect(model).not.toBe("held");
  expect(constructed).toContain("Used Sans");
  expect(constructed).not.toContain("Unused Sans");
});
