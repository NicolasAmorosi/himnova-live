/**
 * A legacy `.ppt` read into a `SlideModel` with no LibreOffice (owner,
 * 2026-11-03): text and its runs over the master's styles, placeholders whose
 * text lives in the slide list, the colour scheme, master objects and
 * backgrounds, built-in geometry, fields, and a damaged slide that costs only
 * itself. Decks are built on the fly (`tests/fixtures/legacy-ppt.ts`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ShapeElement, SlideElement, SlideModel } from "../../src/shared/types/slide-model";
import { color, parseMsoShapes, shapeGeometry, emptyProps, P } from "../../src/main/slides/ppt/escher";
import { readPptModelDeck } from "../../src/main/slides/ppt/model-reader";
import { decodePart, encodePart, readBinaryPart } from "../../src/main/slides/ppt/parts";
import { textBody, type TextData } from "../../src/main/slides/ppt/text";
import { buildLegacyPpt, jpegHeader, rec, u32s, type LegacyDeck } from "../fixtures/legacy-ppt";

const msoShapes = parseMsoShapes(fs.readFileSync(path.join(__dirname, "../../resources/ooxml/mso-shapes.json"), "utf8"));
let dir = "";
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-model-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
function read(deck: LegacyDeck): ReturnType<typeof readPptModelDeck> {
  const file = path.join(dir, `deck-${++n}.ppt`);
  fs.writeFileSync(file, buildLegacyPpt(deck));
  return readPptModelDeck(file, { msoShapes });
}

// -- record builders ------------------------------------------------------------

const header = (type: number): Buffer => rec(0x0, 0, 0x0f9f, u32s(type));
const chars = (text: string): Buffer => rec(0x0, 0, 0x0fa0, Buffer.from(text, "utf16le"));
const u16 = (...v: number[]): Buffer => {
  const b = Buffer.alloc(v.length * 2);
  v.forEach((x, i) => b.writeUInt16LE(x & 0xffff, i * 2));
  return b;
};
/** One paragraph run and one character run over the whole text. */
function style(length: number, pf: { align?: number }, cf: { bold?: boolean; font?: number; size?: number; rgb?: [number, number, number] }): Buffer {
  let pmask = 0;
  const pbody: Buffer[] = [];
  if (pf.align !== undefined) {
    pmask |= 0x800;
    pbody.push(u16(pf.align));
  }
  let cmask = 0;
  const cbody: Buffer[] = [];
  if (cf.bold !== undefined) {
    cmask |= 0x1;
    cbody.push(u16(cf.bold ? 1 : 0));
  }
  if (cf.font !== undefined) {
    cmask |= 0x10000;
    cbody.push(u16(cf.font));
  }
  if (cf.size !== undefined) {
    cmask |= 0x20000;
    cbody.push(u16(cf.size));
  }
  if (cf.rgb) {
    cmask |= 0x40000;
    cbody.push(Buffer.from([...cf.rgb, 0xfe]));
  }
  return rec(0x0, 0, 0x0fa1, [u32s(length + 1), u16(0), u32s(pmask), ...pbody, u32s(length + 1), u32s(cmask), ...cbody]);
}
function fontCollection(names: string[]): Buffer {
  return rec(0xf, 0, 0x07d5, names.map((name, i) => {
    const body = Buffer.alloc(68);
    body.write(name, 0, "utf16le");
    return rec(0x0, i, 0x0fb7, body);
  }));
}
/** A master text style whose first level sets only the size. */
const masterStyle = (type: number, size: number): Buffer => rec(0x0, type, 0x0fa3, [u16(1), u32s(0), u32s(0x20000), u16(size)]);
function scheme(colors: [number, number, number][]): Buffer {
  return rec(0x0, 1, 0x07f0, Buffer.concat(colors.map(([r, g, b]) => Buffer.from([r, g, b, 0]))));
}
const placeholderAtom = (placement: number): Buffer => {
  const body = Buffer.alloc(8);
  body.writeUInt8(placement, 4);
  return rec(0x0, 0, 0x0bc3, body);
};

const SCHEME: [number, number, number][] = [[250, 250, 250], [10, 20, 30], [128, 128, 128], [40, 50, 60], [200, 100, 0], [1, 2, 3], [4, 5, 6], [7, 8, 9]];

const textShapes = (model: SlideModel): ShapeElement[] =>
  model.elements.filter((e: SlideElement): e is ShapeElement => e.kind === "shape" && e.text !== null);
const runText = (s: ShapeElement): string =>
  s.text!.paragraphs.map((p) => p.runs.map((r) => (r.kind === "text" ? r.text : "\n")).join("")).join("¶");

