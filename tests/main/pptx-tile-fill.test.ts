/**
 * A tiled picture fill needs the picture's natural size, and a template's tiled background is on every slide: the
 * picture is read once per deck, not once per slide (2026-11-15 audit, R19: 4 MB x 300 slides, 6 s against 22 ms).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parsePresetDefinitions } from "../../src/main/slides/pptx/geometry";
import { readPptxDeck } from "../../src/main/slides/pptx/reader";
import { parseTableStyles } from "../../src/main/slides/pptx/table-style";
import * as zipReader from "../../src/main/slides/zip-reader";
import { pngHeader } from "../fixtures/legacy-ppt";

vi.mock("../../src/main/slides/zip-reader", async (original) => {
  const actual = await original<typeof import("../../src/main/slides/zip-reader")>();
  return { ...actual, readZipEntries: vi.fn(actual.readZipEntries) };
});

const NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const SLIDES = 5;
const IMAGE = "ppt/media/image1.png";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-tile-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a tiled background on every slide reads its picture once", () => {
  const parts: Record<string, Uint8Array> = {
    "ppt/presentation.xml": strToU8(
      `<p:presentation ${NS}><p:sldIdLst>${Array.from({ length: SLIDES }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      `<Relationships ${RELS}>${Array.from({ length: SLIDES }, (_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
    ),
    [IMAGE]: new Uint8Array(pngHeader(40, 20)),
  };
  for (let i = 1; i <= SLIDES; i++) {
    parts[`ppt/slides/slide${i}.xml`] = strToU8(
      `<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId2"/><a:tile sx="100000" sy="100000"/></a:blipFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sld>`,
    );
    parts[`ppt/slides/_rels/slide${i}.xml.rels`] = strToU8(
      `<Relationships ${RELS}><Relationship Id="rId2" Type="${REL}/image" Target="../media/image1.png"/></Relationships>`,
    );
  }
  const file = path.join(dir, "tiled.pptx");
  fs.writeFileSync(file, zipSync(parts));

  const ooxml = path.join(__dirname, "../../resources/ooxml");
  const deck = readPptxDeck(file, {
    presets: parsePresetDefinitions(fs.readFileSync(path.join(ooxml, "presetShapeDefinitions.xml"), "utf8")),
    tableStyles: parseTableStyles(fs.readFileSync(path.join(ooxml, "tableStyles.xml"), "utf8")),
  });

  expect(deck.slides).toHaveLength(SLIDES);
  for (const slide of deck.slides) {
    expect(slide.model.background).toMatchObject({ kind: "image", mode: "tile", tile: { size: { w: 40 * 12700, h: 20 * 12700 } } });
  }
  const imageReads = vi.mocked(zipReader.readZipEntries).mock.calls.filter(([, wanted]) => wanted(IMAGE) && !wanted("ppt/presentation.xml"));
  expect(imageReads).toHaveLength(1);
});
