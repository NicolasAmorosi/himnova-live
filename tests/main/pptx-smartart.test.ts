/**
 * SmartArt saved without its drawing (other tools, or the drawing stripped) is
 * laid out by the reader from the diagram's own parts, the way PowerPoint does
 * on open — never left out of the slide.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { GroupElement, ShapeElement, SlideElement } from "../../src/shared/types/slide-model";
import { parsePresetDefinitions } from "../../src/main/slides/pptx/geometry";
import { readPptxDeck, type PptxResources } from "../../src/main/slides/pptx/reader";
import { parseTableStyles } from "../../src/main/slides/pptx/table-style";

const NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DGM = 'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

let dir: string;
let resources: PptxResources;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-smartart-"));
  const ooxml = path.join(__dirname, "../../resources/ooxml");
  resources = {
    presets: parsePresetDefinitions(fs.readFileSync(path.join(ooxml, "presetShapeDefinitions.xml"), "utf8")),
    tableStyles: parseTableStyles(fs.readFileSync(path.join(ooxml, "tableStyles.xml"), "utf8")),
  };
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Three nodes, A B C, under the document point. */
const data = `<dgm:dataModel ${DGM}><dgm:ptLst><dgm:pt modelId="0" type="doc"/>
  ${["A", "B", "C"].map((t, i) => `<dgm:pt modelId="${i + 1}"><dgm:t><a:bodyPr/><a:p><a:r><a:t>${t}</a:t></a:r></a:p></dgm:t></dgm:pt>
  <dgm:pt modelId="s${i + 1}" type="sibTrans"/><dgm:pt modelId="p${i + 1}" type="parTrans"/>`).join("")}</dgm:ptLst><dgm:cxnLst>
  ${[1, 2, 3].map((i) => `<dgm:cxn modelId="c${i}" srcId="0" destId="${i}" srcOrd="${i - 1}" destOrd="0" parTransId="p${i}" sibTransId="s${i}"/>`).join("")}
</dgm:cxnLst></dgm:dataModel>`;

/** A basic process: nodes in a row that shrinks to fit, arrows between them. */
const process = `<dgm:layoutDef ${DGM}><dgm:layoutNode name="root"><dgm:alg type="lin"/>
  <dgm:constrLst><dgm:constr type="w" for="ch" forName="node" refType="w"/>
    <dgm:constr type="h" for="ch" forName="node" refType="w" refFor="ch" refForName="node" fact="0.6"/>
    <dgm:constr type="w" for="ch" forName="arrow" refType="w" refFor="ch" refForName="node" fact="0.4"/>
    <dgm:constr type="h" for="ch" forName="arrow" refType="h" refFor="ch" refForName="node" fact="0.5"/></dgm:constrLst>
  <dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="node"><dgm:alg type="tx"/><dgm:shape type="roundRect"/>
    <dgm:presOf axis="desOrSelf" ptType="node"/></dgm:layoutNode>
    <dgm:forEach axis="followSib" ptType="sibTrans" cnt="1"><dgm:layoutNode name="arrow"><dgm:alg type="conn"/><dgm:shape type="conn"/></dgm:layoutNode></dgm:forEach>
  </dgm:forEach></dgm:layoutNode></dgm:layoutDef>`;

const emptyDrawing = `<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram"><dsp:spTree><dsp:nvGrpSpPr/><dsp:grpSpPr/></dsp:spTree></dsp:drawing>`;

function writeDeck(name: string, parts: { layout?: string; drawing?: string }): string {
  const rels = [
    `<Relationship Id="rId2" Type="${REL}/diagramData" Target="../diagrams/data1.xml"/>`,
    parts.layout ? `<Relationship Id="rId3" Type="${REL}/diagramLayout" Target="../diagrams/layout1.xml"/>` : "",
    parts.drawing ? `<Relationship Id="rId6" Type="http://schemas.microsoft.com/office/2007/relationships/diagramDrawing" Target="../diagrams/drawing1.xml"/>` : "",
  ].join("");
  const frame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="Diagram"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
    <p:xfrm><a:off x="0" y="0"/><a:ext cx="9000000" cy="3000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">
    <dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rId2" r:lo="rId3" r:qs="rId4" r:cs="rId5"/></a:graphicData></a:graphic></p:graphicFrame>`;
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`),
      "ppt/slides/slide1.xml": strToU8(`<p:sld ${NS}><p:cSld><p:spTree>${frame}</p:spTree></p:cSld></p:sld>`),
      "ppt/slides/_rels/slide1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`),
      "ppt/diagrams/data1.xml": strToU8(data),
      ...(parts.layout ? { "ppt/diagrams/layout1.xml": strToU8(parts.layout) } : {}),
      ...(parts.drawing ? { "ppt/diagrams/drawing1.xml": strToU8(parts.drawing) } : {}),
    }),
  );
  return file;
}

