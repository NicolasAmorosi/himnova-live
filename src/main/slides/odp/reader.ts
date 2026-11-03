import type {
  EmbeddedFontRef,
  Fill,
  Frame,
  GeometryPath,
  ImageRef,
  Insets,
  Line,
  PictureElement,
  ShapeElement,
  SlideElement,
  SlideModel,
  TableCell,
  TableElement,
  TextBody,
} from "@shared/types/slide-model";
import type { PptxDeck, PptxResources, PptxSlide } from "../pptx/reader";
import { NO_EFFECTS } from "../pptx/style";
import { attr, child, children, type XmlElement } from "../pptx/xml";
import { readZipEntries } from "../zip-reader";
import { apply, degrees, EMU_PER_MM100, ellipsePath, enhancedGeometry, mapSvgPath, parseTransform, pointsPath, rectPath, compose, type Matrix } from "./geometry";
import { EMPTY, firstFamily, mergeProps, openOdp, type OdpPackage, type Resolved, type Scope } from "./package";
import {
  drawableFormat,
  imageEffects,
  imageFormatMiss,
  length,
  lengthOr,
  miss,
  naturalSize,
  partOf,
  percent,
  readEffects,
  readFill,
  readLine,
  type Misses,
} from "./style";
import { readTextBody, type TextContext, type TextStyles } from "./text";
import { textOf } from "./xml";

/**
 * Reads every page of an `.odp` into what `SlideView` paints — the same
 * model, and the same deck shape, as a `.pptx` (`../pptx/reader.ts`). What
 * can't be drawn exactly is approximated and counted in the slide's
 * `unsupported`; a shape that can't be read at all costs that shape. Only a
 * file that won't open as a presentation throws.
 */
export function readOdpDeck(file: string, resources: PptxResources): PptxDeck {
  const pkg = openOdp(file);
  const pages = children(pkg.presentation, "draw:page");
  const { width, height } = pageSize(pkg, pages[0] ?? null);
  const fonts = embeddedFonts(pkg);
  const decls = declarations(pkg.presentation);
  const hiddenLayers = new Set(
    children(childDeep(pkg.styles, "office:master-styles", "draw:layer-set"), "draw:layer")
      .filter((l) => attr(l, "draw:display") === "none" || attr(l, "draw:display") === "printer")
      .map((l) => attr(l, "draw:name") ?? ""),
  );
  const slides: PptxSlide[] = pages.map((page, i) => {
    const misses: Misses = new Map();
    if (pkg.stylesBroken) miss(misses, "styles:unreadable");
    const deck: DeckScope = { pkg, resources, width, height, fonts, decls, hiddenLayers, pageCount: pages.length };
    const read = readPage(page, i + 1, deck, misses);
    return { number: i + 1, hidden: read.hidden, model: read.model, unsupported: Object.fromEntries(misses) };
  });
  return { width, height, slides, fonts };
}

type DeckScope = {
  pkg: OdpPackage;
  resources: PptxResources;
  width: number;
  height: number;
  fonts: EmbeddedFontRef[];
  decls: Map<string, string>;
  hiddenLayers: ReadonlySet<string>;
  pageCount: number;
};

function childDeep(el: XmlElement | null, ...names: string[]): XmlElement | null {
  let at = el;
  for (const n of names) at = child(at, n);
  return at;
}

/** The slide size, from the page layout of the first page's master. */
function pageSize(pkg: OdpPackage, first: XmlElement | null): { width: number; height: number } {
  const sheet = pkg.sheet;
  const master = sheet.masters.get(attr(first, "draw:master-page-name") ?? "") ?? sheet.masterList[0] ?? null;
  const layout = sheet.pageLayouts.get(attr(master, "style:page-layout-name") ?? "") ?? [...sheet.pageLayouts.values()][0] ?? null;
  const props = child(layout, "style:page-layout-properties");
  const width = length(attr(props, "fo:page-width"));
  const height = length(attr(props, "fo:page-height"));
  return width && height && width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : { width: 10080000, height: 7560000 };
}

/** ODF 1.3 font embedding: `svg:font-face-uri` entries inside the package. */
function embeddedFonts(pkg: OdpPackage): EmbeddedFontRef[] {
  const out: EmbeddedFontRef[] = [];
  const seen = new Set<string>();
  for (const face of pkg.sheet.fontFaces.values()) {
    const family = firstFamily(attr(face, "svg:font-family")) ?? attr(face, "style:name");
    if (!family) continue;
    for (const uri of children(child(face, "svg:font-face-src"), "svg:font-face-uri")) {
      const part = partOf(attr(uri, "xlink:href"), { pkg });
      if (!part || seen.has(part)) continue;
      seen.add(part);
      const bold = /bold|[6-9]00/.test(attr(uri, "loext:font-weight") ?? "");
      const italic = /italic|oblique/.test(attr(uri, "loext:font-style") ?? "");
      out.push({ family, style: bold && italic ? "boldItalic" : bold ? "bold" : italic ? "italic" : "regular", part });
    }
  }
  return out;
}

