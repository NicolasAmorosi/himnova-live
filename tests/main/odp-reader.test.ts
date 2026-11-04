/**
 * The `.odp` reader against OpenDocument presentations written on the fly:
 * what it draws (page size, master inheritance, text, custom geometry,
 * pictures, groups), what it reads for the show (timings, transitions, a page
 * sound, a clip), and what it does with a damaged file — throw a clear error
 * when the file can't be a presentation, cost one shape when a shape is broken.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { GroupElement, PictureElement, ShapeElement, SlideElement } from "../../src/shared/types/slide-model";
import { readOdpMeta } from "../../src/main/slides/odp/meta";
import { readOdpDeck } from "../../src/main/slides/odp/reader";
import { parsePresetDefinitions } from "../../src/main/slides/pptx/geometry";
import type { PptxResources } from "../../src/main/slides/pptx/reader";
import { parseTableStyles } from "../../src/main/slides/pptx/table-style";

const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"',
  'xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0"',
  'xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
].join(" ");

/** A master with a solid background, a logo rectangle and a title placeholder. */
const STYLES = `<office:document-styles ${NS}>
  <office:styles>
    <style:default-style style:family="graphic">
      <style:text-properties fo:font-size="24pt" fo:font-family="'Liberation Sans'"/>
    </style:default-style>
  </office:styles>
  <office:automatic-styles>
    <style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/></style:page-layout>
    <style:style style:name="Mdp1" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="#102030"/></style:style>
    <style:style style:name="Mgr1" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#ff0000" draw:stroke="none"/></style:style>
  </office:automatic-styles>
  <office:master-styles>
    <style:master-page style:name="Default" style:page-layout-name="PM1" draw:style-name="Mdp1">
      <draw:rect draw:style-name="Mgr1" svg:x="1cm" svg:y="1cm" svg:width="2cm" svg:height="1cm"/>
      <draw:frame presentation:class="title" presentation:placeholder="true" svg:x="1cm" svg:y="2cm" svg:width="20cm" svg:height="3cm"><draw:text-box/></draw:frame>
    </style:master-page>
  </office:master-styles>
</office:document-styles>`;

const AUTO = `
  <style:style style:name="dp1" style:family="drawing-page">
    <style:drawing-page-properties presentation:transition-type="automatic" presentation:duration="PT00H00M05S" smil:type="fade" smil:subtype="fadeOverColor">
      <presentation:sound xlink:href="Media/chime.wav"/>
    </style:drawing-page-properties>
  </style:style>
  <style:style style:name="dp2" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="hidden" presentation:background-objects-visible="false"/></style:style>
  <style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:fill="none" draw:stroke="none"/></style:style>
  <style:style style:name="gr2" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#00ff00" draw:stroke="solid" svg:stroke-color="#0000ff" svg:stroke-width="0.1cm"/></style:style>
  <style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#ffff00" fo:font-size="40pt"/></style:style>
  <text:list-style style:name="L1">
    <text:list-level-style-bullet text:level="1" text:bullet-char="●">
      <style:list-level-properties text:space-before="0.5cm" text:min-label-width="1cm"/>
    </text:list-level-style-bullet>
  </text:list-style>`;

const PAGE1 = `<draw:page draw:name="page1" draw:style-name="dp1" draw:master-page-name="Default" xml:id="p1">
  <draw:frame presentation:class="title" draw:style-name="gr1" svg:x="1cm" svg:y="2cm" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>Amazing grace</text:p></draw:text-box></draw:frame>
  <draw:frame draw:style-name="gr1" svg:x="2cm" svg:y="6cm" svg:width="20cm" svg:height="6cm"><draw:text-box>
    <text:p>How <text:span text:style-name="T1">sweet</text:span>  the<text:s text:c="2"/>sound</text:p>
    <text:list text:style-name="L1"><text:list-item><text:p>First</text:p></text:list-item><text:list-item><text:p>Second<text:line-break/>line</text:p></text:list-item></text:list>
  </draw:text-box></draw:frame>
  <draw:custom-shape draw:style-name="gr2" svg:x="0cm" svg:y="0cm" svg:width="10cm" svg:height="5cm">
    <draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:modifiers="10800" draw:enhanced-path="M ?f0 0 L 21600 21600 0 21600 Z N">
      <draw:equation draw:name="f0" draw:formula="$0 "/>
    </draw:enhanced-geometry>
  </draw:custom-shape>
  <draw:frame draw:style-name="gr1" svg:x="20cm" svg:y="1cm" svg:width="4cm" svg:height="3cm"><draw:image xlink:href="Pictures/photo.png"/></draw:frame>
  <draw:g>
    <draw:rect draw:style-name="gr2" svg:x="5cm" svg:y="10cm" svg:width="1cm" svg:height="1cm"/>
    <draw:ellipse draw:style-name="gr2" svg:x="7cm" svg:y="11cm" svg:width="2cm" svg:height="1cm"/>
  </draw:g>
  <draw:frame svg:x="14cm" svg:y="7.875cm" svg:width="14cm" svg:height="7.875cm"><draw:plugin xlink:href="Media/clip.mp4"><draw:param draw:name="Loop" draw:value="true"/></draw:plugin></draw:frame>
  <anim:par presentation:node-type="timing-root"><anim:par smil:begin="p1.begin"><anim:transitionFilter smil:dur="1.5s" smil:type="fade" smil:subtype="fadeOverColor"/></anim:par></anim:par>
  <presentation:notes><draw:frame presentation:class="notes"><draw:text-box><text:p>Sing slowly</text:p></draw:text-box></draw:frame></presentation:notes>
</draw:page>`;

