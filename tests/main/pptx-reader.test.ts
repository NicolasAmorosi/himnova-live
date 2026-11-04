/**
 * What the `.pptx` reader leaves out of a slide on purpose — a sound or video
 * set to «Hide during show» —, what it does with a part that won't parse — the
 * slide is drawn without it and marked `damaged`, never blank in silence —
 * and what it carries for the painter: tab stops, a fill overlay.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parsePresetDefinitions } from "../../src/main/slides/pptx/geometry";
import { readPptxDeck, type PptxResources } from "../../src/main/slides/pptx/reader";
import { parseTableStyles } from "../../src/main/slides/pptx/table-style";
import { SYMBOL_BULLETS } from "../../src/main/slides/pptx/text";

const NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

let dir: string;
let resources: PptxResources;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-reader-"));
  const ooxml = path.join(__dirname, "../../resources/ooxml");
  resources = {
    presets: parsePresetDefinitions(fs.readFileSync(path.join(ooxml, "presetShapeDefinitions.xml"), "utf8")),
    tableStyles: parseTableStyles(fs.readFileSync(path.join(ooxml, "tableStyles.xml"), "utf8")),
  };
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A sound's speaker icon (`p:pic` id 4), and the timing that plays it. */
const speaker = `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Audio 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
  <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
  <p:spPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="500000" cy="500000"/></a:xfrm></p:spPr></p:pic>`;
const timing = (showWhenStopped: string) =>
  `<p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst><p:audio><p:cMediaNode vol="80000"${showWhenStopped}>
  <p:cTn id="2"/><p:tgtEl><p:spTgt spid="4"/></p:tgtEl></p:cMediaNode></p:audio></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;

/** A one-slide deck; `parts` adds or replaces package parts (a layout, a
 *  master, the slide's relationships). */
function writeDeck(name: string, slideXml: string, parts: Record<string, string> = {}): string {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    zipSync({
      "ppt/presentation.xml": strToU8(
        `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
      ),
      "ppt/_rels/presentation.xml.rels": strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`,
      ),
      "ppt/slides/slide1.xml": strToU8(slideXml),
      "ppt/slides/_rels/slide1.xml.rels": strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/image" Target="../media/image1.png"/></Relationships>`,
      ),
      "ppt/media/image1.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      ...Object.fromEntries(Object.entries(parts).map(([part, xml]) => [part, strToU8(xml)])),
    }),
  );
  return file;
}

const slide = (extra: string) => `<p:sld ${NS}><p:cSld><p:spTree>${speaker}</p:spTree></p:cSld>${extra}</p:sld>`;

test("a sound set to «Hide during show» leaves no speaker icon on the slide", () => {
  const deck = readPptxDeck(writeDeck("hidden.pptx", slide(timing(' showWhenStopped="0"'))), resources);
  expect(deck.slides[0]!.model.elements).toEqual([]);
});

test("a sound shown during the show keeps its icon", () => {
  for (const [name, xml] of [
    ["shown.pptx", slide(timing(' showWhenStopped="1"'))],
    ["default.pptx", slide(timing(""))],
    ["untimed.pptx", slide("")],
  ] as const) {
    const deck = readPptxDeck(writeDeck(name, xml), resources);
    expect(deck.slides[0]!.model.elements.map((e) => e.kind), name).toEqual(["picture"]);
  }
});