/** `presentation:header-decl`/`footer-decl`/`date-time-decl` by name. */
function declarations(presentation: XmlElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of presentation.children) {
    if (c.name === "presentation:header-decl" || c.name === "presentation:footer-decl" || c.name === "presentation:date-time-decl") {
      const name = attr(c, "presentation:name");
      if (name) out.set(`${c.name}/${name}`, textOf(c).trim());
    }
  }
  return out;
}

/** What every shape of one page is read against. */
type PageScope = DeckScope & {
  misses: Misses;
  scope: Scope;
  onMaster: boolean;
  masterName: string;
  text: TextContext;
  display: { footer: boolean; dateTime: boolean; pageNumber: boolean; header: boolean };
};

/** Presentation objects that are templates on a master, never drawn on a slide. */
const LAYOUT_CLASSES = new Set([
  "title", "outline", "subtitle", "text", "notes", "graphic", "object", "chart", "table", "orgchart", "page", "handout",
  "vertical_title", "vertical_outline", "vertical-title", "vertical-outline",
]);

function readPage(page: XmlElement, number: number, deck: DeckScope, misses: Misses): { hidden: boolean; model: SlideModel } {
  const { pkg, width, height } = deck;
  const sheet = pkg.sheet;
  const pageStyle = sheet.resolve("content", "drawing-page", attr(page, "draw:style-name"));
  const masterName = attr(page, "draw:master-page-name") ?? "";
  const master = sheet.masters.get(masterName) ?? sheet.masterList[0] ?? null;
  const masterStyle = master ? sheet.resolve("styles", "drawing-page", attr(master, "draw:style-name")) : EMPTY;
  const pp = pageStyle.page;
  const paint = { pkg, misses };
  const box = { w: width, h: height };
  let background: Fill | null = null;
  if (pp["draw:fill"] && pp["draw:fill"] !== "none") background = readFill(pp, paint, "none", box);
  else if (pp["presentation:background-visible"] !== "false" && master) background = readFill(masterStyle.page, paint, "none", box);
  const bgColor = background?.kind === "solid" ? background.color : background?.kind === "linear" || background?.kind === "path" ? (background.stops[0]?.color ?? null) : background ? null : "rgb(255,255,255)";

  const decl = (kind: string, name: string | null): string => (name ? (deck.decls.get(`presentation:${kind}-decl/${name}`) ?? "") : "");
  const dateTimeName = attr(page, "presentation:use-date-time-name");
  const text: TextContext = {
    pkg,
    scope: "content",
    misses,
    pageNumber: number,
    pageCount: deck.pageCount,
    pageName: attr(page, "draw:name") ?? "",
    fields: { header: decl("header", attr(page, "presentation:use-header-name")), footer: decl("footer", attr(page, "presentation:use-footer-name")), dateTime: decl("date-time", dateTimeName) },
    background: bgColor,
  };
  if (dateTimeName && deck.pkg.presentation.children.some((c) => c.name === "presentation:date-time-decl" && attr(c, "presentation:name") === dateTimeName && attr(c, "presentation:source") === "current")) {
    miss(misses, "field:current-date");
  }
  const scope: PageScope = {
    ...deck,
    misses,
    scope: "content",
    onMaster: false,
    masterName: attr(master, "style:name") ?? masterName,
    text,
    display: {
      footer: pp["presentation:display-footer"] !== "false",
      dateTime: pp["presentation:display-date-time"] !== "false",
      pageNumber: pp["presentation:display-page-number"] === "true",
      header: pp["presentation:display-header"] !== "false",
    },
  };
  const elements: SlideElement[] = [];
  if (master && pp["presentation:background-objects-visible"] !== "false") {
    elements.push(...readShapes(master, { ...scope, scope: "styles", onMaster: true, text: { ...text, scope: "styles" } }));
  }
  elements.push(...readShapes(page, scope));
  return {
    hidden: pp["presentation:visibility"] === "hidden",
    model: { width, height, background, elements, fonts: deck.fonts },
  };
}

function readShapes(parent: XmlElement, scope: PageScope): SlideElement[] {
  const out: SlideElement[] = [];
  for (const el of parent.children) {
    if (!el.name.startsWith("draw:") && !el.name.startsWith("dr3d:")) continue;
    if (scope.hiddenLayers.has(attr(el, "draw:layer") ?? "")) continue;
    const display = attr(el, "draw:display");
    if (display === "none" || display === "printer") continue;
    const cls = attr(el, "presentation:class");
    if (scope.onMaster && cls) {
      if (LAYOUT_CLASSES.has(cls)) continue;
      if (cls === "footer" && !scope.display.footer) continue;
      if (cls === "date-time" && !scope.display.dateTime) continue;
      if (cls === "page-number" && !scope.display.pageNumber) continue;
      if (cls === "header" && !scope.display.header) continue;
    }
    // An empty placeholder shows its prompt only while editing.
    if (attr(el, "presentation:placeholder") === "true") continue;
    try {
      out.push(...readElement(el, scope));
    } catch {
      miss(scope.misses, "shape:unreadable");
    }
  }
  return out;
}

