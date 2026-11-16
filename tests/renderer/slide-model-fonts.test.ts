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
  load(): Promise<FakeFontFace> {
    return fontLoaded.then(() => this);
  }
}

vi.stubGlobal("FontFace", FakeFontFace);
Object.defineProperty(document, "fonts", { configurable: true, value: { add: (face: unknown) => added.push(face) } });
vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({ fonts: [{ family: "Deck Sans", part: "ppt/fonts/font1.fntdata", style: "regular" }], elements: [], background: null }),
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