describe("text", () => {
  test("a text box: paragraphs, alignment and character runs over the document's fonts", () => {
    const text = "Hola\rMundo";
    const { deck } = read({
      environment: [fontCollection(["Arial", "Times New Roman"])],
      slides: [{ shapes: [{ type: 202, rect: [100, 100, 2000, 800], textRecords: [header(4), chars(text), style(text.length, { align: 1 }, { bold: true, font: 1, size: 40, rgb: [255, 0, 0] })] }] }],
    });
    const [box] = textShapes(deck.slides[0]!.model);
    expect(runText(box!)).toBe("Hola¶Mundo");
    const p = box!.text!.paragraphs[0]!;
    expect(p.align).toBe("ctr");
    const run = p.runs[0]!;
    expect(run.kind === "text" && run.size).toBe(40);
    expect(run.kind === "text" && run.bold).toBe(true);
    expect(run.kind === "text" && run.font.startsWith('"Times New Roman"')).toBe(true);
    expect(run.kind === "text" && run.fill).toEqual({ kind: "solid", color: "rgb(255,0,0)" });
    // A text box draws neither fill nor line unless it says so.
    expect(box!.fill).toBeNull();
    expect(box!.line).toBeNull();
    // Anchor (top, left, right, bottom) → frame, master units to EMU.
    expect(box!.frame).toMatchObject({ x: Math.round(100 * 1587.5), y: Math.round(100 * 1587.5), w: Math.round(1900 * 1587.5), h: Math.round(700 * 1587.5) });
  });

  test("a placeholder's text comes from the slide list, styled by the master's title style and scheme", () => {
    const { deck, meta } = read({
      environment: [fontCollection(["Arial"])],
      masterRecords: [masterStyle(0, 54), scheme(SCHEME)],
      slides: [
        {
          slideFlags: 0x7,
          listTexts: [header(0), chars("El título")],
          shapes: [{ type: 1, rect: [0, 0, 5760, 1000], clientData: [placeholderAtom(13)], textRecords: [rec(0x0, 0, 0x0f9e, u32s(0))] }],
        },
      ],
    });
    const [title] = textShapes(deck.slides[0]!.model);
    expect(runText(title!)).toBe("El título");
    const run = title!.text!.paragraphs[0]!.runs[0]!;
    expect(run.kind === "text" && run.size).toBe(54);
    // Title text defaults to the scheme's title colour (index 3).
    expect(run.kind === "text" && run.fill).toEqual({ kind: "solid", color: "rgb(40,50,60)" });
    expect(meta.slides[0]!.title).toBe("El título");
  });

  test("a slide number field on the master is filled in per slide, only when shown", () => {
    const number = (shown: boolean): string[] => {
      const flags = Buffer.alloc(4);
      flags.writeUInt16LE(shown ? 0x8 : 0, 2);
      const { deck } = read({
        documentRecords: [rec(0xf, 3, 0x0fd9, rec(0x0, 0, 0x0fda, flags))],
        masterDrawing: [{ type: 1, rect: [4000, 4800, 5700, 4300], clientData: [placeholderAtom(8)], textRecords: [header(4), chars("*"), rec(0x0, 0, 0x0fd8, u32s(0))] }],
        slides: [{ slideFlags: 0x7 }, { slideFlags: 0x7 }],
      });
      return deck.slides.flatMap((s) => textShapes(s.model).map(runText));
    };
    expect(number(true)).toEqual(["1", "2"]);
    expect(number(false)).toEqual([]);
  });
});

describe("drawing", () => {
  test("scheme colours, master objects and the master's background", () => {
    const { deck } = read({
      masterRecords: [scheme(SCHEME)],
      masterDrawing: [
        { type: 1, rect: [0, 0, 5760, 4320], flags: 0x400, props: { 0x0181: 0x08000000, 0x01bf: 0x00100010 } }, // background: scheme 0
        { type: 1, rect: [10, 10, 200, 200], props: { 0x0181: 0x08000004, 0x01bf: 0x00100010, 0x01ff: 0x00080000 } }, // a master logo
      ],
      slides: [
        { slideFlags: 0x7, shapes: [{ type: 3, rect: [1000, 1000, 3000, 2000], props: { 0x0181: 0x08000005 } }] },
        { slideFlags: 0x6, shapes: [] }, // fMasterObjects off
      ],
    });
    const [withMaster, without] = deck.slides.map((s) => s.model);
    expect(withMaster!.background).toEqual({ kind: "solid", color: "rgb(250,250,250)" });
    const [logo, ellipse] = withMaster!.elements as ShapeElement[];
    expect(logo!.fill).toEqual({ kind: "solid", color: "rgb(200,100,0)" });
    expect(logo!.line).toBeNull(); // fLine off
    expect(ellipse!.fill).toEqual({ kind: "solid", color: "rgb(1,2,3)" });
    expect(ellipse!.paths[0]!.d).toMatch(/A/); // drawn with arcs, not a rectangle
    expect(without!.elements).toHaveLength(0);
  });

  test("a picture frame names its BLIP by part, served from the Pictures stream", () => {
    const jpeg = jpegHeader(800, 600);
    const file = path.join(dir, "picture.ppt");
    fs.writeFileSync(file, buildLegacyPpt({ pictures: [{ type: "jpeg", bytes: jpeg }], slides: [{ shapes: [{ rect: [0, 0, 5760, 4320], pib: 1 }] }] }));
    const { deck } = readPptModelDeck(file, { msoShapes });
    const picture = deck.slides[0]!.model.elements[0]!;
    expect(picture.kind).toBe("picture");
    const part = picture.kind === "picture" ? picture.image.part : "";
    expect(decodePart(part)).toMatchObject({ stream: "p", codec: "raw", ext: "jpg" });
    expect(Buffer.from(readBinaryPart(file, part)!)).toEqual(jpeg);
  });

  test("a hidden slide and the slide's timing reach the metadata", () => {
    const { deck, meta } = read({ slides: [{ slideTimeMs: 5000, infoFlags: 0x0400 }, { infoFlags: 0x0005 }] });
    expect(deck.slides.map((s) => s.hidden)).toEqual([false, true]);
    expect(meta.slides[0]).toMatchObject({ autoAdvanceMs: 5000, hidden: false });
    expect(meta.slides[1]).toMatchObject({ hidden: true });
  });

  test("a damaged slide costs only itself", () => {
    const { deck } = read({ slides: [{ shapes: [] }, { garbage: true }, { shapes: [] }] });
    expect(deck.slides).toHaveLength(3);
    expect(deck.slides[1]!.model.damaged).toBe(true);
    expect(deck.slides[0]!.model.damaged).toBeUndefined();
  });

  test("not a PowerPoint binary at all throws", () => {
    const file = path.join(dir, "not.ppt");
    fs.writeFileSync(file, "plain text");
    expect(() => readPptModelDeck(file, { msoShapes })).toThrow();
  });
});