function readElement(el: XmlElement, scope: PageScope): SlideElement[] {
  const one = (e: SlideElement | null): SlideElement[] => (e ? [e] : []);
  switch (el.name) {
    case "draw:frame":
      return readFrame(el, scope);
    case "draw:custom-shape":
      return one(readCustomShape(el, scope));
    case "draw:rect":
    case "draw:caption": {
      if (el.name === "draw:caption") miss(scope.misses, "shape:caption");
      const place = placement(el, scope);
      if (!place) return [];
      return one(basicShape(el, place, [{ d: rectPath(place.frame.w, place.frame.h, lengthOr(attr(el, "draw:corner-radius"), 0)), fill: "norm", stroke: true }], scope));
    }
    case "draw:ellipse":
    case "draw:circle": {
      const place = placement(el, scope);
      if (!place) return [];
      const kind = attr(el, "draw:kind") ?? "full";
      const d = ellipsePath(place.frame.w, place.frame.h, kind, degrees(attr(el, "draw:start-angle")), degrees(attr(el, "draw:end-angle"), 360));
      return one(basicShape(el, place, [{ d, fill: kind === "arc" ? "none" : "norm", stroke: true }], scope));
    }
    case "draw:polygon":
    case "draw:polyline": {
      const place = placement(el, scope);
      if (!place) return [];
      const vb = viewBox(el, place.frame);
      const d = pointsPath(attr(el, "draw:points") ?? "", el.name === "draw:polygon", vb.x, vb.y, vb.sx, vb.sy);
      return one(basicShape(el, place, [{ d, fill: el.name === "draw:polygon" ? "norm" : "none", stroke: true }], scope));
    }
    case "draw:regular-polygon": {
      const place = placement(el, scope);
      if (!place) return [];
      return one(basicShape(el, place, [{ d: regularPolygon(el, place.frame.w, place.frame.h), fill: "norm", stroke: true }], scope));
    }
    case "draw:path": {
      const place = placement(el, scope);
      if (!place) return [];
      const vb = viewBox(el, place.frame);
      const source = attr(el, "svg:d") ?? "";
      const d = mapSvgPath(source, vb.x, vb.y, vb.sx, vb.sy);
      return one(basicShape(el, place, [{ d, fill: /z/i.test(source) ? "norm" : "none", stroke: true }], scope));
    }
    case "draw:line":
    case "draw:measure":
    case "draw:connector":
      return one(readLineLike(el, scope));
    case "draw:g": {
      const kids = readShapes(el, scope);
      if (kids.length === 0) return [];
      const frames = kids.map((k) => k.frame);
      const x = Math.min(...frames.map((f) => f.x));
      const y = Math.min(...frames.map((f) => f.y));
      const w = Math.max(...frames.map((f) => f.x + f.w)) - x;
      const h = Math.max(...frames.map((f) => f.y + f.h)) - y;
      // ODF writes a group's children in the page's own space: the group maps it 1:1.
      return [{ kind: "group", frame: { x, y, w, h, rot: 0, flipH: false, flipV: false }, childFrame: { x, y, w: w || 1, h: h || 1 }, children: kids }];
    }
    case "draw:a":
      return readShapes(el, scope);
    case "dr3d:scene":
      miss(scope.misses, "shape:3d");
      return [];
    case "draw:page-thumbnail":
      miss(scope.misses, "shape:page-thumbnail");
      return [];
    case "draw:control":
      miss(scope.misses, "shape:control");
      return [];
    case "draw:layer-set":
      return [];
    default:
      miss(scope.misses, `shape:${el.name}`);
      return [];
  }
}

// -- placement ----------------------------------------------------------------------------------

type Placement = { frame: Frame };

/**
 * Where a shape sits: its box (`svg:x/y/width/height`) under `draw:transform`,
 * which ODF applies after placing the box. A rotation, a translation and a
 * mirror are what `Frame` can say; a skew is counted and dropped.
 */
function placement(el: XmlElement, scope: PageScope): Placement | null {
  const w = length(attr(el, "svg:width"));
  const h = length(attr(el, "svg:height"));
  if (w === null && h === null) {
    miss(scope.misses, "shape:no-size");
    return null;
  }
  let m: Matrix = [w ?? 0, 0, 0, h ?? 0, length(attr(el, "svg:x")) ?? 0, length(attr(el, "svg:y")) ?? 0];
  const transform = attr(el, "draw:transform");
  if (transform) m = compose(m, parseTransform(transform, length));
  return { frame: decompose(m, scope.misses) };
}

