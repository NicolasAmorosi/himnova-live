import type { Fill, Line } from "@shared/types/slide-model";
import type {
  Chart3D,
  ChartAxis,
  ChartBox,
  ChartDataLabel,
  ChartFont,
  ChartGrouping,
  ChartLayout,
  ChartLegend,
  ChartMarker,
  ChartModel,
  ChartPlot,
  ChartPoint,
  ChartSeries,
  ChartText,
  ChartTick,
  ChartTitle,
  ChartValues,
} from "@shared/types/slide-chart";
import { colorIn, css, resolveColor, type Rgba } from "./color";
import { fillIn, miss, NO_EFFECTS, readEffects, readFill, readLine, type StyleContext } from "./style";
import type { TextContext } from "./text";
import { attr, child, children, descendants, isTrue, numAttr, path, type XmlElement } from "./xml";

/**
 * A chart part (`c:chartSpace`) as `SlideChart` draws it, from the values
 * PowerPoint cached in the part — the embedded workbook is never opened.
 *
 * What the file leaves unsaid comes from the chart style (`c:style`, 1..48):
 * Office 2007's gallery, eight columns (grey, the six accents in turn, or one
 * accent faded per series) by six rows (flat, outlined, gradient + shadow, …),
 * each painting with the theme's style matrix. Charts saved by Office 2013 and
 * later spell every colour out in `c:spPr` and need none of it.
 */
export function readChart(part: string, ctx: TextContext): ChartModel {
  // A chart part we can't make sense of costs the chart, not the slide.
  try {
    return readChartSpace(part, ctx);
  } catch {
    return { kind: "unsupported", type: "unreadable" };
  }
}

function readChartSpace(part: string, ctx: TextContext): ChartModel {
  const space = ctx.pkg.xml(part);
  const chart = child(space, "c:chart");
  const plotArea = child(chart, "c:plotArea");
  if (!space || !chart || !plotArea) return { kind: "unsupported", type: "unknown" };

  const plotEls = plotArea.children.filter((c) => c.name.startsWith("c:") && c.name.endsWith("Chart"));
  if (plotEls.length === 0) return { kind: "unsupported", type: "empty" };
  // What is drawn only approximately: a pie or scatter combined with other
  // plots, a log scale (drawn linear), and the plot types drawn as their
  // nearest kin.
  const isPie = (p: XmlElement): boolean => p.name === "c:pieChart" || p.name === "c:doughnutChart";
  if (plotEls.some(isPie) && plotEls.length > 1) miss(ctx, "chart:pieCombo");
  if (plotEls.some((p) => p.name === "c:scatterChart") && plotEls.length > 1) miss(ctx, "chart:scatterCombo");
  const valAxes = children(plotArea, "c:valAx");
  if (valAxes.some((a) => child(child(a, "c:scaling"), "c:logBase"))) miss(ctx, "chart:logAxis");
  for (const p of plotEls) if (!DRAWN.has(p.name)) miss(ctx, `chart:${p.name.slice(2)}`);

  // Drawn without: shapes drawn over the chart, trend lines, error bars, a
  // data table.
  if (child(space, "c:userShapes")) miss(ctx, "chart:userShapes");
  for (const what of ["c:trendline", "c:errBars", "c:dTable"]) {
    if (descendants(plotArea, what).length) miss(ctx, `chart:${what.slice(2)}`);
  }
  const style = Math.min(48, Math.max(1, numAttr(child(space, "c:style"), "val", 2)));
  const cx: ChartContext = {
    ...withOverride(part, space, ctx),
    row: Math.floor((style - 1) / 8),
    col: (style - 1) % 8,
    absent: !madeBy2007(ctx),
  };

  const textColor = scheme(cx.row === 5 ? "lt1" : "tx1", [], cx);
  const base: ChartFont = {
    face: cx.fonts["+mn-lt"] || "Calibri",
    size: 10,
    bold: false,
    italic: false,
    underline: false,
    color: css(textColor),
  };
  const font = readFont(child(space, "c:txPr"), base, cx);

  const plots = plotEls.map((p) => readPlot(p, font, cx));
  const allSeries = plots.flatMap((p) => p.series);
  const serEls = plotEls.flatMap((p) => children(p, "c:ser"));
  const categories =
    serEls.map((s) => readValues(child(s, "c:cat"))).find((v) => v !== null) ??
    // No categories cached: Office numbers them 1, 2, 3, …
    { values: Array.from({ length: Math.max(0, ...allSeries.map((s) => s.values.values.length)) }, (_, i) => i + 1), format: "General" };

  // The automatic title: the series' name when the chart has only one.
  const titleEl = child(chart, "c:title");
  const autoDeleted = flag(child(chart, "c:autoTitleDeleted"), cx.absent);
  const autoTitle = allSeries.length === 1 ? (allSeries[0]?.name ?? "") : "";
  const title = titleEl
    ? readTitle(titleEl, { ...font, size: font.size * TITLE_SCALE, bold: true }, autoTitle || "Chart Title", cx)
    : !autoDeleted && autoTitle && plots.some((p) => p.kind === "pie")
      ? readTitle(null, { ...font, size: font.size * TITLE_SCALE, bold: true }, autoTitle, cx)
      : null;

  const pie = plots.every((p) => p.kind === "pie");
  const scatter = plots.some((p) => p.kind === "scatter" || p.kind === "bubble");
  // The first plot's axes are the primary ones; a plot on any other axis is
  // on the secondary scale (its category axis is the primary's, as Office
  // draws a combo).
  const axIds = (p: XmlElement): string[] => children(p, "c:axId").map((a) => attr(a, "val") ?? "");
  const primary = new Set(axIds(plotEls[0]!));
  // (An axis no plot names still serves, as before.)
  const own = (els: XmlElement[], ids: Set<string>): XmlElement[] => {
    const mine = els.filter((a) => ids.has(attr(child(a, "c:axId"), "val") ?? ""));
    return mine.length ? mine : els;
  };
  const mainVal = own(valAxes, primary);
  const catEl = own([...children(plotArea, "c:catAx"), ...children(plotArea, "c:dateAx")], primary)[0] ?? (scatter ? (mainVal[0] ?? null) : null);
  const valEl = scatter ? (mainVal[1] ?? null) : (mainVal[0] ?? null);
  const onSecondary = plotEls.flatMap((p, i) => (axIds(p).some((id) => !primary.has(id)) ? [i] : []));
  const secondIds = new Set(onSecondary.length ? axIds(plotEls[onSecondary[0]!]!).filter((id) => !primary.has(id)) : []);
  const secondEl = valAxes.find((a) => secondIds.has(attr(child(a, "c:axId"), "val") ?? ""));
  const areaOnly = plots.every((p) => p.kind === "area");

  return {
    kind: "chart",
    space: box(child(space, "c:spPr"), spaceDefaults(cx), cx),
    font,
    title,
    legend: readLegend(child(chart, "c:legend"), font, cx),
    plotArea: {
      ...box(child(plotArea, "c:spPr"), plotEls.some((p) => p.name.endsWith("3DChart")) ? EMPTY_BOX : plotDefaults(cx), cx),
      layout: readLayout(child(plotArea, "c:layout")),
    },
    plots,
    categories,
    categoryGroups: children(
      serEls.map((s) => path(s, "c:cat", "c:multiLvlStrRef", "c:multiLvlStrCache")).find((c) => c !== null) ?? null,
      "c:lvl",
    )
      .slice(1)
      .map((lvl) => children(lvl, "c:pt").map((pt) => ({ text: child(pt, "c:v")?.text ?? "", start: numAttr(pt, "idx", 0) }))),
    categoryAxis: pie || !catEl ? null : readAxis(catEl, scatter ? "value" : catEl.name === "c:dateAx" ? "date" : "category", font, areaOnly, cx),
    valueAxis: pie || !valEl ? null : readAxis(valEl, "value", font, areaOnly, cx),
    secondary: !pie && secondEl ? { plots: onSecondary, axis: readAxis(secondEl, "value", font, areaOnly, cx) } : null,
    date1904: flag(child(space, "c:date1904"), false),
    view3D: plotEls.some((p) => p.name.endsWith("3DChart") || p.name === "c:surfaceChart") ? read3D(chart, plotEls[0]!, cx) : null,
  };
}

