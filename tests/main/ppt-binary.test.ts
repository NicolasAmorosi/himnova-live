/**
 * Reading a legacy binary deck made of pictures: which pictures make up each
 * slide, which decks are refused, and the bytes served from the source.
 *
 * The rule under test is the one that keeps the projector honest: a slide is
 * drawn natively only when it is a picture we can draw exactly — the topmost
 * opaque JPEG covering the slide, with nothing above it but pictures or things
 * PowerPoint does not show. Anything else sends the whole deck to the model
 * reader, never half of it, and never a slide drawn wrong in silence.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  binaryTransition,
  readBinaryDeck,
  readBinaryExternalPaths,
  readBinaryPictures,
  readBinarySlideTimings,
  type BinaryDeck,
} from "../../src/main/slides/ppt-binary";
import { encodeSlideLayers, imagePixelSize, renderNativeSlide } from "../../src/main/slides/native-deck";
import { buildLegacyPpt, jpegHeader, pngHeader, type LegacyDeck, type LegacyShape } from "../fixtures/legacy-ppt";

const W = 5760;
const H = 4320;
const FULL: [number, number, number, number] = [0, 0, W, H];
/** The hymnal's white logo, bottom right. */
const LOGO: [number, number, number, number] = [3748, 5057, 5411, 4072];
/** Where PowerPoint puts an inserted sound's icon: the middle of the slide. */
const SPEAKER: [number, number, number, number] = [2064, 2784, 2976, 2256];

const JPEG_A = jpegHeader(800, 600, 100);
const JPEG_B = jpegHeader(800, 600, 200);
const LOGO_PNG = pngHeader(59, 54);
const SPEAKER_PNG = pngHeader(32, 32);

let dir: string;
let n = 0;

function write(deck: LegacyDeck): string {
  const file = path.join(dir, `deck-${n++}.pps`);
  fs.writeFileSync(file, buildLegacyPpt(deck));
  return file;
}

/** A hymn as the real ones are: a JPEG per slide, the logo and a hidden
 *  speaker on the first, and the linked song's path in the external objects. */
function hymn(overrides: { first?: LegacyShape[]; second?: LegacyShape[] } = {}): LegacyDeck {
  return {
    pictures: [
      { type: "jpeg", bytes: JPEG_A },
      { type: "jpeg", bytes: JPEG_B },
      { type: "png", bytes: LOGO_PNG },
      { type: "png", bytes: SPEAKER_PNG },
    ],
    slides: [
      {
        slideTimeMs: 10_515,
        infoFlags: 0x0400,
        effectType: 23,
        speed: 0,
        shapes: overrides.first ?? [
          { rect: FULL, pib: 1 },
          { rect: SPEAKER, pib: 4, media: { hideWhileNotPlaying: true } },
          { rect: LOGO, pib: 3 },
        ],
      },
      {
        slideTimeMs: 11_297,
        infoFlags: 0x0400,
        effectType: 8,
        effectDirection: 1,
        speed: 1,
        shapes: overrides.second ?? [{ rect: FULL, pib: 2 }],
      },
    ],
    externalPaths: ["C:\\Documents and Settings\\Joel Rivas\\Escritorio\\himnos\\522 Suenen las palabras.mp3"],
  };
}

function deckOf(file: string): BinaryDeck {
  const read = readBinaryDeck(file);
  if (!read || "unsupported" in read) throw new Error(`expected a native deck, got ${JSON.stringify(read)}`);
  return read.deck;
}