const PAGE2 = `<draw:page draw:name="page2" draw:style-name="dp2" draw:master-page-name="Default">
  <draw:rect draw:style-name="gr2" svg:x="1cm" svg:y="1cm" svg:width="3cm" svg:height="3cm"/>
  <draw:custom-shape draw:style-name="gr2"><draw:enhanced-geometry draw:enhanced-path="M 0 0 L 10 10"/></draw:custom-shape>
  <draw:custom-shape draw:style-name="gr2" svg:x="1cm" svg:y="1cm" svg:width="3cm" svg:height="3cm">
    <draw:enhanced-geometry draw:enhanced-path="M ?f9 ?nope Q C 1 A">
      <draw:equation draw:name="f9" draw:formula="if(?f9, ?f9 +, ((("/>
    </draw:enhanced-geometry>
  </draw:custom-shape>
</draw:page>`;

const content = (pages: string): string =>
  `<office:document-content ${NS}><office:automatic-styles>${AUTO}</office:automatic-styles><office:body><office:presentation>${pages}</office:presentation></office:body></office:document-content>`;

let dir: string;
let resources: PptxResources;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odp-reader-"));
  const ooxml = path.join(__dirname, "../../resources/ooxml");
  resources = {
    presets: parsePresetDefinitions(fs.readFileSync(path.join(ooxml, "presetShapeDefinitions.xml"), "utf8")),
    tableStyles: parseTableStyles(fs.readFileSync(path.join(ooxml, "tableStyles.xml"), "utf8")),
  };
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeOdp(name: string, entries: Record<string, string | Uint8Array>): string {
  const file = path.join(dir, name);
  const files: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) files[k] = typeof v === "string" ? strToU8(v) : v;
  fs.writeFileSync(file, zipSync(files));
  return file;
}

const deckFile = (): string =>
  writeOdp("deck.odp", {
    mimetype: "application/vnd.oasis.opendocument.presentation",
    "content.xml": content(PAGE1 + PAGE2),
    "styles.xml": STYLES,
    "Pictures/photo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    "Media/chime.wav": new Uint8Array([1, 2, 3]),
    "Media/clip.mp4": new Uint8Array([1, 2, 3]),
  });

const CM = 360000;
const shapes = (els: SlideElement[]): ShapeElement[] => els.filter((e): e is ShapeElement => e.kind === "shape");

test("every page in order, hidden ones included, at the master's page size", () => {
  const deck = readOdpDeck(deckFile(), resources);
  expect(deck.width).toBe(28 * CM);
  expect(deck.height).toBe(15.75 * CM);
  expect(deck.slides.map((s) => [s.number, s.hidden])).toEqual([[1, false], [2, true]]);
});

test("the master's background and shapes are drawn under the page's, its placeholders never", () => {
  const [first, second] = readOdpDeck(deckFile(), resources).slides;
  expect(first!.model.background).toEqual({ kind: "solid", color: "rgb(16,32,48)" });
  // The master's red rectangle comes first; its empty title placeholder not at all.
  const logo = first!.model.elements[0] as ShapeElement;
  expect(logo.fill).toEqual({ kind: "solid", color: "rgb(255,0,0)" });
  expect(logo.frame).toMatchObject({ x: 1 * CM, y: 1 * CM, w: 2 * CM, h: 1 * CM });
  expect(shapes(first!.model.elements).filter((s) => s.text?.paragraphs.some((p) => p.runs.some((r) => r.kind === "text" && r.text === "Amazing grace")))).toHaveLength(1);
  // A page that hides background objects shows none of the master's.
  expect(second!.model.elements.some((e) => e.kind === "shape" && e.fill?.kind === "solid" && e.fill.color === "rgb(255,0,0)")).toBe(false);
});