/** Drawn as themselves; any other plot is drawn as its nearest kin (`readPlot`). */
const DRAWN = new Set([
  ...["c:barChart", "c:lineChart", "c:areaChart", "c:pieChart", "c:doughnutChart", "c:scatterChart", "c:bubbleChart", "c:radarChart"],
  ...["c:bar3DChart", "c:line3DChart", "c:area3DChart", "c:pie3DChart", "c:surfaceChart", "c:surface3DChart"],
]);

/**
 * How a 3-D chart is seen. A rotation the file leaves out is Office's own
 * default (15° up, 20° round; a pie tilted 30°) in a file PowerPoint 2007
 * wrote, the schema's 0 in any other — measured: an AASCU 2007 deck's column
 * chart with a bare `c:view3D` shows its tops and sides, the Större
 * template's surface faces front. A contour (`surfaceChart`) is a surface
 * seen from straight above.
 */
function read3D(chart: XmlElement, plot: XmlElement, ctx: ChartContext): Chart3D {
  const v = child(chart, "c:view3D");
  const pie = plot.name === "c:pie3DChart";
  const contour = plot.name === "c:surfaceChart";
  const angle = (name: string, fallback: number): number => {
    const a = attr(child(v, name), "val");
    return a !== null && Number.isFinite(Number(a)) ? Number(a) : ctx.absent ? 0 : fallback;
  };
  const shape = attr(child(plot, "c:shape"), "val");
  const wall = (name: string): ChartBox => box(path(chart, name, "c:spPr"), plotDefaults(ctx), ctx);
  return {
    rotX: contour ? 90 : angle("c:rotX", pie ? 30 : 15),
    rotY: contour ? 0 : angle("c:rotY", pie ? 0 : 20),
    rightAngles: !pie && !contour && flag(child(v, "c:rAngAx"), ctx.absent),
    fov: contour ? 0 : numAttr(child(v, "c:perspective"), "val", 30) / 2,
    depth: Math.max(20, numAttr(child(v, "c:depthPercent"), "val", 100)),
    gapDepth: numAttr(child(plot, "c:gapDepth"), "val", 150),
    shape: shape === "cylinder" || shape === "cone" || shape === "coneToMax" || shape === "pyramid" || shape === "pyramidToMax" ? shape : "box",
    floor: wall("c:floor"),
    sideWall: wall("c:sideWall"),
    backWall: wall("c:backWall"),
  };
}

/** Office 2007's chart title is 1.2 times the chart's text size, bold. */
const TITLE_SCALE = 1.2;

