/**
 * Chart parts the `.pptx` reader used to refuse — bubbles, radars, 3-D plots,
 * a second value scale — read into a `ChartModel` instead, and what a part
 * leaves unsaid read the way PowerPoint reads it: per the schema unless
 * PowerPoint 2007 (and only Microsoft's) wrote the file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { ChartModel } from "../../src/shared/types/slide-chart";
import { parsePresetDefinitions } from "../../src/main/slides/pptx/geometry";
import { readPptxDeck, type PptxResources } from "../../src/main/slides/pptx/reader";
import { parseTableStyles } from "../../src/main/slides/pptx/table-style";

const NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

let dir: string;
let resources: PptxResources;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-chart-"));
  const ooxml = path.join(__dirname, "../../resources/ooxml");
  resources = {
    presets: parsePresetDefinitions(fs.readFileSync(path.join(ooxml, "presetShapeDefinitions.xml"), "utf8")),
    tableStyles: parseTableStyles(fs.readFileSync(path.join(ooxml, "tableStyles.xml"), "utf8")),
  };
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const num = (values: number[]): string =>
  `<c:numRef><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values
    .map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)
    .join("")}</c:numCache></c:numRef>`;
const ser = (i: number, inner: string): string => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${inner}</c:ser>`;
const axes = (cat: number, val: number, extra = ""): string =>
  `<c:catAx><c:axId val="${cat}"/><c:scaling/><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="${val}"/></c:catAx>` +
  `<c:valAx><c:axId val="${val}"/><c:scaling/><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="${cat}"/>${extra}</c:valAx>`;
const space = (chart: string): string => `<c:chartSpace ${C}><c:chart>${chart}</c:chart></c:chartSpace>`;

/** A deck of one slide holding each chart part in its own frame; `app` is docProps/app.xml's body. */
function readCharts(name: string, parts: string[], app = ""): ChartModel[] {
  const frames = parts
    .map(
      (_, i) =>
        `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${i + 2}" name="Chart ${i}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
        `<p:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="3000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
        `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${i + 1}"/></a:graphicData></a:graphic></p:graphicFrame>`,
    )
    .join("");
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
      "ppt/slides/slide1.xml": strToU8(`<p:sld ${NS}><p:cSld><p:spTree>${frames}</p:spTree></p:cSld></p:sld>`),
      "ppt/slides/_rels/slide1.xml.rels": strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts
          .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/chart" Target="../charts/chart${i + 1}.xml"/>`)
          .join("")}</Relationships>`,
      ),
      ...Object.fromEntries(parts.map((p, i) => [`ppt/charts/chart${i + 1}.xml`, strToU8(p)])),
      ...(app ? { "docProps/app.xml": strToU8(`<Properties>${app}</Properties>`) } : {}),
    }),
  );
  const slide = readPptxDeck(file, resources).slides[0]!;
  expect(slide.unsupported.chart, "no chart refused").toBeUndefined();
  return slide.model.elements.map((e) => (e.kind === "chart" ? e.chart : { kind: "unsupported", type: e.kind }));
}

const drawn = (c: ChartModel | undefined): Extract<ChartModel, { kind: "chart" }> => {
  if (!c || c.kind !== "chart") throw new Error(`not drawn: ${JSON.stringify(c)}`);
  return c;
};

const bubble = space(
  `<c:plotArea><c:bubbleChart>${ser(0, `<c:xVal>${num([1, 2])}</c:xVal><c:yVal>${num([3, 4])}</c:yVal><c:bubbleSize>${num([10, -5])}</c:bubbleSize><c:bubble3D val="1"/>`)}` +
    `<c:bubbleScale val="70"/><c:sizeRepresents val="w"/><c:axId val="1"/><c:axId val="2"/></c:bubbleChart>` +
    `<c:valAx><c:axId val="1"/><c:scaling/><c:axPos val="b"/><c:crossAx val="2"/></c:valAx><c:valAx><c:axId val="2"/><c:scaling/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea>`,
);
const radar = space(`<c:plotArea><c:radarChart><c:radarStyle val="filled"/>${ser(0, `<c:val>${num([1, 2, 3])}</c:val>`)}<c:axId val="1"/><c:axId val="2"/></c:radarChart>${axes(1, 2)}</c:plotArea>`);
const bar3D = (view: string, labels = ""): string =>
  space(
    `${view}<c:plotArea><c:bar3DChart><c:barDir val="col"/><c:grouping val="standard"/>${ser(0, `<c:val>${num([1, 2])}</c:val>`)}${labels}` +
      `<c:shape val="pyramid"/><c:axId val="1"/><c:axId val="2"/><c:axId val="3"/></c:bar3DChart>${axes(1, 2)}</c:plotArea>`,
  );

test("bubbles, radars and 3-D plots are read, not refused", () => {
  const [b, r, s] = readCharts("kinds.pptx", [
    bubble,
    radar,
    space(`<c:view3D/><c:plotArea><c:surface3DChart><c:wireframe val="0"/>${ser(0, `<c:val>${num([1, 2])}</c:val>`)}${ser(1, `<c:val>${num([2, 3])}</c:val>`)}<c:axId val="1"/><c:axId val="2"/><c:axId val="3"/></c:surface3DChart>${axes(1, 2)}</c:plotArea>`),
  ]);
  const bp = drawn(b).plots[0];
  expect(bp).toMatchObject({ kind: "bubble", scale: 70, byWidth: true });
  expect(bp?.series[0]).toMatchObject({ sizes: { values: [10, -5] }, xValues: { values: [1, 2] }, bubble3D: true });
  expect(drawn(r).plots[0]).toMatchObject({ kind: "radar", filled: true });
  const sp = drawn(s).plots[0];
  expect(sp?.kind).toBe("surface");
  expect(sp?.kind === "surface" && sp.bands.length).toBeGreaterThanOrEqual(12);
  expect(drawn(s).view3D).not.toBeNull();
});

test("a 3-D view and data labels left unsaid read as PowerPoint 2007's only in its own files", () => {
  const view = `<c:view3D><c:perspective val="30"/></c:view3D>`;
  const labels = `<c:dLbls/>`;
  // Större's template: AppVersion 12 with no application — read as a later file.
  const [later] = readCharts("later.pptx", [bar3D(view, labels)], "<AppVersion>12.0000</AppVersion>");
  expect(drawn(later).view3D).toMatchObject({ rotX: 0, rotY: 0, rightAngles: true, fov: 15, shape: "pyramid" });
  expect(drawn(later).plots[0]?.series[0]?.labels[0]).toMatchObject({ value: true, category: true, series: true, legendKey: true });
  const [old] = readCharts("2007.pptx", [bar3D(view, labels)], "<Application>Microsoft Office PowerPoint</Application><AppVersion>12.0000</AppVersion>");
  expect(drawn(old).view3D).toMatchObject({ rotX: 15, rotY: 20, rightAngles: false });
  expect(drawn(old).plots[0]?.series[0]?.labels[0]).toBeNull();
});

test("a combo's plot on other axes goes on the second value scale", () => {
  const [c] = readCharts("combo.pptx", [
    space(
      `<c:plotArea><c:barChart><c:barDir val="col"/>${ser(0, `<c:val>${num([1, 2])}</c:val>`)}<c:axId val="1"/><c:axId val="2"/></c:barChart>` +
        `<c:lineChart>${ser(1, `<c:val>${num([1000, 2000])}</c:val>`)}<c:axId val="3"/><c:axId val="4"/></c:lineChart>` +
        `${axes(1, 2)}${axes(3, 4, '<c:crosses val="max"/>')}</c:plotArea>`,
    ),
  ]);
  const chart = drawn(c);
  expect(chart.secondary?.plots).toEqual([1]);
  expect(chart.secondary?.axis.crosses).toBe("max");
  expect(chart.valueAxis?.crosses).toBe("autoZero");
});

// 2026-11-15 audit, S5 (parser half): `ptCount` sized the values with no cap, while `idx` had one; two million
// declared around one point were 365 MB of model. Two hundred thousand tell the same, lighter.
test("a series declaring more points than Excel allows is cut at Excel's 32 000", () => {
  const huge = `<c:numRef><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="200000"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef>`;
  const [c] = readCharts("ptcount.pptx", [
    space(`<c:plotArea><c:barChart><c:barDir val="col"/>${ser(0, `<c:val>${huge}</c:val>`)}<c:axId val="1"/><c:axId val="2"/></c:barChart>${axes(1, 2)}</c:plotArea>`),
  ]);
  expect(drawn(c).plots[0]?.series[0]?.values.values.length).toBe(32000);
});