function refusal(file: string): string {
  const read = readBinaryDeck(file);
  if (!read || !("unsupported" in read)) throw new Error(`expected a refusal, got ${JSON.stringify(read)}`);
  return read.unsupported;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-ppt-binary-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a deck made of pictures is read as its pictures", () => {
  test("each slide is its JPEG, plus the logo over the first — the hidden speaker is not drawn", () => {
    const deck = deckOf(write(hymn()));
    expect(deck).toMatchObject({ width: W, height: H });
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0]!.layers.map(({ type, x, y, width, height }) => ({ type, x, y, width, height }))).toEqual([
      { type: "jpeg", x: 0, y: 0, width: W, height: H },
      { type: "png", x: LOGO[1], y: LOGO[0], width: LOGO[2] - LOGO[1], height: LOGO[3] - LOGO[0] },
    ]);
    expect(deck.slides[1]!.layers).toHaveLength(1);
  });

  test("timings and transitions come from the slide itself", () => {
    const deck = deckOf(write(hymn()));
    expect(deck.slides.map((slide) => [slide.autoAdvanceMs, slide.transition])).toEqual([
      [10_515, { style: "crossfade", durationMs: 1000 }],
      [11_297, { style: "random-bars-vertical", durationMs: 750 }],
    ]);
  });

  test("the pictures read back are the exact bytes in the file", () => {
    const file = write(hymn());
    const [base, logo] = deckOf(file).slides[0]!.layers;
    expect(readBinaryPictures(file, [base!, logo!])).toEqual([JPEG_A, LOGO_PNG]);
  });

  test("a hidden slide is left out, as the show leaves it out", () => {
    const deck = hymn();
    deck.slides![0]!.infoFlags = 0x0400 | 0x0004;
    expect(deckOf(write(deck)).slides).toHaveLength(1);
  });

  test("what an opaque cover hides does not matter — a placeholder under it, a picture bleeding past the edges", () => {
    const deck = deckOf(
      write(
        hymn({
          second: [
            { type: 1, rect: [173, 288, 5472, 893], text: "Título" },
            { rect: [0, 0, 5874, 4405], pib: 2 },
          ],
        }),
      ),
    );
    expect(deck.slides[1]!.layers).toMatchObject([{ x: 0, y: 0, width: 5874, height: 4405 }]);
  });

  test("something off the slide, or hidden, is not drawn", () => {
    const deck = deckOf(
      write(
        hymn({
          second: [
            { rect: FULL, pib: 2 },
            { rect: [255, 5800, 5992, 447], pib: 4, media: { hideWhileNotPlaying: false } },
            { type: 1, rect: [100, 100, 900, 900], text: "nota", props: { 0x03bf: 0x00020002 } },
          ],
        }),
      ),
    );
    expect(deck.slides[1]!.layers).toHaveLength(1);
  });

  test("a picture's line and fill can come from the master shape it inherits from, flag by flag", () => {
    // Says nothing about its line on its own (no fUsefLine); the master's
    // body placeholder says «no line» — 166 covers of the real hymnal.
    const deck = deckOf(
      write({
        ...hymn({ second: [{ rect: FULL, pib: 2, props: { 0x01ff: 0x00100010, 0x0301: 0x403 } }] }),
        masterShapes: [{ spid: 0x403, props: { 0x01bf: 0x00110001, 0x01ff: 0x00190011 } }],
      }),
    );
    expect(deck.slides[1]!.layers).toHaveLength(1);
  });
});

describe("anything we would draw wrong sends the whole deck to the model reader", () => {
  test("text over the picture", () => {
    expect(refusal(write(hymn({ second: [{ rect: FULL, pib: 2 }, { type: 1, rect: [100, 100, 900, 900], text: "Coro" }] })))).toMatch(
      /slide 2/,
    );
  });

  test("a slide no picture covers", () => {
    expect(refusal(write(hymn({ second: [{ rect: [0, 0, W, 4307], pib: 2 }] })))).toMatch(/not covered/);
  });

  test("a cropped, rotated or recolored cover", () => {
    for (const props of [{ 0x0100: 1000 }, { 0x0004: 90 << 16 }, { 0x0108: 0x8000 }]) {
      expect(refusal(write(hymn({ second: [{ rect: FULL, pib: 2, props }] })))).toMatch(/not covered/);
    }
  });

  test("a cover whose line is on, or not said anywhere", () => {
    expect(refusal(write(hymn({ second: [{ rect: FULL, pib: 2, props: { 0x01ff: 0x00080008 } }] })))).toMatch(/not covered/);
    expect(refusal(write(hymn({ second: [{ rect: FULL, pib: 2, props: { 0x01ff: 0x00100010 } }] })))).toMatch(/not covered/);
  });

  test("a PNG over the picture with its fill on — it would show through the transparent parts", () => {
    expect(
      refusal(write(hymn({ second: [{ rect: FULL, pib: 2 }, { rect: LOGO, pib: 3, props: { 0x01bf: 0x00100010 } }] }))),
    ).toMatch(/not a plain picture/);
  });

  test("a shape inside a group over the picture", () => {
    expect(refusal(write(hymn({ second: [{ rect: FULL, pib: 2 }, { rect: LOGO, pib: 3, flags: 0x0002 }] })))).toMatch(
      /not a plain picture/,
    );
  });

  test("a file that is not a deck at all is not a refusal, it is unreadable", () => {
    const file = path.join(dir, "not-a-deck.pps");
    fs.writeFileSync(file, Buffer.from("PK\x03\x04 not an OLE file"));
    expect(readBinaryDeck(file)).toBeNull();
  });
});

