/**
 * A slide model is handed out only once its deck's embedded fonts are in (`lib/slide-models.ts`), so a slide never
 * paints in a fallback face. Two slides of one deck loading at once (GO LIVE, then the neighbour preloaded) share
 * the fonts: the second must wait for the load the first started, not take «already asked for» as «loaded».
 */
import { afterAll, expect, test, vi } from "vitest";
import { slideModelUrl } from "@shared/urls";
import { loadSlideModel } from "@renderer/lib/slide-models";

let releaseFont!: () => void;
const fontLoaded = new Promise<void>((resolve) => (releaseFont = resolve));
const added: unknown[] = [];

class FakeFontFace {
  constructor(private readonly family: string) {}
  load(): Promise<FakeFontFace> {
    // «Stuck Sans»: a font whose request never ends (a protocol read that never answers).
    return this.family === "Stuck Sans" ? new Promise(() => undefined) : fontLoaded.then(() => this);
  }
}

vi.stubGlobal("FontFace", FakeFontFace);
Object.defineProperty(document, "fonts", { configurable: true, value: { add: (face: unknown) => added.push(face) } });
vi.stubGlobal(
  "fetch",
  vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          fonts: [{ family: url.includes("/10/") ? "Stuck Sans" : "Deck Sans", part: "ppt/fonts/font1.fntdata", style: "regular" }],
          elements: [],
          background: null,
        }),
    }),
  ),
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

  releaseFont();
  await Promise.all([first, second]);
  expect(handed.sort()).toEqual(["slide 1", "slide 2"]);
  // Registered once for the window, not once per slide.
  expect(added).toHaveLength(1);
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
  } finally {
    vi.useRealTimers();
  }
});