test("a text box: runs with their own look, ODF white space, bullets from the list style", () => {
  const slide = readOdpDeck(deckFile(), resources).slides[0]!;
  const box = shapes(slide.model.elements).find((s) => s.frame.x === 2 * CM)!;
  const [plain, first, second] = box.text!.paragraphs;
  expect(plain!.runs.map((r) => (r.kind === "text" ? r.text : "|"))).toEqual(["How ", "sweet", " the  sound"]);
  const sweet = plain!.runs[1]!;
  expect(sweet).toMatchObject({ kind: "text", bold: true, size: 40, fill: { kind: "solid", color: "rgb(255,255,0)" } });
  expect(plain!.bullet).toBeNull();
  expect(first!.bullet).toMatchObject({ kind: "char", char: "●" });
  // The label at space-before, the text a label's width after it.
  expect(first!.marginLeft).toBeCloseTo(1.5 * CM);
  expect(first!.indent).toBeCloseTo(-1 * CM);
  expect(second!.runs.map((r) => r.kind)).toEqual(["text", "break", "text"]);
});

test("a custom shape's enhanced geometry, evaluated at its size", () => {
  const slide = readOdpDeck(deckFile(), resources).slides[0]!;
  const tri = shapes(slide.model.elements).find((s) => s.fill?.kind === "solid" && s.fill.color === "rgb(0,255,0)" && s.frame.w === 10 * CM)!;
  // `?f0` is the modifier, the middle of the 21600 view: half the width.
  expect(tri.paths).toEqual([{ d: "M1800000 0L3600000 1800000L0 1800000Z", fill: "norm", stroke: true }]);
  expect(tri.line).toMatchObject({ width: 0.1 * CM, fill: { kind: "solid", color: "rgb(0,0,255)" } });
});

test("a picture is named by its entry in the package, and a group keeps its children", () => {
  const els = readOdpDeck(deckFile(), resources).slides[0]!.model.elements;
  const pic = els.find((e): e is PictureElement => e.kind === "picture")!;
  expect(pic.image.part).toBe("Pictures/photo.png");
  const group = els.find((e): e is GroupElement => e.kind === "group")!;
  expect(group.children.map((c) => c.kind)).toEqual(["shape", "shape"]);
  // Children are in the page's own space, which the group maps 1:1.
  expect(group.childFrame).toEqual({ x: group.frame.x, y: group.frame.y, w: group.frame.w, h: group.frame.h });
});

test("timings, the transition, the page sound, the clip, the title and the notes", () => {
  const meta = readOdpMeta(deckFile());
  expect(meta.slideCount).toBe(2);
  expect(meta.slideSizeEmu).toEqual({ cx: 28 * CM, cy: 15.75 * CM });
  const [first, second] = meta.slides;
  expect(first).toMatchObject({ slideIndex: 1, autoAdvanceMs: 5000, hidden: false, title: "Amazing grace", notes: "Sing slowly" });
  expect(first!.transition).toEqual({ style: "fade-through-black", durationMs: 1500 });
  expect(second).toMatchObject({ slideIndex: 2, autoAdvanceMs: null, hidden: true, transition: null });
  expect(meta.audio).toEqual([{ partName: "Media/chime.wav", startSlideIndex: 1, origin: "transition", loop: false, volume: null, slides: 1 }]);
  expect(meta.video).toEqual([{ partName: "Media/clip.mp4", slideIndex: 1, rect: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, loop: true, volume: null }]);
});

test("a broken shape costs that shape, not the page", () => {
  const second = readOdpDeck(deckFile(), resources).slides[1]!;
  expect(shapes(second.model.elements)).toHaveLength(2);
  expect(second.unsupported["shape:no-size"]).toBe(1);
});

test("a file that can't be a presentation throws a clear error", () => {
  const good = fs.readFileSync(deckFile());
  const truncated = path.join(dir, "truncated.odp");
  fs.writeFileSync(truncated, good.subarray(0, good.length >> 1));
  expect(() => readOdpDeck(truncated, resources)).toThrow();
  const noContent = writeOdp("no-content.odp", { mimetype: "application/vnd.oasis.opendocument.presentation", "styles.xml": STYLES });
  expect(() => readOdpDeck(noContent, resources)).toThrow(/no content\.xml/);
  const malformed = writeOdp("malformed.odp", { mimetype: "application/vnd.oasis.opendocument.presentation", "content.xml": content(PAGE1).replace("</draw:page>", "") });
  expect(() => readOdpDeck(malformed, resources)).toThrow(/content\.xml is not well-formed/);
  expect(() => readOdpMeta(malformed)).toThrow(/not well-formed/);
  const text = writeOdp("text.odt", { mimetype: "application/vnd.oasis.opendocument.text", "content.xml": content(PAGE1) });
  expect(() => readOdpDeck(text, resources)).toThrow(/not an OpenDocument presentation/);
});

test("styles.xml that won't parse costs the styles, counted on every page", () => {
  const file = writeOdp("bad-styles.odp", { mimetype: "application/vnd.oasis.opendocument.presentation", "content.xml": content(PAGE1), "styles.xml": "<office:document-styles" });
  const deck = readOdpDeck(file, resources);
  expect(deck.slides).toHaveLength(1);
  expect(deck.slides[0]!.unsupported["styles:unreadable"]).toBe(1);
});