describe("escher", () => {
  test("colours: RGB, scheme index, and a system colour that darkens the fill", () => {
    const scheme = SCHEME.map(([r, g, b]) => ({ r, g, b }));
    expect(color(0x00336699, scheme, null)).toEqual({ r: 0x99, g: 0x66, b: 0x33 });
    expect(color(0x08000004, scheme, null)).toEqual({ r: 200, g: 100, b: 0 });
    const props = emptyProps();
    props.simple.set(P.fillColor, 0x000000c8); // red 200
    // fSysIndex, «fill colour», darken by 0x80.
    expect(color(0x108001f0, scheme, props)).toEqual({ r: 100, g: 0, b: 0 });
  });

  test("a freeform's own vertices and segments", () => {
    const props = emptyProps();
    const verts = Buffer.alloc(6 + 3 * 8);
    verts.writeUInt16LE(3, 0);
    verts.writeUInt16LE(3, 2);
    verts.writeUInt16LE(8, 4);
    [[0, 0], [21600, 0], [0, 21600]].forEach(([x, y], i) => {
      verts.writeInt32LE(x!, 6 + i * 8);
      verts.writeInt32LE(y!, 10 + i * 8);
    });
    const segs = Buffer.alloc(6 + 4 * 2);
    segs.writeUInt16LE(4, 0);
    segs.writeUInt16LE(4, 2);
    segs.writeUInt16LE(2, 4);
    [0x4000, 0x0002, 0x6001, 0x8000].forEach((s, i) => segs.writeUInt16LE(s, 6 + i * 2));
    props.complex.set(P.vertices, verts);
    props.complex.set(P.segments, segs);
    const geometry = shapeGeometry(0, props, 1000, 500, msoShapes);
    expect(geometry!.paths).toEqual([{ d: "M0 0 L1000 0 L0 500 Z", fill: "norm", stroke: true }]);
  });

  test("every built-in shape evaluates to finite paths", () => {
    for (const [type] of msoShapes.shapes) {
      const geometry = shapeGeometry(type, emptyProps(), 914400, 685800, msoShapes);
      expect(geometry, `type ${type}`).not.toBeNull();
      for (const p of geometry!.paths) expect(p.d, `type ${type}`).not.toMatch(/NaN|Infinity/);
    }
  });

  test("parts round-trip", () => {
    const part = encodePart({ stream: "d", offset: 123, length: 45, codec: "z", ext: "emf" });
    expect(decodePart(part)).toEqual({ stream: "d", offset: 123, length: 45, codec: "z", ext: "emf" });
    expect(decodePart("ppt/media/image1.png")).toBeNull();
  });
});

describe("autonumbered bullets", () => {
  test("the PowerPoint 2000 extension's scheme and start number count the paragraphs", () => {
    const data: TextData = {
      type: 1,
      text: "uno\rdos\rtres",
      paragraphs: [{ count: 13, level: 0, pf: { bulletFlags: 1, bulletFlagsMask: 1 } }],
      chars: [{ count: 13, cf: {} }],
      ruler: null,
      fields: new Map(),
      // Roman lowercase with a period (scheme 6), starting at 2.
      ext9: [{ mask: 0x03000000, hasNumber: 1, scheme: (2 << 16) | 6 }],
    };
    const scheme = SCHEME.map(([r, g, b]) => ({ r, g, b }));
    const body = textBody(data, emptyProps(), { sheets: new Map(), fonts: [], scheme, slideNumber: 1, footer: null, date: null, miss: () => {} });
    expect(body.paragraphs.map((p) => (p.bullet?.kind === "char" ? p.bullet.char : null))).toEqual(["ii.", "iii.", "iv."]);
  });
});