/** One rectangle with a line of text, `pPr` and extra `spPr` children as given. */
const textBox = (pPr: string, spPr = "") =>
  `<p:sld ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${spPr}</p:spPr>
  <p:txBody><a:bodyPr/><a:lstStyle/><a:p>${pPr}<a:r><a:t>1\tVerse</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

test("a paragraph carries its tab stops in order, its default tab size, and the tab itself", () => {
  const pPr = '<a:pPr defTabSz="457200"><a:tabLst><a:tab pos="901700" algn="r"/><a:tab pos="542925" algn="l"/></a:tabLst></a:pPr>';
  const el = readPptxDeck(writeDeck("tabs.pptx", textBox(pPr)), resources).slides[0]!.model.elements[0]!;
  const p = el.kind === "shape" ? el.text!.paragraphs[0]! : null;
  expect(p?.tabs).toEqual([
    { pos: 542925, align: "l" },
    { pos: 901700, align: "r" },
  ]);
  expect(p?.defaultTab).toBe(457200);
  expect(p?.runs[0]).toMatchObject({ kind: "text", text: "1\tVerse" });
  // With none named, PowerPoint's inch.
  const plain = readPptxDeck(writeDeck("no-tabs.pptx", textBox("")), resources).slides[0]!.model.elements[0]!;
  expect(plain.kind === "shape" ? plain.text!.paragraphs[0] : null).toMatchObject({ tabs: [], defaultTab: 914400 });
});

test("a fill overlay is read with its blend, and an unknown blend paints over", () => {
  const spPr = (blend: string) =>
    `<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:effectLst><a:fillOverlay blend="${blend}"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:fillOverlay></a:effectLst>`;
  for (const [blend, expected] of [
    ["mult", "mult"],
    ["screen", "screen"],
    ["burn", "over"],
  ] as const) {
    const el = readPptxDeck(writeDeck(`overlay-${blend}.pptx`, textBox("", spPr(blend))), resources).slides[0]!.model.elements[0]!;
    expect(el.kind === "shape" ? el.effects.overlay : null, blend).toEqual({ fill: { kind: "solid", color: "rgb(0,255,0)" }, blend: expected });
  }
});

/** A part cut short mid-tag, as a damaged download leaves it. (The parser
 *  shrugs off most other garbage: crossed or missing closing tags parse.) */
const truncated = (xml: string) => xml.slice(0, xml.lastIndexOf("<p:") + 4);

const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
/** A slide on a layout on a master: the layout paints the background, the
 *  master a rectangle (id 7) every slide shows. */
const inherited = (overrides: Record<string, string>) => ({
  "ppt/slides/_rels/slide1.xml.rels": `<Relationships xmlns="${RELS}"><Relationship Id="rId2" Type="${REL}/image" Target="../media/image1.png"/><Relationship Id="rId9" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
  "ppt/slideLayouts/slideLayout1.xml": `<p:sldLayout ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sldLayout>`,
  "ppt/slideLayouts/_rels/slideLayout1.xml.rels": `<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
  "ppt/slideMasters/slideMaster1.xml": `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="445566"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="7" name="Band"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr></p:sp></p:spTree></p:cSld></p:sldMaster>`,
  ...overrides,
});

test("a slide whose own part won't parse is drawn from its layout and master, and marked damaged", () => {
  const file = writeDeck("broken-slide.pptx", truncated(slide("")), inherited({}));
  const { model } = readPptxDeck(file, resources).slides[0]!;
  expect(model.damaged).toBe(true);
  expect(model.background).toEqual({ kind: "solid", color: "rgb(17,34,51)" });
  // The master's band, and nothing of the slide's own.
  expect(model.elements.map((e) => e.kind)).toEqual(["shape"]);
});

test("a layout or a master that won't parse is left out, the slide still drawn, and marked damaged", () => {
  const layoutPart = "ppt/slideLayouts/slideLayout1.xml";
  const brokenLayout = readPptxDeck(
    writeDeck("broken-layout.pptx", slide(""), inherited({ [layoutPart]: truncated(inherited({})[layoutPart]) })),
    resources,
  ).slides[0]!.model;
  expect(brokenLayout.damaged).toBe(true);
  // The master still reached through the layout's relationships: its
  // background and its band, then the slide's own picture.
  expect(brokenLayout.background).toEqual({ kind: "solid", color: "rgb(68,85,102)" });
  expect(brokenLayout.elements.map((e) => e.kind)).toEqual(["shape", "picture"]);

  const masterPart = "ppt/slideMasters/slideMaster1.xml";
  const brokenMaster = readPptxDeck(
    writeDeck("broken-master.pptx", slide(""), inherited({ [masterPart]: truncated(inherited({})[masterPart]) })),
    resources,
  ).slides[0]!.model;
  expect(brokenMaster.damaged).toBe(true);
  expect(brokenMaster.background).toEqual({ kind: "solid", color: "rgb(17,34,51)" });
  expect(brokenMaster.elements.map((e) => e.kind)).toEqual(["picture"]);
});

test("a whole slide carries no damaged mark at all", () => {
  const { model } = readPptxDeck(writeDeck("whole.pptx", slide(""), inherited({})), resources).slides[0]!;
  expect(model).not.toHaveProperty("damaged");
  expect(model.elements.map((e) => e.kind)).toEqual(["shape", "picture"]);
});

test("a Wingdings bullet maps the same from its byte and from the private-use page", () => {
  expect(SYMBOL_BULLETS["§"]).toBe("▪");
  expect(SYMBOL_BULLETS["\uf0a7"]).toBe("▪");
  expect(SYMBOL_BULLETS["\uf0d8"]).toBe("➢");
  expect(SYMBOL_BULLETS[""]).toBeUndefined();
});