/** A unit-square map as a frame: size, rotation about its centre, mirror. */
function decompose(m: Matrix, misses: Misses): Frame {
  const sx = Math.hypot(m[0], m[1]);
  const det = m[0] * m[3] - m[1] * m[2];
  let rot: number;
  let w: number;
  let h: number;
  if (sx > 1e-9) {
    rot = Math.atan2(m[1], m[0]);
    w = sx;
    h = Math.abs(det) / sx;
    const shear = (m[0] * m[2] + m[1] * m[3]) / (sx * sx);
    if (Math.abs(shear) > 0.01) miss(misses, "transform:skew");
  } else {
    // No width: the angle is the height's.
    rot = Math.atan2(-m[2], m[3]);
    w = 0;
    h = Math.hypot(m[2], m[3]);
  }
  const [cx, cy] = apply(m, 0.5, 0.5);
  const deg = (((rot * 180) / Math.PI) % 360 + 360) % 360;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot: Math.abs(deg) < 1e-6 || Math.abs(deg - 360) < 1e-6 ? 0 : deg, flipH: false, flipV: det < 0 };
}

/** `svg:viewBox` mapped onto a frame, for points and paths. */
function viewBox(el: XmlElement, frame: Frame): { x: number; y: number; sx: number; sy: number } {
  const v = (attr(el, "svg:viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const [x = 0, y = 0, vw = 0, vh = 0] = v.map((n) => (Number.isFinite(n) ? n : 0));
  return { x, y, sx: vw > 0 ? frame.w / vw : EMU_PER_MM100, sy: vh > 0 ? frame.h / vh : EMU_PER_MM100 };
}

// -- styles -------------------------------------------------------------------------------------

/** A shape's style: its presentation style, with its graphic one on top. */
function shapeStyle(el: XmlElement, scope: PageScope): Resolved {
  const sheet = scope.pkg.sheet;
  const pres = attr(el, "presentation:style-name");
  const gr = attr(el, "draw:style-name");
  if (pres && gr) {
    const a = sheet.resolve(scope.scope, "presentation", pres);
    const b = sheet.resolve(scope.scope, "graphic", gr);
    const out: Resolved = { graphic: {}, paragraph: {}, text: {}, page: {}, cell: {}, column: {}, row: {}, listStyle: b.listStyle ?? a.listStyle, tabStops: b.tabStops ?? a.tabStops, columns: b.columns ?? a.columns, sound: null };
    for (const k of ["graphic", "paragraph", "text"] as const) {
      mergeProps(out[k], a[k]);
      mergeProps(out[k], b[k]);
    }
    return out;
  }
  return pres ? sheet.resolve(scope.scope, "presentation", pres) : sheet.resolve(scope.scope, "graphic", gr);
}

function textStyles(el: XmlElement, style: Resolved, scope: PageScope): TextStyles {
  const sheet = scope.pkg.sheet;
  const textStyle = attr(el, "draw:text-style-name");
  const fils = (textStyle ? sheet.resolve(scope.scope, "paragraph", textStyle).paragraph["style:font-independent-line-spacing"] : undefined) ?? style.paragraph["style:font-independent-line-spacing"];
  const cls = attr(el, "presentation:class");
  // Paragraphs below the first level of an outline take the master's
  // `<master>-outline<n>` styles.
  const outline = cls === "outline" ? (level: number): Resolved | null => (sheet.find("styles", "presentation", `${scope.masterName}-outline${level}`) ? sheet.resolve("styles", "presentation", `${scope.masterName}-outline${level}`) : null) : null;
  return { shape: style, fixedLines: fils === "true", outline };
}

/** The colour behind a shape's text: its own fill, else the page's. */
function behind(fill: Fill | null, scope: PageScope): TextContext {
  if (fill?.kind === "solid") return { ...scope.text, background: fill.color };
  return scope.text;
}

// -- shapes -------------------------------------------------------------------------------------

function basicShape(el: XmlElement, place: Placement, paths: GeometryPath[], scope: PageScope, textRect?: Insets, wrap = true): ShapeElement {
  const style = shapeStyle(el, scope);
  const paint = { pkg: scope.pkg, misses: scope.misses };
  const { frame } = place;
  const fill = paths.every((p) => p.fill === "none") ? null : readFill(style.graphic, paint, "solid", frame);
  const line = readLine(style.graphic, paint, "solid");
  const rect = textRect ?? { l: 0, t: 0, r: frame.w, b: frame.h };
  const text = readTextBody(el, textStyles(el, style, scope), wrap, { w: rect.r - rect.l, h: rect.b - rect.t }, behind(fill, scope));
  return { kind: "shape", frame, paths, fill, line, effects: readEffects(style.graphic), textRect: rect, text };
}

function readCustomShape(el: XmlElement, scope: PageScope): ShapeElement | null {
  const place = placement(el, scope);
  if (!place) return null;
  const style = shapeStyle(el, scope);
  const g = style.graphic;
  const paint = { pkg: scope.pkg, misses: scope.misses };
  const { frame } = place;
  const geo = child(el, "draw:enhanced-geometry");
  const fill = readFill(g, paint, "solid", frame);
  const line = readLine(g, paint, "solid");
  const look = { hasFill: fill !== null, hasStroke: line !== null };
  const geometry = geo ? enhancedGeometry(geo, frame.w, frame.h, look, scope.resources.presets, (what) => miss(scope.misses, what)) : null;
  if (!geometry) miss(scope.misses, `geometry:${attr(geo, "draw:type") ?? "none"}`);
  if (attr(geo, "draw:extrusion") === "true") miss(scope.misses, "shape:3d");
  if (attr(geo, "draw:text-path") === "true") miss(scope.misses, "text:fontwork");
  const paths = geometry?.paths ?? [{ d: rectPath(frame.w, frame.h, 0), fill: "norm" as const, stroke: true }];
  const flipped: Frame = { ...frame, flipH: frame.flipH !== (geometry?.flipH ?? false), flipV: frame.flipV !== (geometry?.flipV ?? false) };
  const rect = geometry?.textRect ?? { l: 0, t: 0, r: frame.w, b: frame.h };
  const text = readTextBody(el, textStyles(el, style, scope), g["fo:wrap-option"] !== "no-wrap", { w: rect.r - rect.l, h: rect.b - rect.t }, behind(fill, scope));
  if (text && geometry?.rotation) text.rotation = geometry.rotation;
  return { kind: "shape", frame: flipped, paths, fill, line, effects: readEffects(g), textRect: rect, text };
}

/** `draw:line`, `draw:connector` and `draw:measure`: two points, or the path
 *  a connector was routed along. */
function readLineLike(el: XmlElement, scope: PageScope): ShapeElement | null {
  const len = (name: string): number => length(attr(el, name)) ?? 0;
  let a: [number, number] = [len("svg:x1"), len("svg:y1")];
  let b: [number, number] = [len("svg:x2"), len("svg:y2")];
  const transform = attr(el, "draw:transform");
  if (transform) {
    const m = parseTransform(transform, length);
    a = apply(m, ...a);
    b = apply(m, ...b);
  }
  if (el.name === "draw:measure") miss(scope.misses, "shape:measure");
  const routed = el.name === "draw:connector" ? attr(el, "svg:d") : null;
  if (el.name === "draw:connector" && !routed && attr(el, "draw:type") !== "line" && attr(el, "draw:type") !== "lines") miss(scope.misses, "connector:route");
  let x = Math.min(a[0], b[0]);
  let y = Math.min(a[1], b[1]);
  let w = Math.abs(b[0] - a[0]);
  let h = Math.abs(b[1] - a[1]);
  let d = `M${r(a[0] - x)} ${r(a[1] - y)}L${r(b[0] - x)} ${r(b[1] - y)}`;
  if (routed) {
    // A connector's route is written in the page's 1/100 mm.
    const absolute = mapSvgPath(routed, 0, 0, EMU_PER_MM100, EMU_PER_MM100);
    const box = pathBounds(absolute);
    if (box) {
      [x, y, w, h] = [box.x, box.y, box.w, box.h];
      d = mapSvgPath(routed, x / EMU_PER_MM100, y / EMU_PER_MM100, EMU_PER_MM100, EMU_PER_MM100);
    }
  }
  const frame: Frame = { x, y, w, h, rot: 0, flipH: false, flipV: false };
  const style = shapeStyle(el, scope);
  const line = readLine(style.graphic, { pkg: scope.pkg, misses: scope.misses }, "solid");
  const text = readTextBody(el, textStyles(el, style, scope), true, { w, h }, scope.text);
  return { kind: "shape", frame, paths: [{ d, fill: "none", stroke: true }], fill: null, line, effects: readEffects(style.graphic), textRect: { l: 0, t: 0, r: w, b: h }, text };
}

/** The bounding box of an absolute path's coordinates (control points
 *  included: an upper bound, which is all a frame needs). */
function pathBounds(d: string): { x: number; y: number; w: number; h: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [, cmd, args] of d.matchAll(/([MLCQSTA])([^MLCQSTAZ]*)/g)) {
    const v = (args ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
    const pts = cmd === "A" ? v.slice(5, 7) : v;
    for (let k = 0; k + 1 < pts.length; k += 2) {
      xs.push(pts[k]!);
      ys.push(pts[k + 1]!);
    }
  }
  if (xs.length === 0) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function regularPolygon(el: XmlElement, w: number, h: number): string {
  const corners = Math.max(3, Math.min(100, Number(attr(el, "draw:corners") ?? 5) || 5));
  const concave = attr(el, "draw:concave") === "true";
  const sharp = percent(attr(el, "draw:sharpness")) ?? 0.5;
  const pts: string[] = [];
  const count = concave ? corners * 2 : corners;
  for (let k = 0; k < count; k++) {
    const a = -Math.PI / 2 + (k * 2 * Math.PI) / count;
    const f = concave && k % 2 === 1 ? 1 - sharp : 1;
    pts.push(`${k === 0 ? "M" : "L"}${r(w / 2 + (w / 2) * f * Math.cos(a))} ${r(h / 2 + (h / 2) * f * Math.sin(a))}`);
  }
  return `${pts.join("")}Z`;
}

/** A frame holds one thing: a text box, a picture, an object's last
 *  rendering, a table, a media clip's poster. */
function readFrame(el: XmlElement, scope: PageScope): SlideElement[] {
  const place = placement(el, scope);
  if (!place) return [];
  const { frame } = place;
  const style = shapeStyle(el, scope);
  const g = style.graphic;
  const paint = { pkg: scope.pkg, misses: scope.misses };
  const fill = readFill(g, paint, "none", frame);
  const line = readLine(g, paint, "none");
  const effects = readEffects(g);
  const radius = lengthOr(attr(el, "draw:corner-radius"), 0);
  const content = el.children.find((c) => FRAME_CONTENT.has(c.name)) ?? null;
  switch (content?.name) {
    case "draw:text-box": {
      const text = readTextBody(content, textStyles(el, style, scope), g["draw:auto-grow-width"] !== "true", frame, behind(fill, scope));
      return [{ kind: "shape", frame, paths: [{ d: rectPath(frame.w, frame.h, radius), fill: "norm", stroke: true }], fill, line, effects, textRect: { l: 0, t: 0, r: frame.w, b: frame.h }, text }];
    }
    case "table:table":
      return [readTable(content, frame, scope)];
    case "draw:object":
    case "draw:object-ole": {
      const image = replacementImage(el, scope);
      if (!image) {
        if (fill || line) return [{ kind: "shape", frame, paths: [{ d: rectPath(frame.w, frame.h, 0), fill: "norm", stroke: true }], fill, line, effects, textRect: { l: 0, t: 0, r: frame.w, b: frame.h }, text: null }];
        return [];
      }
      return [{ kind: "picture", frame, image, fill, clip: null, line, effects }];
    }
    case "draw:plugin":
    case "draw:image": {
      const picked = pickImage(el, scope);
      if (!picked) {
        if (content.name === "draw:image") miss(scope.misses, "image:missing");
        return [];
      }
      const mirror = g["style:mirror"] ?? "";
      const flipped: Frame = { ...frame, flipH: frame.flipH !== /horizontal/.test(mirror), flipV: frame.flipV !== /vertical/.test(mirror) };
      const image: ImageRef = {
        part: picked.part,
        crop: crop(g["fo:clip"], picked.part, scope),
        fill: null,
        alpha: percent(g["draw:image-opacity"]) ?? 1,
        effects: imageEffects(g, scope),
      };
      const picture: PictureElement = { kind: "picture", frame: flipped, image, fill, clip: radius > 0 ? [{ d: rectPath(frame.w, frame.h, radius), fill: "norm", stroke: false }] : null, line, effects };
      const caption = readTextBody(picked.el, textStyles(el, style, scope), true, frame, scope.text);
      if (!caption) return [picture];
      return [picture, { kind: "shape", frame, paths: [], fill: null, line: null, effects: NO_EFFECTS, textRect: { l: 0, t: 0, r: frame.w, b: frame.h }, text: caption }];
    }
    default:
      if (content) miss(scope.misses, `frame:${content.name}`);
      return [];
  }
}

const FRAME_CONTENT = new Set(["draw:text-box", "draw:image", "draw:object", "draw:object-ole", "table:table", "draw:plugin", "draw:applet", "draw:floating-frame"]);

/** The frame's first picture this app can draw (LibreOffice writes an SVG
 *  with a PNG after it to fall back on), else its first one at all. */
function pickImage(el: XmlElement, scope: PageScope): { part: string; el: XmlElement } | null {
  const images = children(el, "draw:image");
  let fallback: { part: string; el: XmlElement } | null = null;
  for (const img of images) {
    const part = partOf(attr(img, "xlink:href"), scope);
    if (!part) {
      if (child(img, "office:binary-data")) miss(scope.misses, "image:inline");
      else if (attr(img, "xlink:href")) miss(scope.misses, "image:linked");
      continue;
    }
    if (drawableFormat(part)) return { part, el: img };
    fallback ??= { part, el: img };
  }
  if (fallback) imageFormatMiss(fallback.part, scope);
  return fallback;
}

/** An object's replacement picture (`ObjectReplacements/…`, named with no
 *  extension), when it is in a format a browser draws. LibreOffice's own
 *  StarView metafile is not. */
function replacementImage(el: XmlElement, scope: PageScope): ImageRef | null {
  for (const img of children(el, "draw:image")) {
    const part = partOf(attr(img, "xlink:href"), scope);
    if (!part) continue;
    if (drawableFormat(part)) return { part, crop: null, fill: null, alpha: 1, effects: [] };
    const bytes = readZipEntries(scope.pkg.file, (n) => n === part)[part];
    const head = bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(16, bytes.byteLength)) : Buffer.alloc(0);
    const sniffed =
      head[0] === 0x89 && head[1] === 0x50 ? "png" : head[0] === 0xff && head[1] === 0xd8 ? "jpeg" : head.toString("latin1", 0, 3) === "GIF" ? "gif" : head.toString("latin1", 0, 2) === "BM" ? "bmp" : null;
    if (sniffed) return { part, crop: null, fill: null, alpha: 1, effects: [] };
    miss(scope.misses, head.toString("latin1", 0, 6) === "VCLMTF" ? "object:svm" : "object:replacement-format");
    return null;
  }
  miss(scope.misses, "object:no-replacement");
  return null;
}

/** `fo:clip="rect(top, right, bottom, left)"` as fractions of the picture,
 *  whose natural size the lengths are of. */
function crop(clip: string | undefined, part: string, scope: PageScope): Insets | null {
  if (!clip) return null;
  const m = /rect\(([^)]*)\)/.exec(clip);
  if (!m) return null;
  const v = m[1]!.split(/[\s,]+/).filter(Boolean).map((s) => (s === "auto" ? 0 : (length(s) ?? 0)));
  if (v.length !== 4 || v.every((x) => x === 0)) return null;
  const size = naturalSize(scope.pkg.file, part);
  if (!size) {
    miss(scope.misses, "image:crop");
    return null;
  }
  const [t, right, b, l] = v as [number, number, number, number];
  return { l: l / size.w, t: t / size.h, r: right / size.w, b: b / size.h };
}

// -- tables -------------------------------------------------------------------------------------

const TEMPLATE_PARTS: [string, string][] = [
  ["table:use-first-row-styles", "table:first-row"],
  ["table:use-last-row-styles", "table:last-row"],
  ["table:use-first-column-styles", "table:first-column"],
  ["table:use-last-column-styles", "table:last-column"],
];

function readTable(tbl: XmlElement, frame: Frame, scope: PageScope): TableElement {
  const sheet = scope.pkg.sheet;
  const unwrap = (el: XmlElement, names: string[], wrappers: string[]): XmlElement[] =>
    el.children.flatMap((c) => (names.includes(c.name) ? [c] : wrappers.includes(c.name) ? unwrap(c, names, wrappers) : []));
  const columnEls = unwrap(tbl, ["table:table-column"], ["table:table-columns", "table:table-header-columns", "table:table-column-group"]);
  const widths: (number | null)[] = columnEls.flatMap((c) => {
    const repeat = Math.max(1, Math.min(1000, Number(attr(c, "table:number-columns-repeated") ?? 1) || 1));
    const w = length(sheet.resolve(scope.scope, "table-column", attr(c, "table:style-name")).column["style:column-width"]);
    return Array.from({ length: repeat }, () => w);
  });
  const rowEls = unwrap(tbl, ["table:table-row"], ["table:table-rows", "table:table-header-rows", "table:table-row-group"]);
  const colCount = Math.max(widths.length, ...rowEls.map((r) => children(r, "table:table-cell").length + children(r, "table:covered-table-cell").length));
  const known = widths.filter((w): w is number => w !== null).reduce((a, b) => a + b, 0);
  const unknown = colCount - widths.filter((w) => w !== null).length;
  const columns = Array.from({ length: colCount }, (_, k) => widths[k] ?? Math.max(0, (frame.w - known) / Math.max(1, unknown)));
  const template = sheet.tableTemplates.get(attr(tbl, "table:template-name") ?? "") ?? null;
  const banding = { rows: attr(tbl, "table:use-banding-rows-styles") === "true", cols: attr(tbl, "table:use-banding-columns-styles") === "true" };
  const templateStyle = (r: number, c: number): string | null => {
    if (!template) return null;
    const pick = (name: string): string | null => attr(child(template, name), "table:style-name");
    for (const [flag, part] of TEMPLATE_PARTS) {
      if (attr(tbl, flag) !== "true") continue;
      if (part === "table:first-row" && r === 0) return pick(part);
      if (part === "table:last-row" && r === rowEls.length - 1) return pick(part);
      if (part === "table:first-column" && c === 0) return pick(part);
      if (part === "table:last-column" && c === colCount - 1) return pick(part);
    }
    if (banding.rows && r % 2 === 1) return pick("table:odd-rows") ?? pick("table:body");
    if (banding.cols && c % 2 === 1) return pick("table:odd-columns") ?? pick("table:body");
    return pick("table:body");
  };
  const paint = { pkg: scope.pkg, misses: scope.misses };
  const rows = rowEls.map((row, r) => {
    const rowStyle = sheet.resolve(scope.scope, "table-row", attr(row, "table:style-name")).row;
    const height = length(rowStyle["style:row-height"]) ?? length(rowStyle["style:min-row-height"]) ?? frame.h / Math.max(1, rowEls.length);
    let c = 0;
    const cells: TableCell[] = [];
    for (const cell of row.children) {
      if (cell.name !== "table:table-cell" && cell.name !== "table:covered-table-cell") continue;
      const covered = cell.name === "table:covered-table-cell";
      const base = templateStyle(r, c);
      const own = attr(cell, "table:style-name");
      const st = merge(base ? sheet.resolve("styles", "table-cell", base) : null, own ? sheet.resolve(scope.scope, "table-cell", own) : null);
      const all = { ...st.paragraph, ...st.cell, ...st.graphic };
      const border = (side: string): Line | null => borderLine(all[`fo:border-${side}`] ?? all["fo:border"]);
      const fillProps = st.graphic["draw:fill"] ? st.graphic : st.cell["fo:background-color"] && st.cell["fo:background-color"] !== "transparent" ? { "draw:fill": "solid", "draw:fill-color": st.cell["fo:background-color"] } : st.graphic;
      const fill = readFill(fillProps, paint, "none", { w: columns[c] ?? 0, h: height });
      const tctx = behind(fill, scope);
      const body = readTextBody(cell, { shape: st, fixedLines: false, outline: null }, true, { w: columns[c] ?? 0, h: height }, tctx) ?? emptyBody();
      body.insets = {
        l: lengthOr(all["fo:padding-left"] ?? all["fo:padding"], 0.25 * 360000),
        r: lengthOr(all["fo:padding-right"] ?? all["fo:padding"], 0.25 * 360000),
        t: lengthOr(all["fo:padding-top"] ?? all["fo:padding"], 0.13 * 360000),
        b: lengthOr(all["fo:padding-bottom"] ?? all["fo:padding"], 0.13 * 360000),
      };
      const v = st.graphic["draw:textarea-vertical-align"] ?? st.cell["style:vertical-align"];
      body.anchor = v === "middle" ? "ctr" : v === "bottom" ? "b" : "t";
      cells.push({
        gridSpan: covered ? 0 : Math.max(1, Number(attr(cell, "table:number-columns-spanned") ?? 1) || 1),
        rowSpan: covered ? 0 : Math.max(1, Number(attr(cell, "table:number-rows-spanned") ?? 1) || 1),
        fill,
        borders: { l: border("left"), t: border("top"), r: border("right"), b: border("bottom") },
        text: body,
      });
      c++;
    }
    return { height, cells };
  });
  return { kind: "table", frame, background: null, columns, rows };
}

function merge(a: Resolved | null, b: Resolved | null): Resolved {
  if (!a) return b ?? EMPTY;
  if (!b) return a;
  const out: Resolved = { graphic: {}, paragraph: {}, text: {}, page: {}, cell: {}, column: {}, row: {}, listStyle: b.listStyle ?? a.listStyle, tabStops: b.tabStops ?? a.tabStops, columns: null, sound: null };
  for (const k of ["graphic", "paragraph", "text", "cell"] as const) {
    mergeProps(out[k], a[k]);
    mergeProps(out[k], b[k]);
  }
  return out;
}

/** `0.03pt solid #ffffff`, as a line; `none` and unreadable ones as none. */
function borderLine(value: string | undefined): Line | null {
  if (!value || value === "none") return null;
  const parts = value.trim().split(/\s+/);
  const width = parts.map((p) => length(p)).find((l): l is number => l !== null) ?? 9525;
  const hex = parts.find((p) => /^#[0-9a-f]{6}$/i.test(p));
  const style = parts.find((p) => /^(solid|double|dotted|dashed|groove|ridge|inset|outset|hidden|none)$/.test(p)) ?? "solid";
  if (style === "none" || style === "hidden" || width <= 0) return null;
  const c = hex ? `rgb(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)})` : "rgb(0,0,0)";
  return {
    fill: { kind: "solid", color: c },
    width,
    dash: style === "dotted" ? [1, 1] : style === "dashed" ? [4, 3] : null,
    cap: "flat",
    join: "miter",
    head: null,
    tail: null,
    compound: style === "double" ? "dbl" : "sng",
  };
}

function emptyBody(): TextBody {
  return {
    insets: { l: 0, t: 0, r: 0, b: 0 },
    anchor: "t",
    anchorCenter: false,
    wrap: true,
    vertical: "horz",
    autofit: { kind: "none" },
    columns: { count: 1, spacing: 0 },
    rotation: 0,
    upright: false,
    paragraphs: [],
  };
}

const r = (v: number): string => String(Math.round(v * 100) / 100);