type ChartContext = TextContext & {
  /** The chart style's gallery row (0..5) and column (0..7). */
  row: number;
  col: number;
  /**
   * What a missing `overlay`, `delete`, `varyColors`, `autoTitleDeleted` or
   * data label part (`showVal`, …) means: false in a file PowerPoint 2007
   * wrote, the schema's true in any other — PowerPoint reads them so
   * (measured: `cht-legend-props` overlays its legend, the 2007 AASCU decks
   * don't; the Större template's bare `<c:dLbls/>` shows series, category,
   * value, percent and key), and so does LibreOffice (`bMSO2007Doc`).
   */
  absent: boolean;
};

/**
 * PowerPoint 2007 wrote the file: `AppVersion` 12 AND an `Application` of
 * Microsoft's, as LibreOffice tells them apart. The Större template says 12
 * with no application, and PowerPoint reads it as a later file: its bare
 * `c:view3D` shows a surface square on, its bare `c:dLbls` every label part.
 */
function madeBy2007(ctx: TextContext): boolean {
  const app = ctx.pkg.xml("docProps/app.xml");
  return /^12\./.test(child(app, "AppVersion")?.text ?? "") && /^microsoft/i.test(child(app, "Application")?.text ?? "");
}

/** CT_Boolean: an element with no `val` means true. */
function flag(el: XmlElement | null, fallback: boolean): boolean {
  if (!el) return fallback;
  const v = attr(el, "val");
  return v === null ? true : isTrue(v);
}

const node = (name: string, attrs: Record<string, string> = {}, kids: XmlElement[] = []): XmlElement => ({ name, attrs, children: kids, text: "" });

function scheme(name: string, mods: [string, number][], ctx: ChartContext): Rgba {
  const el = node("a:schemeClr", { val: name }, mods.map(([m, v]) => node(`a:${m}`, { val: String(Math.round(v)) })));
  return resolveColor(el, ctx.colors) ?? { r: 0, g: 0, b: 0, a: 1 };
}

