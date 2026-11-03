import type {
  Effects,
  Fill,
  Frame,
  GroupElement,
  EmbeddedFontRef,
  ImageRef,
  Line,
  PictureElement,
  ShapeElement,
  SlideElement,
  SlideModel,
  TableCell,
  TableElement,
} from "@shared/types/slide-model";
import { css, schemeColor, systemColor } from "./color";
import { evaluateGeometry, geometryDef, type PresetTable } from "./geometry";
import { readChart } from "./chart";
import { layoutSmartArt } from "./smartart";
import { cellStyle, parseTableStyles, tableBackground, type TableFlags, type TableStyleTable } from "./table-style";
import { openPptx, relTarget, type PptxPackage } from "./package";
import { fillIn, miss, NO_EFFECTS, readEffects, readImage, readLine, themeStyle, type ThemeStyles } from "./style";
import { readTextBody, type TextCategory, type TextContext, type ThemeFonts } from "./text";
import { attr, child, children, descendants, isTrue, numAttr, path, type XmlElement } from "./xml";

export type PptxSlide = {
  /** 1-based, in presentation order, hidden slides included. */
  number: number;
  hidden: boolean;
  model: SlideModel;
  /** Constructs met and not drawn: what keeps this slide from being exact. */
  unsupported: Record<string, number>;
};

export type EmbeddedFont = EmbeddedFontRef;

export type PptxDeck = { width: number; height: number; slides: PptxSlide[]; fonts: EmbeddedFont[] };

/** What the reader needs from `resources/ooxml/`, loaded once by the caller. */
export type PptxResources = { presets: PresetTable; tableStyles: TableStyleTable };

/** Reads every slide of a `.pptx` into what `SlideView` paints. */
export function readPptxDeck(file: string, resources: PptxResources): PptxDeck {
  const { presets } = resources;
  const pkg = openPptx(file);
  const presPart = relTarget(pkg, "", "officeDocument") ?? "ppt/presentation.xml";
  const pres = pkg.xml(presPart);
  const size = path(pres, "p:sldSz");
  const width = numAttr(size, "cx", 9144000);
  const height = numAttr(size, "cy", 6858000);
  const defaultTextStyle = path(pres, "p:defaultTextStyle");
  const presRels = pkg.rels(presPart);

  const fonts: EmbeddedFont[] = [];
  for (const ef of children(path(pres, "p:embeddedFontLst"), "p:embeddedFont")) {
    const family = attr(child(ef, "p:font"), "typeface");
    if (!family) continue;
    for (const style of ["regular", "bold", "italic", "boldItalic"] as const) {
      const id = attr(child(ef, `p:${style}`), "r:id");
      const rel = id ? presRels.get(id) : undefined;
      if (rel && !rel.external) fonts.push({ family, style, part: rel.target });
    }
  }

  const themes = new Map<string, Theme>();
  const tableStyles = parseTableStyles(pkg.xml("ppt/tableStyles.xml"));
  const slides: PptxSlide[] = [];
  let number = 0;
  for (const sldId of children(path(pres, "p:sldIdLst"), "p:sldId")) {
    const rel = presRels.get(attr(sldId, "r:id") ?? "");
    if (!rel || rel.external) continue;
    number += 1;
    const unsupported = new Map<string, number>();
    const model = readSlide(pkg, rel.target, { width, height, defaultTextStyle, presets, themes, unsupported, number, tableStyles, builtinTableStyles: resources.tableStyles, fonts });
    slides.push({
      number,
      hidden: attr(pkg.xml(rel.target), "show") === "0",
      model,
      unsupported: Object.fromEntries(unsupported),
    });
  }
  return { width, height, slides, fonts };
}

type Theme = { scheme: Record<string, string>; fonts: ThemeFonts; styles: ThemeStyles };