describe("served straight from the source", () => {
  test("a slide that is one picture edge to edge is that JPEG, byte for byte", () => {
    const file = write(hymn());
    const slide = deckOf(file).slides[1]!;
    const layers = encodeSlideLayers({ width: W, height: H, layers: slide.layers });
    expect(renderNativeSlide(file, layers, "full")).toEqual({ body: JPEG_B, contentType: "image/jpeg" });
  });

  test("a slide with the logo is an SVG placing each picture where PowerPoint does", () => {
    const file = write(hymn());
    const slide = deckOf(file).slides[0]!;
    const rendered = renderNativeSlide(file, encodeSlideLayers({ width: W, height: H, layers: slide.layers }), "full");
    expect(rendered?.contentType).toBe("image/svg+xml");
    const svg = rendered!.body.toString();
    expect(svg).toContain(`viewBox="0 0 ${W} ${H}"`);
    expect(svg).toContain(`width="800" height="600"`);
    expect(svg).toContain(`href="data:image/jpeg;base64,${JPEG_A.toString("base64")}"`);
    expect(svg).toContain(`x="${LOGO[1]}" y="${LOGO[0]}" width="${LOGO[2] - LOGO[1]}" height="${LOGO[3] - LOGO[0]}"`);
    expect(svg).toContain(`href="data:image/png;base64,${LOGO_PNG.toString("base64")}"`);
  });

  test("its thumbnail is the base picture alone", () => {
    const file = write(hymn());
    const slide = deckOf(file).slides[0]!;
    const layers = encodeSlideLayers({ width: W, height: H, layers: slide.layers });
    expect(renderNativeSlide(file, layers, "thumb")).toEqual({ body: JPEG_A, contentType: "image/jpeg" });
  });

  test("a picture that bleeds past the edges is composed, so the slide shows only its part", () => {
    const file = write(hymn({ second: [{ rect: [0, 0, 5874, 4405], pib: 2 }] }));
    const slide = deckOf(file).slides[1]!;
    const rendered = renderNativeSlide(file, encodeSlideLayers({ width: W, height: H, layers: slide.layers }), "full");
    expect(rendered?.contentType).toBe("image/svg+xml");
  });

  test("the size of a JPEG and of a PNG, from their headers", () => {
    expect(imagePixelSize(jpegHeader(800, 600), "jpeg")).toEqual({ width: 800, height: 600 });
    expect(imagePixelSize(pngHeader(59, 54), "png")).toEqual({ width: 59, height: 54 });
    expect(imagePixelSize(Buffer.from("nope"), "jpeg")).toBeNull();
  });
});

describe("the rest of what the source says", () => {
  test("the linked song's path is read from its record", () => {
    expect(readBinaryExternalPaths(write(hymn()))).toEqual([
      "C:\\Documents and Settings\\Joel Rivas\\Escritorio\\himnos\\522 Suenen las palabras.mp3",
    ]);
  });

  test("the timings reader carries the transitions too", () => {
    expect(readBinarySlideTimings(write(hymn()))?.map((slide) => slide.transition)).toEqual([
      { style: "crossfade", durationMs: 1000 },
      { style: "random-bars-vertical", durationMs: 750 },
    ]);
  });

  test("PowerPoint's transition codes", () => {
    expect(binaryTransition(0, 0, 2)).toBeNull();
    expect(binaryTransition(6, 0, 2)).toEqual({ style: "fade-through-black", durationMs: 500 });
    expect(binaryTransition(23, 0, 1)).toEqual({ style: "crossfade", durationMs: 750 });
    expect(binaryTransition(8, 0, 0)).toEqual({ style: "random-bars-horizontal", durationMs: 1000 });
    expect(binaryTransition(8, 1, 2)).toEqual({ style: "random-bars-vertical", durationMs: 500 });
    // Anything we do not draw is a crossfade of its own length.
    expect(binaryTransition(20, 0, 2)).toEqual({ style: "crossfade", durationMs: 500 });
  });
});