function hex(c: Rgba): string {
  const h = (x: number): string => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0");
  return `${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * What the chart is painted against: the slide's theme, through the chart's
 * own colour map (`c:clrMapOvr`) and its theme override part — which can
 * change the colours, the fonts and the style matrix alike (a chart pasted
 * from Excel keeps its workbook's theme that way).
 */
function withOverride(part: string, space: XmlElement, ctx: TextContext): TextContext {
  let out: TextContext = ctx;
  const rel = [...ctx.pkg.rels(part).values()].find((r) => r.type === "themeOverride" && !r.external);
  const override = rel ? ctx.pkg.xml(rel.target) : null;
  const clrScheme = child(override, "a:clrScheme");
  if (clrScheme) {
    const scheme: Record<string, string> = { ...out.colors.scheme };
    for (const c of clrScheme.children) {
      const rgb = colorIn(c, out.colors);
      if (rgb) scheme[c.name.slice(2)] = hex(rgb);
    }
    out = { ...out, colors: { ...out.colors, scheme } };
  }
  const fontScheme = child(override, "a:fontScheme");
  if (fontScheme) {
    const face = (which: string, script: string, fallback: string): string => attr(path(fontScheme, which, script), "typeface") || fallback;
    const f = out.fonts;
    out = {
      ...out,
      fonts: {
        "+mj-lt": face("a:majorFont", "a:latin", f["+mj-lt"]),
        "+mn-lt": face("a:minorFont", "a:latin", f["+mn-lt"]),
        "+mj-ea": face("a:majorFont", "a:ea", f["+mj-ea"]),
        "+mn-ea": face("a:minorFont", "a:ea", f["+mn-ea"]),
        "+mj-cs": face("a:majorFont", "a:cs", f["+mj-cs"]),
        "+mn-cs": face("a:minorFont", "a:cs", f["+mn-cs"]),
      },
    };
  }
  const fmt = child(override, "a:fmtScheme");
  if (fmt && rel) {
    const list = (name: string): XmlElement[] => child(fmt, name)?.children ?? [];
    out = {
      ...out,
      theme: { fills: list("a:fillStyleLst"), bgFills: list("a:bgFillStyleLst"), lines: list("a:lnStyleLst"), effects: list("a:effectStyleLst"), part: rel.target },
    };
  }
  const mapOvr = child(space, "c:clrMapOvr");
  if (mapOvr) out = { ...out, colors: { ...out.colors, map: { ...out.colors.map, ...mapOvr.attrs } } };
  return out;
}

// ── Fonts and text ──────────────────────────────────────────────────────────

/** A `c:txPr` over a font: its first paragraph's `defRPr`. */
function readFont(txPr: XmlElement | null, base: ChartFont, ctx: ChartContext): ChartFont {
  return applyRPr(path(txPr, "a:p", "a:pPr", "a:defRPr"), base, ctx);
}

function applyRPr(rPr: XmlElement | null, base: ChartFont, ctx: ChartContext): ChartFont {
  if (!rPr) return base;
  const fill = fillIn(rPr, ctx);
  const latin = attr(child(rPr, "a:latin"), "typeface");
  const face = latin ? (latin.startsWith("+") ? (ctx.fonts[latin as keyof typeof ctx.fonts] ?? base.face) : latin) : base.face;
  const b = attr(rPr, "b");
  const i = attr(rPr, "i");
  const u = attr(rPr, "u");
  return {
    face: face || base.face,
    size: numAttr(rPr, "sz", base.size * 100) / 100,
    bold: b === null ? base.bold : isTrue(b),
    italic: i === null ? base.italic : isTrue(i),
    underline: u === null ? base.underline : u !== "none",
    color: fill === undefined ? base.color : fill === null ? "transparent" : fillColor(fill),
  };
}

function fillColor(fill: Fill): string {
  if (fill.kind === "solid") return fill.color;
  if ((fill.kind === "linear" || fill.kind === "path") && fill.stops[0]) return fill.stops[0].color;
  if (fill.kind === "pattern") return fill.fg;
  return "black";
}

/** `c:rich`: paragraphs of runs; a line break starts a new paragraph. A field
 *  in `fields` (`CELLRANGE`: the label's cell) reads as its cached value. */
function readRich(rich: XmlElement, base: ChartFont, ctx: ChartContext, fields: Record<string, string> = {}): ChartText {
  const out: ChartText = [];
  const paraFont = readFont(rich, base, ctx);
  for (const p of children(rich, "a:p")) {
    const pPr = child(p, "a:pPr");
    const algn = attr(pPr, "algn");
    const align = algn === "l" || algn === "r" ? algn : "ctr";
    const pFont = applyRPr(child(pPr, "a:defRPr"), paraFont, ctx);
    let runs: ChartText[number]["runs"] = [];
    for (const r of p.children) {
      if (r.name === "a:br") {
        out.push({ align, runs });
        runs = [];
      } else if (r.name === "a:r" || r.name === "a:fld") {
        const text = fields[attr(r, "type") ?? ""] ?? child(r, "a:t")?.text ?? "";
        if (text) runs.push({ text, font: applyRPr(child(r, "a:rPr"), pFont, ctx) });
      }
    }
    out.push({ align, runs: runs.length ? runs : [{ text: "", font: applyRPr(child(p, "a:endParaRPr"), pFont, ctx) }] });
  }
  return out;
}

function stringFrom(el: XmlElement | null): string | null {
  if (!el) return null;
  const v = child(el, "c:v");
  if (v) return v.text;
  const cache = path(el, "c:strRef", "c:strCache") ?? child(el, "c:strLit");
  const pts = children(cache, "c:pt");
  return pts.length ? pts.map((p) => child(p, "c:v")?.text ?? "").join(" ") : null;
}

/** A title; with no element, the automatic one (series name), which never overlays. */
function readTitle(el: XmlElement | null, base: ChartFont, auto: string, ctx: ChartContext): ChartTitle | null {
  const font = readFont(child(el, "c:txPr"), base, ctx);
  const rich = path(el, "c:tx", "c:rich");
  const text: ChartText = rich
    ? readRich(rich, font, ctx)
    : [{ align: "ctr", runs: [{ text: stringFrom(child(el, "c:tx")) ?? auto, font }] }];
  if (!text.some((p) => p.runs.some((r) => r.text))) return null;
  const rot = attr(path(el, "c:txPr", "a:bodyPr") ?? (rich ? child(rich, "a:bodyPr") : null), "rot");
  const rotation = rot === null ? null : Number(rot) / 60000;
  return {
    ...box(child(el, "c:spPr"), EMPTY_BOX, ctx),
    text,
    overlay: el ? flag(child(el, "c:overlay"), ctx.absent) : false,
    layout: readLayout(child(el, "c:layout")),
    rotation: rotation !== null && Number.isFinite(rotation) && Math.abs(rotation) <= 90 ? rotation : null,
  };
}

// ── Boxes and layout ────────────────────────────────────────────────────────

const EMPTY_BOX: ChartBox = { fill: null, line: null, effects: NO_EFFECTS };

/** A `c:spPr` over the style's defaults: what it names wins. */
function box(spPr: XmlElement | null, defaults: ChartBox, ctx: ChartContext): ChartBox {
  if (!spPr) return defaults;
  const fill = fillIn(spPr, ctx);
  return {
    fill: fill === undefined ? defaults.fill : fill,
    line: readLine(child(spPr, "a:ln"), ctx, defaults.line),
    effects: readEffects(spPr, ctx, defaults.effects),
  };
}

function solidLine(color: Rgba, width = 9525): Line {
  return { fill: { kind: "solid", color: css(color) }, width, dash: null, cap: "flat", join: "round", head: null, tail: null, compound: "sng" };
}

/** PowerPoint's chart area is transparent and unframed unless the style is
 *  one of the dark ones (41..48). */
function spaceDefaults(ctx: ChartContext): ChartBox {
  return ctx.row === 5 ? { fill: { kind: "solid", color: css(scheme("dk1", [], ctx)) }, line: null, effects: NO_EFFECTS } : EMPTY_BOX;
}

/** Rows 33..40 shade the plot area. */
function plotDefaults(ctx: ChartContext): ChartBox {
  if (ctx.row === 4) {
    const c = ctx.col <= 1 ? scheme("dk1", [["tint", 20000]], ctx) : scheme(`accent${ctx.col - 1}`, [["tint", 20000]], ctx);
    return { fill: { kind: "solid", color: css(c) }, line: null, effects: NO_EFFECTS };
  }
  if (ctx.row === 5) return { fill: { kind: "solid", color: css(scheme("dk1", [["tint", 95000]], ctx)) }, line: null, effects: NO_EFFECTS };
  return EMPTY_BOX;
}

function readLayout(el: XmlElement | null): ChartLayout | null {
  const m = child(el, "c:manualLayout");
  if (!m) return null;
  // `factor` (the default mode) moves the automatic position rather than
  // replacing it: not modelled, the automatic layout stands.
  const edge = (mode: string): boolean => attr(child(m, mode), "val") === "edge";
  const num = (name: string): number | null => {
    const v = attr(child(m, name), "val");
    return v === null || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  const x = edge("c:xMode") ? num("c:x") : null;
  const y = edge("c:yMode") ? num("c:y") : null;
  const w = attr(child(m, "c:wMode"), "val") === "edge" ? null : num("c:w");
  const h = attr(child(m, "c:hMode"), "val") === "edge" ? null : num("c:h");
  if (x === null && y === null && w === null && h === null) return null;
  return { x, y, w, h, inner: attr(child(m, "c:layoutTarget"), "val") === "inner" };
}

function readLegend(el: XmlElement | null, font: ChartFont, ctx: ChartContext): ChartLegend | null {
  if (!el) return null;
  const pos = attr(child(el, "c:legendPos"), "val");
  return {
    ...box(child(el, "c:spPr"), EMPTY_BOX, ctx),
    pos: pos === "l" || pos === "t" || pos === "b" || pos === "tr" ? pos : "r",
    overlay: flag(child(el, "c:overlay"), ctx.absent),
    layout: readLayout(child(el, "c:layout")),
    font: readFont(child(el, "c:txPr"), font, ctx),
    hidden: children(el, "c:legendEntry")
      .filter((e) => flag(child(e, "c:delete"), false))
      .map((e) => numAttr(child(e, "c:idx"), "val", -1)),
  };
}

// ── Plots and series ────────────────────────────────────────────────────────

function grouping(el: XmlElement, fallback: ChartGrouping): ChartGrouping {
  const g = attr(child(el, "c:grouping"), "val");
  return g === "stacked" || g === "percentStacked" || g === "clustered" || g === "standard" ? g : fallback;
}

function readPlot(el: XmlElement, font: ChartFont, ctx: ChartContext): ChartPlot {
  const sers = children(el, "c:ser");
  const maxIndex = Math.max(0, ...sers.map((s, i) => numAttr(child(s, "c:idx"), "val", i)));
  const vary = flag(child(el, "c:varyColors"), ctx.absent);
  const plotLabels = child(el, "c:dLbls");
  const read = (kind: SeriesKind): ChartSeries[] =>
    sers
      .map((s, i) => ({ s, order: numAttr(child(s, "c:order"), "val", i) }))
      .sort((a, b) => a.order - b.order)
      .map(({ s }, i) => readSeries(s, i, kind, maxIndex, vary && (kind === "pie" || sers.length === 1), plotLabels, font, el, ctx));
  switch (el.name) {
    case "c:barChart":
    case "c:bar3DChart":
      return {
        kind: "bar",
        horizontal: attr(child(el, "c:barDir"), "val") === "bar",
        grouping: grouping(el, "clustered"),
        gapWidth: numAttr(child(el, "c:gapWidth"), "val", 150),
        overlap: numAttr(child(el, "c:overlap"), "val", grouping(el, "clustered").endsWith("tacked") ? 100 : 0),
        series: read("filled"),
      };
    case "c:areaChart":
    case "c:area3DChart":
      return { kind: "area", grouping: grouping(el, "standard"), series: read("filled") };
    case "c:scatterChart":
      return { kind: "scatter", series: read("scatter") };
    case "c:bubbleChart":
      return {
        kind: "bubble",
        scale: Math.max(0, numAttr(child(el, "c:bubbleScale"), "val", 100)),
        byWidth: attr(child(el, "c:sizeRepresents"), "val") === "w",
        negatives: flag(child(el, "c:showNegBubbles"), ctx.absent),
        series: read("bubble"),
      };
    case "c:radarChart": {
      const style = attr(child(el, "c:radarStyle"), "val");
      return style === "filled" ? { kind: "radar", filled: true, series: read("filled") } : { kind: "radar", filled: false, series: read(style === "marker" ? "line" : "radar") };
    }
    case "c:surfaceChart":
    case "c:surface3DChart": {
      const series = read("filled");
      const fmts = new Map(children(child(el, "c:bandFmts"), "c:bandFmt").map((b) => [numAttr(child(b, "c:idx"), "val", -1), b]));
      // One band per major unit of the value axis, painted like series in turn.
      const count = Math.max(SURFACE_BANDS, ...[...fmts.keys()].map((k) => k + 1));
      return {
        kind: "surface",
        wireframe: flag(child(el, "c:wireframe"), false),
        bands: Array.from({ length: count }, (_, i) => box(path(fmts.get(i) ?? null, "c:spPr"), autoFormat("filled", autoColor(i, count - 1, ctx), ctx), ctx)),
        series,
      };
    }
    case "c:pieChart":
    case "c:pie3DChart":
    case "c:doughnutChart":
    case "c:ofPieChart":
      return {
        kind: "pie",
        firstSliceAngle: numAttr(child(el, "c:firstSliceAng"), "val", 0),
        holeSize: el.name === "c:doughnutChart" ? numAttr(child(el, "c:holeSize"), "val", 50) : 0,
        series: read("pie"),
      };
    default:
      // A line chart and its kin: 3-D lines, and stock charts (their high-low
      // lines and up-down bars left out).
      return { kind: "line", grouping: grouping(el, "standard"), series: read("line") };
  }
}

/** Value bands a surface is painted in, at least. */
const SURFACE_BANDS = 12;

/** How a series is read: `radar` is a radar's line without markers. */
type SeriesKind = "filled" | "line" | "scatter" | "pie" | "bubble" | "radar";

/** Excel 2007's limit of points per series; past it a cache is cut. */
const MAX_POINTS = 32000;

function readValues(el: XmlElement | null): ChartValues | null {
  if (!el) return null;
  const cache =
    path(el, "c:numRef", "c:numCache") ??
    child(el, "c:numLit") ??
    path(el, "c:strRef", "c:strCache") ??
    child(el, "c:strLit") ??
    child(path(el, "c:multiLvlStrRef", "c:multiLvlStrCache"), "c:lvl");
  if (!cache) return null;
  const numeric = cache.name === "c:numCache" || cache.name === "c:numLit";
  // Capped like `idx` below: a declared count of two million around one point was 365 MB of model (2026-11-15
  // audit, S5).
  const count = Math.min(MAX_POINTS, numAttr(child(cache, "c:ptCount"), "val", 0));
  const values: (number | string | null)[] = Array.from({ length: count }, () => null);
  for (const pt of children(cache, "c:pt")) {
    const idx = numAttr(pt, "idx", -1);
    if (idx < 0 || idx >= MAX_POINTS) continue;
    while (values.length <= idx) values.push(null);
    const v = child(pt, "c:v")?.text ?? "";
    values[idx] = numeric ? (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null) : v;
  }
  return { values, format: child(cache, "c:formatCode")?.text ?? "General" };
}

function readSeries(
  ser: XmlElement,
  position: number,
  kind: SeriesKind,
  maxIndex: number,
  vary: boolean,
  plotLabels: XmlElement | null,
  font: ChartFont,
  plot: XmlElement,
  ctx: ChartContext,
): ChartSeries {
  const index = numAttr(child(ser, "c:idx"), "val", position);
  const xy = kind === "scatter" || kind === "bubble";
  const values = readValues(child(ser, xy ? "c:yVal" : "c:val")) ?? { values: [], format: "General" };
  const count = values.values.length;
  const spPr = child(ser, "c:spPr");

  const color = autoColor(index, maxIndex, ctx);
  const drawn = kind === "radar" ? "line" : kind === "bubble" ? "filled" : kind;
  const own = box(spPr, autoFormat(drawn, color, ctx), ctx);

  // Markers: line charts show them unless `c:marker val=0` at the plot; a
  // scatter's style says whether it has lines, markers or both.
  const scatterStyle = attr(child(plot, "c:scatterStyle"), "val") ?? "marker";
  const showMarkers =
    kind === "line" ? flag(child(plot, "c:marker"), true) : kind === "scatter" ? scatterStyle !== "line" && scatterStyle !== "smooth" : false;
  const marker = drawn === "line" || kind === "scatter" ? readMarker(child(ser, "c:marker"), showMarkers, index, color, ctx) : null;
  // A scatter of markers only has no lines unless the series draws one.
  const line =
    kind === "scatter" && (scatterStyle === "marker" || scatterStyle === "none") && !path(spPr, "a:ln") ? null : own.line;

  const dPts = new Map(children(ser, "c:dPt").map((d) => [numAttr(child(d, "c:idx"), "val", -1), d]));
  let points: ChartPoint[] | null = null;
  if (vary || dPts.size > 0) {
    points = Array.from({ length: count }, (_, i) => {
      const pointAuto = vary ? box(spPr, autoFormat(drawn, autoColor(i, count - 1, ctx), ctx), ctx) : { ...own, line };
      const d = dPts.get(i);
      const b = d ? box(child(d, "c:spPr"), pointAuto, ctx) : pointAuto;
      const m = d && marker ? readMarker(child(d, "c:marker"), true, index, color, ctx, marker) : marker;
      return { ...b, marker: m, explosion: numAttr(child(d ?? null, "c:explosion"), "val", numAttr(child(ser, "c:explosion"), "val", 0)) };
    });
  }

  // Data labels: the plot's, then the series', then each point's.
  // Office's own name for an unnamed series has no space: "Series1".
  const name = stringFrom(child(ser, "c:tx")) ?? `Series${index + 1}`;
  const plotBase = mergeLabels(plotLabels, defaultLabel(font), ctx);
  const serLabelsEl = child(ser, "c:dLbls");
  const serBase = mergeLabels(serLabelsEl, plotBase, ctx);
  const shown = (l: ChartDataLabel | null): ChartDataLabel | null => (l && (l.value || l.percent || l.category || l.series || l.size || l.text) ? l : null);
  const serDeleted = flag(child(serLabelsEl, "c:delete"), false) || flag(child(plotLabels, "c:delete"), false);
  const pointLabels = new Map(children(serLabelsEl, "c:dLbl").map((d) => [numAttr(child(d, "c:idx"), "val", -1), d]));
  // Office 2013's labels "from cells": their text is cached in the series.
  const cells = new Map(
    children(descendants(child(ser, "c:extLst"), "c15:dlblRangeCache")[0], "c:pt").map((pt) => [numAttr(pt, "idx", -1), child(pt, "c:v")?.text ?? ""]),
  );
  const fromCells = (el: XmlElement | null): boolean => descendants(el, "c15:showDataLabelsRange").some((e) => flag(e, false));
  const cellText = (l: ChartDataLabel, i: number): ChartDataLabel =>
    !l.text && (fromCells(serLabelsEl) || fromCells(pointLabels.get(i) ?? null)) && cells.get(i)
      ? { ...l, text: [{ align: "ctr", runs: [{ text: cells.get(i)!, font: l.font }] }] }
      : l;
  const labels = Array.from({ length: count }, (_, i) => {
    const d = pointLabels.get(i);
    if (d) return flag(child(d, "c:delete"), false) ? null : shown(cellText(mergeLabels(d, serBase, ctx, { CELLRANGE: cells.get(i) ?? "" }), i));
    return serDeleted ? null : shown(cellText(serBase, i));
  });

  return {
    index,
    name,
    values,
    xValues: xy ? readValues(child(ser, "c:xVal")) : null,
    sizes: kind === "bubble" ? readValues(child(ser, "c:bubbleSize")) : null,
    bubble3D: flag(child(ser, "c:bubble3D"), false),
    fill: drawn === "line" || kind === "scatter" ? null : own.fill,
    line,
    effects: own.effects,
    marker,
    points,
    smooth: flag(child(ser, "c:smooth"), kind === "scatter" && scatterStyle.startsWith("smooth")),
    explosion: numAttr(child(ser, "c:explosion"), "val", 0),
    labels,
  };
}

// ── The chart style: automatic colours and formats ──────────────────────────

/**
 * The style's colour for series (or, with `varyColors`, point) `index` of
 * `0..max`. Column 1 cycles the six accents; the others fade one colour, grey
 * or an accent, across the series. Fading and cycling both shade the first
 * ones and tint the last ones, in equal steps between -70% and +70%.
 */
function autoColor(index: number, max: number, ctx: ChartContext): Rgba {
  if (ctx.col === 1) return faded(`accent${(index % 6) + 1}`, Math.floor(index / 6), Math.floor(max / 6), ctx);
  return faded(ctx.col === 0 ? "tx1" : `accent${ctx.col - 1}`, index, max, ctx);
}

function faded(name: string, step: number, last: number, ctx: ChartContext): Rgba {
  const t = Math.round((((step + 1) / (last + 2)) * 1.4 - 0.7) * 100000);
  return scheme(name, t < 0 ? [["shade", 100000 + t]] : t > 0 ? [["tint", 100000 - t]] : [], ctx);
}

/** The theme's style matrix with `color` as `phClr`. */
function themed(ctx: ChartContext, color: Rgba): StyleContext {
  return { ...ctx, part: ctx.theme.part, colors: { ...ctx.colors, placeholder: color } };
}

/** What a series looks like in its automatic colour, per gallery row:
 *  flat (1-8, 9-16, 33-40) or the theme's intense gradient (17-32, 41-48),
 *  with the theme's shadow from row 17 on. Lines are 2.25 pt, 3 pt in the
 *  intense rows (measured on style 18), and never shadowed. */
function autoFormat(kind: SeriesKind, color: Rgba, ctx: ChartContext): ChartBox {
  const t = themed(ctx, color);
  const intense = ctx.row === 2 || ctx.row === 3 || ctx.row === 5;
  const effectEntry = ctx.row === 2 || ctx.row === 3 ? ctx.theme.effects[ctx.row === 2 ? 1 : 2] : undefined;
  const effects = effectEntry ? readEffects(effectEntry, t, NO_EFFECTS) : NO_EFFECTS;
  if (kind === "line" || kind === "scatter") {
    return { fill: null, line: { ...solidLine(color, intense ? 38100 : 28575), cap: "round" }, effects: NO_EFFECTS };
  }
  const entry = ctx.theme.fills[intense ? 2 : 0];
  const fill: Fill | null = entry ? readFill(entry, t) : { kind: "solid", color: css(color) };
  let line: Line | null = null;
  if (ctx.row === 1) line = solidLine(scheme("dk1", [["tint", 75000]], ctx));
  else if (ctx.row === 4) line = solidLine(scheme("lt1", [], ctx));
  else if (kind === "pie" && ctx.row !== 5) line = solidLine(scheme("lt1", [], ctx));
  return { fill, line, effects };
}

const MARKER_CYCLE: ChartMarker["symbol"][] = ["diamond", "square", "triangle", "x", "star", "circle", "plus", "dot", "dash"];

/** A marker over the automatic one: filled like a bar of the series' colour
 *  (gradient and shadow in the intense rows), outlined in it, 7 pt. */
function readMarker(el: XmlElement | null, show: boolean, index: number, color: Rgba, ctx: ChartContext, base?: ChartMarker | null): ChartMarker | null {
  const sym = attr(child(el, "c:symbol"), "val");
  if (sym === "none" || (!show && sym === null)) return null;
  const symbol = (sym && sym !== "auto" && sym !== "picture" ? sym : (base?.symbol ?? MARKER_CYCLE[index % MARKER_CYCLE.length]!)) as ChartMarker["symbol"];
  const filled = autoFormat("filled", color, ctx);
  const auto: ChartBox = base ?? { fill: filled.fill, line: solidLine(color), effects: filled.effects };
  const own = box(child(el, "c:spPr"), auto, ctx);
  return { symbol, size: numAttr(child(el, "c:size"), "val", base?.size ?? 7), ...own };
}

// ── Data labels ─────────────────────────────────────────────────────────────

function defaultLabel(font: ChartFont): ChartDataLabel {
  return {
    value: false,
    percent: false,
    category: false,
    series: false,
    size: false,
    separator: null,
    position: null,
    format: null,
    font,
    fill: null,
    line: null,
    offset: null,
    text: null,
    legendKey: false,
  };
}

const LABEL_POSITIONS = new Set(["ctr", "inEnd", "inBase", "outEnd", "t", "b", "l", "r", "bestFit"]);

function mergeLabels(el: XmlElement | null, base: ChartDataLabel, ctx: ChartContext, fields: Record<string, string> = {}): ChartDataLabel {
  if (!el) return base;
  const show = (name: string, current: boolean): boolean => flag(child(el, name), current || ctx.absent);
  const pos = attr(child(el, "c:dLblPos"), "val");
  const fmt = child(el, "c:numFmt");
  const spPr = box(child(el, "c:spPr"), { fill: base.fill, line: base.line, effects: NO_EFFECTS }, ctx);
  const m = child(child(el, "c:layout"), "c:manualLayout");
  const rich = path(el, "c:tx", "c:rich");
  const font = readFont(child(el, "c:txPr"), base.font, ctx);
  return {
    value: show("c:showVal", base.value),
    percent: show("c:showPercent", base.percent),
    category: show("c:showCatName", base.category),
    series: show("c:showSerName", base.series),
    size: show("c:showBubbleSize", base.size),
    separator: child(el, "c:separator")?.text ?? base.separator,
    position: pos && LABEL_POSITIONS.has(pos) ? (pos as ChartDataLabel["position"]) : base.position,
    format: fmt ? (isTrue(attr(fmt, "sourceLinked")) ? null : (attr(fmt, "formatCode") ?? null)) : base.format,
    font,
    fill: spPr.fill,
    line: spPr.line,
    offset: m ? { x: numAttr(child(m, "c:x"), "val", 0), y: numAttr(child(m, "c:y"), "val", 0) } : base.offset,
    text: rich ? readRich(rich, font, ctx, fields) : base.text,
    legendKey: show("c:showLegendKey", base.legendKey),
  };
}

// ── Axes ────────────────────────────────────────────────────────────────────

function tick(el: XmlElement | null, fallback: ChartTick): ChartTick {
  const v = attr(el, "val");
  return v === "out" || v === "in" || v === "cross" || v === "none" ? v : fallback;
}

function readAxis(el: XmlElement, kind: ChartAxis["kind"], font: ChartFont, areaOnly: boolean, ctx: ChartContext): ChartAxis {
  const scaling = child(el, "c:scaling");
  const num = (parent: XmlElement | null, name: string): number | null => {
    const v = attr(child(parent, name), "val");
    return v === null || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  const lineColor =
    ctx.row === 4 ? scheme("dk1", [["tint", 75000]], ctx) : ctx.row === 5 ? scheme("lt1", [["tint", 75000]], ctx) : scheme("tx1", [["tint", 75000]], ctx);
  const autoLine = solidLine(lineColor);
  const grid = (name: string): Line | null => {
    const g = child(el, name);
    if (!g) return null;
    const minor = name === "c:minorGridlines";
    const auto = minor ? solidLine(ctx.row === 5 ? scheme("lt1", [["tint", 50000]], ctx) : scheme("tx1", [["tint", 50000]], ctx)) : autoLine;
    return readLine(path(g, "c:spPr", "a:ln"), ctx, auto);
  };
  const lblPos = attr(child(el, "c:tickLblPos"), "val");
  const fmt = child(el, "c:numFmt");
  const rot = attr(path(el, "c:txPr", "a:bodyPr"), "rot");
  const rotation = rot === null ? null : Number(rot) / 60000;
  const crossesAt = num(el, "c:crossesAt");
  const crosses = attr(child(el, "c:crosses"), "val");
  const between = attr(child(el, "c:crossBetween"), "val");
  return {
    kind,
    deleted: flag(child(el, "c:delete"), ctx.absent),
    reversed: attr(child(scaling, "c:orientation"), "val") === "maxMin",
    min: num(scaling, "c:min"),
    max: num(scaling, "c:max"),
    majorUnit: num(el, "c:majorUnit"),
    minorUnit: num(el, "c:minorUnit"),
    format: fmt && !isTrue(attr(fmt, "sourceLinked")) ? (attr(fmt, "formatCode") ?? null) : null,
    labels: lblPos === "low" || lblPos === "high" || lblPos === "none" ? lblPos : "nextTo",
    majorTick: tick(child(el, "c:majorTickMark"), "out"),
    line: readLine(path(el, "c:spPr", "a:ln"), ctx, autoLine),
    majorGrid: grid("c:majorGridlines"),
    minorGrid: grid("c:minorGridlines"),
    font: readFont(child(el, "c:txPr"), font, ctx),
    rotation: rotation !== null && Number.isFinite(rotation) && Math.abs(rotation) <= 90 ? rotation : null,
    crosses: crossesAt !== null ? crossesAt : crosses === "min" || crosses === "max" ? crosses : "autoZero",
    between: between === null ? !areaOnly : between === "between",
    title: child(el, "c:title") ? readTitle(child(el, "c:title"), { ...font, bold: true }, "Axis Title", ctx) : null,
    labelSkip: num(el, "c:tickLblSkip"),
    tickSkip: num(el, "c:tickMarkSkip"),
    labelOffset: numAttr(child(el, "c:lblOffset"), "val", 100),
  };
}