function readTheme(pkg: PptxPackage, part: string | null, cache: Map<string, Theme>): Theme {
  const key = part ?? "";
  const cached = cache.get(key);
  if (cached) return cached;
  const root = part ? pkg.xml(part) : null;
  const elements = path(root, "a:themeElements");
  const scheme: Record<string, string> = {};
  for (const c of path(elements, "a:clrScheme")?.children ?? []) {
    const value = c.children[0];
    const system = value?.name === "a:sysClr" ? systemColor(value) : null;
    const hex = system
      ? [system.r, system.g, system.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")
      : attr(value, "val");
    if (hex) scheme[c.name.replace(/^a:/, "")] = hex;
  }
  const fontScheme = path(elements, "a:fontScheme");
  const face = (which: string, script: string): string =>
    attr(path(fontScheme, which, script), "typeface") ?? "";
  const fmt = path(elements, "a:fmtScheme");
  const theme: Theme = {
    scheme,
    fonts: {
      "+mj-lt": face("a:majorFont", "a:latin") || "Calibri Light",
      "+mn-lt": face("a:minorFont", "a:latin") || "Calibri",
      "+mj-ea": face("a:majorFont", "a:ea"),
      "+mn-ea": face("a:minorFont", "a:ea"),
      "+mj-cs": face("a:majorFont", "a:cs"),
      "+mn-cs": face("a:minorFont", "a:cs"),
    },
    styles: {
      fills: path(fmt, "a:fillStyleLst")?.children ?? [],
      bgFills: path(fmt, "a:bgFillStyleLst")?.children ?? [],
      lines: path(fmt, "a:lnStyleLst")?.children ?? [],
      effects: path(fmt, "a:effectStyleLst")?.children ?? [],
      part: part ?? "",
    },
  };
  cache.set(key, theme);
  return theme;
}

type DeckScope = {
  width: number;
  height: number;
  defaultTextStyle: XmlElement | null;
  presets: PresetTable;
  themes: Map<string, Theme>;
  unsupported: Map<string, number>;
  number: number;
  tableStyles: TableStyleTable;
  builtinTableStyles: TableStyleTable;
  fonts: EmbeddedFontRef[];
};

/** One of the three parts a slide is drawn from. `damaged`: it is in the
 *  package but won't parse, so the slide is drawn without it. */
type Level = { part: string; root: XmlElement | null; placeholders: Placeholder[]; damaged: boolean };
type Placeholder = { type: string; idx: string | null; el: XmlElement };

function level(pkg: PptxPackage, part: string | null): Level {
  const root = part ? pkg.xml(part) : null;
  // A slide, layout or master that is there but won't parse is drawn without
  // it — what the other two give, or the bare background — and the slide is
  // marked so the operator is told (owner, 2026-11-03): never an empty slide
  // in silence. Only these three: a broken `.vml` or chart part is common and
  // costs one shape.
  const damaged = part !== null && !root && pkg.has(part);
  const placeholders: Placeholder[] = [];
  const collect = (tree: XmlElement | null): void => {
    for (const c of tree?.children ?? []) {
      if (c.name === "p:grpSp") collect(c);
      const ph = phOf(c);
      if (ph) placeholders.push({ ...ph, el: c });
    }
  };
  collect(path(root, "p:cSld", "p:spTree"));
  return { part: part ?? "", root, placeholders, damaged };
}

function phOf(el: XmlElement): { type: string; idx: string | null } | null {
  const nv = el.children.find((c) => c.name.startsWith("p:nv"));
  const ph = path(nv, "p:nvPr", "p:ph");
  return ph ? { type: attr(ph, "type") ?? "obj", idx: attr(ph, "idx") } : null;
}

/** What a placeholder type inherits from on the master, which only has
 *  title, body and the footer family. */
function masterType(type: string): string {
  if (type === "title" || type === "ctrTitle") return "title";
  if (type === "dt" || type === "ftr" || type === "sldNum" || type === "hdr") return type;
  return "body";
}

function categoryOf(type: string): TextCategory {
  if (type === "title" || type === "ctrTitle") return "title";
  if (type === "dt" || type === "ftr" || type === "sldNum" || type === "hdr") return "other";
  return "body";
}

function findPlaceholder(lvl: Level, ph: { type: string; idx: string | null }, onMaster: boolean): XmlElement | null {
  if (onMaster) {
    const want = masterType(ph.type);
    return lvl.placeholders.find((p) => masterType(p.type) === want)?.el ?? null;
  }
  if (ph.idx !== null) {
    const byIdx = lvl.placeholders.find((p) => p.idx === ph.idx);
    if (byIdx) return byIdx.el;
  }
  const want = ph.type === "ctrTitle" ? ["ctrTitle", "title"] : ph.type === "subTitle" ? ["subTitle", "body"] : [ph.type];
  return lvl.placeholders.find((p) => want.includes(p.type))?.el ?? null;
}

type SlideScope = DeckScope & {
  pkg: PptxPackage;
  theme: Theme;
  colorMap: Record<string, string>;
  levels: [Level, Level, Level];
  txStyles: XmlElement | null;
  /** The slide's sound and video shapes set to «Hide during show», by id. */
  hiddenMedia: ReadonlySet<string>;
};

function readSlide(pkg: PptxPackage, slidePart: string, deck: DeckScope): SlideModel {
  const layoutPart = relTarget(pkg, slidePart, "slideLayout");
  const masterPart = layoutPart ? relTarget(pkg, layoutPart, "slideMaster") : null;
  const themePart = masterPart ? relTarget(pkg, masterPart, "theme") : null;
  const theme = readTheme(pkg, themePart, deck.themes);
  const levels: [Level, Level, Level] = [level(pkg, slidePart), level(pkg, layoutPart), level(pkg, masterPart)];
  const [slide, layout, master] = levels;

  const colorMap: Record<string, string> = { ...path(master.root, "p:clrMap")?.attrs };
  for (const lvl of [layout, slide]) {
    const override = path(lvl.root, "p:clrMapOvr", "a:overrideClrMapping");
    if (override) Object.assign(colorMap, override.attrs);
  }
  if (Object.keys(colorMap).length === 0) {
    Object.assign(colorMap, { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" });
  }

  // «Hide during show» lives in the timing tree, not on the shape: the media
  // node that plays it says `showWhenStopped="0"` and names it by id. The
  // legacy reader skips the same speaker icons (`fHide`).
  const hiddenMedia = new Set<string>();
  for (const node of descendants(path(slide.root, "p:timing"), "p:cMediaNode")) {
    const spid = attr(path(node, "p:tgtEl", "p:spTgt"), "spid");
    if (spid && !isTrue(attr(node, "showWhenStopped") ?? "1")) hiddenMedia.add(spid);
  }

  const scope: SlideScope = { ...deck, pkg, theme, colorMap, levels, txStyles: path(master.root, "p:txStyles"), hiddenMedia };
  const elements: SlideElement[] = [];
  const showMaster = (lvl: Level): boolean => attr(lvl.root, "showMasterSp") !== "0";
  if (master.root && showMaster(slide) && showMaster(layout)) elements.push(...readTree(path(master.root, "p:cSld", "p:spTree"), 2, scope));
  if (layout.root && showMaster(slide)) elements.push(...readTree(path(layout.root, "p:cSld", "p:spTree"), 1, scope));
  elements.push(...readTree(path(slide.root, "p:cSld", "p:spTree"), 0, scope));

  const model: SlideModel = { width: deck.width, height: deck.height, background: readBackground(scope), elements, fonts: deck.fonts };
  if (levels.some((lvl) => lvl.damaged)) model.damaged = true;
  return model;
}

function styleCtx(scope: SlideScope, part: string, groupFill?: Fill | null): TextContext {
  return {
    pkg: scope.pkg,
    colors: { scheme: scope.theme.scheme, map: scope.colorMap },
    part,
    theme: scope.theme.styles,
    unsupported: scope.unsupported,
    groupFill: groupFill ?? null,
    fonts: scope.theme.fonts,
    txStyles: scope.txStyles,
    defaultTextStyle: scope.defaultTextStyle,
    slideNumber: scope.number,
  };
}

function readBackground(scope: SlideScope): Fill | null {
  for (const lvl of scope.levels) {
    const bg = path(lvl.root, "p:cSld", "p:bg");
    if (!bg) continue;
    const ctx = styleCtx(scope, lvl.part);
    const pr = child(bg, "p:bgPr");
    if (pr) return fillIn(pr, ctx) ?? null;
    const ref = child(bg, "p:bgRef");
    if (ref) return themeStyle(ref, "fill", ctx).fill ?? null;
  }
  // No background anywhere: PowerPoint paints bg1, through the colour map
  // (black on a layout that maps bg1 to dk1).
  const bg1 = schemeColor("bg1", { scheme: scope.theme.scheme, map: scope.colorMap });
  return { kind: "solid", color: bg1 ? css(bg1) : "rgb(255,255,255)" };
}

/** How much a group's child space is stretched onto the slide: geometry is
 *  evaluated at the size it is DRAWN, as PowerPoint does — a group whose child
 *  space is 600 times smaller would otherwise draw 0.75 pt lines 600 times
 *  thicker than the shape. */
type Scale = { x: number; y: number };
const UNIT: Scale = { x: 1, y: 1 };

function readTree(tree: XmlElement | null, levelIndex: number, scope: SlideScope, groupFill?: Fill | null, scale: Scale = UNIT): SlideElement[] {
  const out: SlideElement[] = [];
  const part = scope.levels[levelIndex]!.part;
  for (const el of tree?.children ?? []) {
    const nv = el.children.find((c) => c.name.startsWith("p:nv"));
    if (isTrue(attr(child(nv, "p:cNvPr"), "hidden"))) continue;
    if (levelIndex === 0 && scope.hiddenMedia.has(attr(child(nv, "p:cNvPr"), "id") ?? "")) continue;
    // A layout's or master's placeholders are templates for the slide's own,
    // not content: they never show in the slide show.
    if (levelIndex > 0 && phOf(el)) continue;
    switch (el.name) {
      case "p:sp":
      case "p:cxnSp": {
        const shape = readShape(el, levelIndex, scope, groupFill, scale);
        if (shape) out.push(shape);
        break;
      }
      case "p:pic": {
        const pic = readPicture(el, levelIndex, scope, styleCtx(scope, part, groupFill), scale);
        if (pic) out.push(pic);
        break;
      }
      case "p:grpSp": {
        const group = readGroup(el, levelIndex, scope, groupFill, scale);
        if (group) out.push(group);
        break;
      }
      case "p:graphicFrame": {
        const frame = readGraphicFrame(el, levelIndex, scope, groupFill, scale);
        if (frame) out.push(frame);
        break;
      }
      case "p:contentPart":
        miss(scope, "ink");
        break;
      default:
        break;
    }
  }
  return out;
}

function readFrame(xfrm: XmlElement | null): Frame | null {
  if (!xfrm) return null;
  const off = child(xfrm, "a:off");
  const ext = child(xfrm, "a:ext");
  if (!off || !ext) return null;
  return {
    x: numAttr(off, "x", 0),
    y: numAttr(off, "y", 0),
    w: numAttr(ext, "cx", 0),
    h: numAttr(ext, "cy", 0),
    rot: numAttr(xfrm, "rot", 0) / 60000,
    flipH: isTrue(attr(xfrm, "flipH")),
    flipV: isTrue(attr(xfrm, "flipV")),
  };
}

/** An element and the part whose relationships its XML resolves against. */
type Link = { el: XmlElement; part: string };

/** The shape itself first, then the placeholders it inherits from. */
function inheritanceChain(el: XmlElement, levelIndex: number, scope: SlideScope): { chain: Link[]; type: string | null } {
  const own: Link = { el, part: scope.levels[levelIndex]!.part };
  const ph = phOf(el);
  if (!ph || levelIndex > 0) return { chain: [own], type: null };
  const [, layout, master] = scope.levels;
  const onLayout = findPlaceholder(layout, ph, false);
  const onMaster = findPlaceholder(master, onLayout ? (phOf(onLayout) ?? ph) : ph, true);
  const chain = [own];
  if (onLayout) chain.push({ el: onLayout, part: layout.part });
  if (onMaster) chain.push({ el: onMaster, part: master.part });
  return { chain, type: ph.type };
}

function firstIn(chain: Link[], ...names: string[]): XmlElement | null {
  for (const link of chain) {
    const found = path(link.el, ...names);
    if (found) return found;
  }
  return null;
}

function readShape(el: XmlElement, levelIndex: number, scope: SlideScope, groupFill: Fill | null | undefined, scale: Scale): ShapeElement | null {
  const { chain, type } = inheritanceChain(el, levelIndex, scope);
  const ctx = styleCtx(scope, scope.levels[levelIndex]!.part, groupFill);
  const frame = readFrame(firstIn(chain, "p:spPr", "a:xfrm"));
  if (!frame) {
    miss(scope, "shape:no-geometry");
    return null;
  }
  const geometry = shapeGeometry(chain, frame, scope, scale);

  // Placeholder chain: its own properties, then the layout's, then the master's,
  // then the shape style's references into the theme.
  const style = firstIn(chain, "p:style");
  const { fill: ownFill, line, effects, spPrs } = drawingProps(chain, ctx);
  const fill = isTrue(attr(el, "useBgFill")) ? ({ kind: "background" } as const) : ownFill;
  if (spPrs.some(({ pr }) => child(pr, "a:scene3d") || child(pr, "a:sp3d"))) miss(scope, "shape:3d");

  const txBody = child(el, "p:txBody");
  const hasText = txBody !== null && descendants(txBody, "a:t").some((t) => t.text !== "");
  const inheritedBodies = chain.slice(1).map((link) => child(link.el, "p:txBody")).filter((b): b is XmlElement => b !== null);
  const text = txBody && hasText
    ? readTextBody(txBody, inheritedBodies, type === null ? null : categoryOf(type), child(style, "a:fontRef"), ctx)
    : null;

  return { kind: "shape", frame, paths: geometry.paths, fill, line, effects, textRect: geometry.textRect, text };
}

/**
 * Fill, line and effects of a drawing through its inheritance chain, most
 * specific first, each link resolving its own relationships (a layout's
 * picture fill names its part through the layout's rels). A link's own style
 * references come right after its own properties: a slide shape's `fillRef`
 * beats the `noFill` of the layout placeholder it inherits from. Lines and
 * effects merge from the least specific up — the master's style, its
 * properties, the layout's, the shape's — each attribute on its own.
 */
function drawingProps(chain: Link[], ctx: TextContext): { fill: Fill | null; line: Line | null; effects: Effects; spPrs: { pr: XmlElement | null }[] } {
  const spPrs = chain.map((link) => ({ pr: child(link.el, "p:spPr"), style: child(link.el, "p:style"), ctx: { ...ctx, part: link.part } }));
  let fill: Fill | null | undefined;
  for (const { pr, style, ctx: linkCtx } of spPrs) {
    fill = fillIn(pr, linkCtx);
    if (fill === undefined && style) fill = themeStyle(child(style, "a:fillRef"), "fill", linkCtx).fill;
    if (fill !== undefined) break;
  }
  let line: Line | null = null;
  let effects: Effects = NO_EFFECTS;
  for (const { pr, style, ctx: linkCtx } of [...spPrs].reverse()) {
    if (style) {
      const ref = themeStyle(child(style, "a:lnRef"), "line", linkCtx);
      if (ref.line !== undefined) line = ref.line;
      effects = themeStyle(child(style, "a:effectRef"), "effect", linkCtx).effects ?? effects;
    }
    const ln = child(pr, "a:ln");
    if (ln) line = readLine(ln, linkCtx, line);
    effects = readEffects(pr, linkCtx, effects);
  }
  return { fill: fill ?? null, line, effects, spPrs };
}

function shapeGeometry(chain: Link[], frame: Frame, scope: SlideScope, scale: Scale): { paths: ShapeElement["paths"]; textRect: ShapeElement["textRect"] } {
  const w = frame.w * scale.x;
  const h = frame.h * scale.y;
  const prst = firstIn(chain, "p:spPr", "a:prstGeom");
  const cust = firstIn(chain, "p:spPr", "a:custGeom");
  const adjust = (geom: XmlElement | null): [string, string][] =>
    children(child(geom, "a:avLst"), "a:gd").map((gd) => [attr(gd, "name") ?? "", attr(gd, "fmla") ?? "val 0"]);
  if (cust) return evaluateGeometry(geometryDef(cust), w, h);
  const name = attr(prst, "prst") ?? "rect";
  const def = scope.presets.get(name);
  if (!def) {
    miss(scope, `geometry:${name}`);
    return evaluateGeometry(scope.presets.get("rect")!, w, h);
  }
  return evaluateGeometry(def, w, h, adjust(prst));
}

function readPicture(el: XmlElement, levelIndex: number, scope: SlideScope, ctx: TextContext, scale: Scale, at?: Frame): PictureElement | null {
  const { chain } = inheritanceChain(el, levelIndex, scope);
  const frame = at ?? readFrame(firstIn(chain, "p:spPr", "a:xfrm"));
  const blipFill = child(el, "p:blipFill");
  if (!frame || !blipFill) return null;
  const image = readImage(blipFill, ctx);
  if (!image) return null;
  if (child(blipFill, "a:tile")) miss(scope, "picture:tile");
  // A picture placeholder inherits its outline (often a custom one) along
  // with its place.
  const geometryName = firstIn(chain, "p:spPr", "a:custGeom") ? "custom" : (attr(firstIn(chain, "p:spPr", "a:prstGeom"), "prst") ?? "rect");
  const clip = geometryName === "rect" ? null : shapeGeometry(chain, frame, scope, scale).paths;
  const { fill, line, effects } = drawingProps(chain, ctx);
  return { kind: "picture", frame, image, fill, clip, line, effects };
}

function readGroup(el: XmlElement, levelIndex: number, scope: SlideScope, groupFill: Fill | null | undefined, scale: Scale): GroupElement | null {
  const xfrm = path(el, "p:grpSpPr", "a:xfrm");
  const frame = readFrame(xfrm);
  if (!frame) return null;
  const chOff = child(xfrm, "a:chOff");
  const chExt = child(xfrm, "a:chExt");
  const ctx = styleCtx(scope, scope.levels[levelIndex]!.part, groupFill);
  const own = fillIn(child(el, "p:grpSpPr"), ctx);
  const childFrame = {
    x: numAttr(chOff, "x", frame.x),
    y: numAttr(chOff, "y", frame.y),
    w: numAttr(chExt, "cx", frame.w) || 1,
    h: numAttr(chExt, "cy", frame.h) || 1,
  };
  const inner = { x: (scale.x * frame.w) / childFrame.w, y: (scale.y * frame.h) / childFrame.h };
  return { kind: "group", frame, childFrame, children: readTree(el, levelIndex, scope, own === undefined ? groupFill : own, inner) };
}

const URI_TABLE = "http://schemas.openxmlformats.org/drawingml/2006/table";
const URI_CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const URI_DIAGRAM = "http://schemas.openxmlformats.org/drawingml/2006/diagram";
const URI_OLE = "http://schemas.openxmlformats.org/presentationml/2006/ole";

function readGraphicFrame(el: XmlElement, levelIndex: number, scope: SlideScope, groupFill: Fill | null | undefined, scale: Scale): SlideElement | null {
  const { chain } = inheritanceChain(el, levelIndex, scope);
  const frame = readFrame(firstIn(chain, "p:xfrm"));
  const data = path(el, "a:graphic", "a:graphicData");
  if (!frame || !data) return null;
  const uri = attr(data, "uri");
  const ctx = styleCtx(scope, scope.levels[levelIndex]!.part, groupFill);
  if (uri === URI_TABLE) return readTable(child(data, "a:tbl"), frame, ctx, scope);
  if (uri === URI_CHART) {
    const rel = scope.pkg.rels(scope.levels[levelIndex]!.part).get(attr(child(data, "c:chart"), "r:id") ?? "");
    const chart = rel && !rel.external ? readChart(rel.target, { ...ctx, part: rel.target }) : null;
    if (!chart || chart.kind === "unsupported") miss(scope, "chart");
    return chart ? { kind: "chart", frame, chart } : null;
  }
  if (uri === URI_DIAGRAM) return readDiagram(data, frame, levelIndex, scope, scale);
  if (uri === URI_OLE) {
    // The object's last rendering, kept as a picture next to it.
    const pic = descendants(data, "p:pic")[0];
    const image = pic ? readPicture(pic, levelIndex, scope, ctx, scale, frame) : null;
    if (image) return image;
    const preview = olePreview(descendants(data, "p:oleObj")[0] ?? null, levelIndex, scope);
    if (preview) return { kind: "picture", frame, image: preview, fill: null, clip: null, line: null, effects: NO_EFFECTS };
    miss(scope, "ole:no-picture");
    return null;
  }
  miss(scope, `graphic:${uri ?? "none"}`);
  return null;
}

/**
 * An OLE object saved without a `p:pic` (PowerPoint 2007 and older) keeps its
 * last rendering in the slide's VML drawing: the shape whose id is the
 * object's `spid`, through its `v:imagedata`.
 */
function olePreview(ole: XmlElement | null, levelIndex: number, scope: SlideScope): ImageRef | null {
  const spid = attr(ole, "spid");
  if (!spid) return null;
  const part = scope.levels[levelIndex]!.part;
  for (const rel of scope.pkg.rels(part).values()) {
    if (rel.type !== "vmlDrawing" || rel.external) continue;
    const shape = descendants(scope.pkg.xml(rel.target), "v:shape").find((s) => attr(s, "id") === spid);
    const relid = attr(descendants(shape, "v:imagedata")[0], "o:relid");
    const target = relid ? scope.pkg.rels(rel.target).get(relid) : undefined;
    if (!target || target.external) continue;
    return { part: target.target, crop: null, fill: null, alpha: 1, effects: [] };
  }
  return null;
}

/**
 * SmartArt as PowerPoint last drew it: the `dsp:drawing` part it saves next to
 * the diagram, plain shapes in the frame's space. A diagram saved without one
 * (other tools; or an empty one, which PowerPoint re-lays out too) is laid out
 * here from its parts (`smartart.ts`), still counted as a miss: that layout is
 * an approximation.
 */
function readDiagram(data: XmlElement, frame: Frame, levelIndex: number, scope: SlideScope, scale: Scale): SlideElement | null {
  const part = scope.levels[levelIndex]!.part;
  const rels = scope.pkg.rels(part);
  const dm = rels.get(attr(child(data, "dgm:relIds"), "r:dm") ?? "");
  let drawingPart: string | null = null;
  if (dm && !dm.external) {
    const ext = descendants(scope.pkg.xml(dm.target), "dsp:dataModelExt")[0];
    const rel = rels.get(attr(ext, "relId") ?? "");
    if (rel && !rel.external) drawingPart = rel.target;
  }
  if (!drawingPart) {
    for (const r of rels.values()) if (r.type === "diagramDrawing" && !r.external) drawingPart = r.target;
  }
  // The part's root IS `dsp:drawing`.
  const tree = drawingPart ? path(scope.pkg.xml(drawingPart), "dsp:spTree") : null;
  if (!tree || !drawingPart || !tree.children.some((c) => c.name !== "dsp:nvGrpSpPr" && c.name !== "dsp:grpSpPr")) {
    miss(scope, "smartart:no-drawing");
    const partOf = (key: string): string | null => {
      const rel = rels.get(attr(child(data, "dgm:relIds"), key) ?? "");
      return rel && !rel.external ? rel.target : null;
    };
    const xml = (key: string): XmlElement | null => scope.pkg.xml(partOf(key) ?? "");
    const parts = { data: xml("r:dm"), layout: xml("r:lo"), style: xml("r:qs"), colors: xml("r:cs"), dataPart: partOf("r:dm") ?? part };
    return layoutSmartArt(parts, frame, styleCtx(scope, part), scope.presets);
  }
  // The drawing's shapes use `dsp:` names for the same structure; read them as
  // slide shapes against the drawing part's own relationships.
  const asSlide = renameDsp(tree);
  const drawingScope: SlideScope = {
    ...scope,
    levels: [{ part: drawingPart, root: null, placeholders: [], damaged: false }, scope.levels[1], scope.levels[2]],
  };
  return {
    kind: "group",
    frame,
    childFrame: { x: 0, y: 0, w: frame.w || 1, h: frame.h || 1 },
    children: readTree(asSlide, 0, drawingScope, null, scale),
  };
}

function renameDsp(el: XmlElement): XmlElement {
  const name = el.name.startsWith("dsp:") ? `p:${el.name.slice(4)}` : el.name;
  // `dsp:txXfrm` is where the text goes when it doesn't fill the shape.
  return { ...el, name, children: el.children.map(renameDsp) };
}

function readTable(tbl: XmlElement | null, frame: Frame, ctx: TextContext, scope: SlideScope): TableElement | null {
  if (!tbl) return null;
  const tblPr = child(tbl, "a:tblPr");
  const styleId = path(tblPr, "a:tableStyleId")?.text.trim().toUpperCase() ?? null;
  const style = styleId ? (scope.tableStyles.get(styleId) ?? scope.builtinTableStyles.get(styleId) ?? null) : null;
  if (styleId && !style) miss(scope, "table:style-missing");
  const flags: TableFlags = {
    firstRow: isTrue(attr(tblPr, "firstRow")),
    lastRow: isTrue(attr(tblPr, "lastRow")),
    firstCol: isTrue(attr(tblPr, "firstCol")),
    lastCol: isTrue(attr(tblPr, "lastCol")),
    bandRow: isTrue(attr(tblPr, "bandRow")),
    bandCol: isTrue(attr(tblPr, "bandCol")),
  };
  const columns = children(child(tbl, "a:tblGrid"), "a:gridCol").map((c) => numAttr(c, "w", 0));
  const trs = children(tbl, "a:tr");
  const rowCount = trs.length;
  const colCount = columns.length;
  const rows = trs.map((tr, r) => ({
    height: numAttr(tr, "h", 0),
    cells: children(tr, "a:tc").map((tc, c): TableCell => {
      const pr = child(tc, "a:tcPr");
      const merged = isTrue(attr(tc, "hMerge")) || isTrue(attr(tc, "vMerge"));
      const styled = style ? cellStyle(style, r, c, rowCount, colCount, flags, ctx) : null;
      // The cell's own properties beat the table style, edge by edge.
      const border = (own: string, key: "l" | "t" | "r" | "b"): Line | null => {
        const ln = child(pr, own);
        if (ln) return readLine(ln, ctx, null);
        return styled?.borders[key] ?? null;
      };
      const own = fillIn(pr, ctx);
      const txBody = child(tc, "a:txBody") ?? { name: "a:txBody", attrs: {}, children: [], text: "" };
      // The style's text (bold header, white on accent…) as the lowest list
      // style the cell's paragraphs inherit.
      const inherited: XmlElement[] = styled?.text
        ? [{ name: "a:txBody", attrs: {}, text: "", children: [{ name: "a:lstStyle", attrs: {}, text: "", children: Array.from({ length: 9 }, (_, k) => ({ name: `a:lvl${k + 1}pPr`, attrs: {}, text: "", children: [styled.text!] })) }] }]
        : [];
      const body = readTextBody(txBody, inherited, null, null, ctx);
      body.insets = {
        l: numAttr(pr, "marL", 91440),
        r: numAttr(pr, "marR", 91440),
        t: numAttr(pr, "marT", 45720),
        b: numAttr(pr, "marB", 45720),
      };
      const anchor = attr(pr, "anchor");
      body.anchor = anchor === "ctr" || anchor === "b" ? anchor : "t";
      return {
        gridSpan: merged ? 0 : numAttr(tc, "gridSpan", 1),
        rowSpan: merged ? 0 : numAttr(tc, "rowSpan", 1),
        fill: own !== undefined ? own : (styled?.fill ?? null),
        borders: { l: border("a:lnL", "l"), t: border("a:lnT", "t"), r: border("a:lnR", "r"), b: border("a:lnB", "b") },
        text: body,
      };
    }),
  }));
  return { kind: "table", frame, background: style ? tableBackground(style, ctx) : null, columns, rows };
}