const shapes = (el: SlideElement | undefined): ShapeElement[] => (el as GroupElement).children.filter((c): c is ShapeElement => c.kind === "shape");
const textOf = (s: ShapeElement): string => s.text?.paragraphs.flatMap((p) => p.runs.map((r) => (r.kind === "text" ? r.text : ""))).join("") ?? "";

test("a process without a drawing is laid out: three boxes in a row inside the frame, arrows between them", () => {
  const slide = readPptxDeck(writeDeck("process.pptx", { layout: process }), resources).slides[0]!;
  expect(slide.unsupported["smartart:no-drawing"]).toBe(1);
  const drawn = shapes(slide.model.elements[0]);
  const boxes = drawn.filter((s) => textOf(s) !== "");
  expect(boxes.map(textOf)).toEqual(["A", "B", "C"]);
  // Each node as wide as the diagram, shrunk together until the row fits.
  for (const [a, b] of [[boxes[0]!, boxes[1]!], [boxes[1]!, boxes[2]!]] as const) expect(b.frame.x).toBeGreaterThan(a.frame.x + a.frame.w);
  const right = boxes[2]!.frame.x + boxes[2]!.frame.w;
  expect(boxes[0]!.frame.x).toBeGreaterThanOrEqual(-1);
  expect(right).toBeLessThanOrEqual(9000001);
  expect(boxes[0]!.frame.h / boxes[0]!.frame.w).toBeCloseTo(0.6, 2);
  // The last node has no arrow after it.
  const arrows = drawn.filter((s) => textOf(s) === "");
  expect(arrows).toHaveLength(2);
  for (const a of arrows) expect(a.paths.length).toBeGreaterThan(0);
});

test("an empty drawing is laid out like a missing one", () => {
  const slide = readPptxDeck(writeDeck("empty-drawing.pptx", { layout: process, drawing: emptyDrawing }), resources).slides[0]!;
  expect(slide.unsupported["smartart:no-drawing"]).toBe(1);
  expect(shapes(slide.model.elements[0]).map(textOf).filter(Boolean)).toEqual(["A", "B", "C"]);
});

test("a diagram whose layout can't be read still draws its text, in boxes", () => {
  const slide = readPptxDeck(writeDeck("no-layout.pptx", {}), resources).slides[0]!;
  const boxes = shapes(slide.model.elements[0]);
  expect(boxes.map(textOf)).toEqual(["A", "B", "C"]);
  for (const b of boxes) expect(b.paths.length).toBeGreaterThan(0);
});

// 2026-11-15 audit, S4 (clamp half): the fit loop shrinks a point at a time from the layout's `primFontSz`, which had
// no ceiling: 1e7 took seconds, 1e20 never ended (`1e20 - 1 === 1e20`).
test("a font size past 400 pt starts the fit at 400, so laying it out takes milliseconds", () => {
  const sized = process.replace(
    "</dgm:constrLst>",
    '<dgm:constr type="primFontSz" for="ch" forName="node" op="equ" val="1e7"/></dgm:constrLst>',
  );
  const t0 = performance.now();
  const slide = readPptxDeck(writeDeck("huge-font.pptx", { layout: sized }), resources).slides[0]!;
  expect(performance.now() - t0).toBeLessThan(1000);
  const sizes = shapes(slide.model.elements[0]).flatMap((s) => s.text?.paragraphs.flatMap((p) => p.runs.map((r) => (r.kind === "text" ? r.size : 0))) ?? []);
  expect(sizes.length).toBeGreaterThan(0);
  for (const size of sizes) expect(size).toBeLessThanOrEqual(400);
});
