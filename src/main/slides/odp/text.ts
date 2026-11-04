import type { Bullet, Fill, Paragraph, TextBody, TextRun } from "@shared/types/slide-model";
import { NO_EFFECTS } from "../pptx/style";
import { fontList, SYMBOL_BULLETS } from "../pptx/text";
import { attr, child, children, type XmlElement } from "../pptx/xml";
import { firstFamily, mergeProps, type OdpPackage, type Props, type Resolved, type Scope } from "./package";
import { color, imageFormatMiss, length, lengthOr, miss, partOf, percent, rgba, type Misses } from "./style";
import { TEXT_NODE } from "./xml";

/** What a shape's text is resolved against besides its own styles. */
export type TextContext = {
  pkg: OdpPackage;
  /** Where the shape's style names are looked up. */
  scope: Scope;
  misses: Misses;
  /** 1-based, hidden pages included: what a page-number field shows. */
  pageNumber: number;
  pageCount: number;
  pageName: string;
  /** The page's header, footer and date-time declarations, for their fields. */
  fields: { header: string; footer: string; dateTime: string };
  /** The colour behind the text, for LibreOffice's automatic font colour. */
  background: string | null;
};

/**
 * The styles a shape's text starts from. Not `draw:text-style-name`: Impress
 * sets that style on the shape before its text exists, so no paragraph read
 * from the file ever carries it (measured: its alignment, size and colour are
 * all ignored). Only its font-independent line spacing, a property of the
 * shape's whole text, takes effect.
 */
export type TextStyles = {
  /** The shape's own style, graphic default included. */
  shape: Resolved;
  /** `style:font-independent-line-spacing` on the shape: every line is 1.2 of
   *  its size, its baseline at 1.0, whatever the face. */
  fixedLines: boolean;
  /** An outline placeholder's per-level styles (`<master>-outline<n>`), for
   *  paragraphs below the first level. */
  outline: ((level: number) => Resolved | null) | null;
};

const PT = 12700;
/** The share of its size the renderer draws a raised or lowered run at. */
const RAISED = 0.67;
/** LibreOffice's default spacing between a frame's border and its text. */
const PAD_X = 0.25 * 360000;
const PAD_Y = 0.125 * 360000;

/**
 * The paragraphs of `container` (a shape, a text box, a cell) as a text body;
 * `null` when there is no text in it at all. `area` is the size of the
 * shape's text rectangle, which shrink-on-overflow fits the text into.
 */
export function readTextBody(container: XmlElement, styles: TextStyles, wrap: boolean, area: { w: number; h: number }, ctx: TextContext): TextBody | null {
  const g = styles.shape.graphic;
  const read: ReadParagraph[] = [];
  collect(container, styles, ctx, read, { level: 0, list: null, counters: [] });
  if (!read.some(({ p }) => p.runs.some((r) => r.kind === "text" && r.text.trim() !== ""))) return null;
  const pad = (side: string, fallback: number): number => lengthOr(g[`fo:padding-${side}`] ?? g["fo:padding"], fallback);
  const insets = { l: pad("left", PAD_X), t: pad("top", PAD_Y), r: pad("right", PAD_X), b: pad("bottom", PAD_Y) };
  const vAlign = g["draw:textarea-vertical-align"];
  const writing = styles.shape.paragraph["style:writing-mode"] ?? g["style:writing-mode"];
  // `fit-to-size` true/all stretches the letters to the box both ways (`TextBody.stretch`).
  const stretch = g["draw:fit-to-size"] === "true" || g["draw:fit-to-size"] === "all";
  const shrink = !stretch && (g["style:shrink-to-fit"] === "true" || g["draw:fit-to-size"] === "shrink-to-fit");
  const cols = styles.shape.columns;
  const vertical = writing === "tb-rl" || writing === "tb" ? "vert" : writing === "bt-lr" ? "vert270" : "horz";
  let autofit: TextBody["autofit"] = g["draw:auto-grow-height"] === "true" ? { kind: "shape" } : { kind: "none" };
  if (shrink) {
    // LibreOffice stores no scale: it is worked out here, the text measured
    // with average advance widths (an estimate).
    const w = (vertical === "horz" ? area.w : area.h) - insets.l - insets.r;
    const h = (vertical === "horz" ? area.h : area.w) - insets.t - insets.b;
    const scale = fitScale(read, w, h);
    if (scale.font < 1 || scale.spacing < 1) for (const r of read) scaleParagraph(r, scale.font, scale.spacing);
    autofit = { kind: "normal", fontScale: scale.font, lineReduction: 0 };
  }
  const paragraphs = read.map((r) => lineGeometry(r));
  // The renderer sets every first baseline where PowerPoint does; LibreOffice
  // puts it at the face's ascent. The text area moves by the difference.
  const shift = firstBaselineShift(read[0]!);
  if (shift !== 0 && vertical === "horz") {
    insets.t += shift;
    insets.b -= shift;
  }
  return {
    insets,
    anchor: vAlign === "middle" ? "ctr" : vAlign === "bottom" ? "b" : "t",
    anchorCenter: g["draw:textarea-horizontal-align"] === "center" && !wrap,
    wrap,
    vertical,
    autofit,
    columns: { count: Math.max(1, Number(attr(cols, "fo:column-count") ?? 1) || 1), spacing: lengthOr(attr(cols, "fo:column-gap"), 0) },
    rotation: 0,
    upright: false,
    ...(stretch ? { stretch: true as const } : null),
    paragraphs,
  };
}

/** A paragraph as read, and the line spacing LibreOffice gives it before it
 *  becomes the model's (`lineGeometry`). */
type ReadParagraph = {
  p: Paragraph;
  /** Proportional spacing (1 = single), or exact/minimum points. */
  spacing: { pct: number } | { pts: number } | { atLeast: number };
  /** The first run's face: its ascent and descent (em, LibreOffice's). */
  ascent: number;
  descent: number;
  /** The first run's size (points), what the line metrics scale with. */
  size: number;
};

/**
 * Ascent and descent (em) LibreOffice lays lines out with — the face's own,
 * measured in Impress's PDFs at 20 pt (`hhea`), so its single spacing (the
 * sum) is the face's and not PowerPoint's 1.2 em. Faces under other names
 * share their metric twin's.
 */
const LINE_METRICS: Record<string, [number, number]> = {
  "liberation sans": [0.905, 0.212], arial: [0.905, 0.212], arimo: [0.905, 0.212], "liberation sans narrow": [0.905, 0.212], "arial narrow": [0.905, 0.212],
  "liberation serif": [0.891, 0.216], "times new roman": [0.891, 0.216], tinos: [0.891, 0.216], times: [0.891, 0.216],
  "liberation mono": [0.833, 0.3], "courier new": [0.833, 0.3], cousine: [0.833, 0.3],
  carlito: [0.75, 0.25], calibri: [0.75, 0.25], "calibri light": [0.75, 0.25],
  caladea: [0.964, 0.212], cambria: [0.964, 0.212],
  "dejavu sans": [0.928, 0.236], "dejavu serif": [0.928, 0.236], "dejavu sans condensed": [0.928, 0.236],
  "noto sans": [1.069, 0.293], "noto serif": [1.069, 0.293], "open sans": [1.069, 0.293],
  "source sans pro": [0.984, 0.273], "source sans 3": [0.984, 0.273], montserrat: [0.968, 0.251],
  verdana: [1.005, 0.21], georgia: [0.917, 0.219], tahoma: [1.0, 0.207], "trebuchet ms": [0.939, 0.222],
  "segoe ui": [1.079, 0.251], "comic sans ms": [1.102, 0.287], impact: [1.009, 0.211], "arial black": [1.1, 0.31], "century gothic": [1.006, 0.22],
};
/** Font-independent line spacing (measured): PowerPoint's single line. */
const FIXED_METRICS: [number, number] = [1.006, 0.194];
/** A face this doesn't know: a typical one. */
const DEFAULT_METRICS: [number, number] = [0.9, 0.25];

function metricsOf(font: string | undefined): [number, number] {
  for (const face of (font ?? "").split(",")) {
    const m = LINE_METRICS[face.trim().replace(/^"|"$/g, "").toLowerCase()];
    if (m) return m;
  }
  return DEFAULT_METRICS;
}

/** PowerPoint's single line, which the renderer's percentages are of (em). */
const SINGLE_LINE = 1.2;

/** The model's spacing for a paragraph laid out the way Impress does: a
 *  proportional line is that share of the face's ascent plus descent. */
function lineGeometry(r: ReadParagraph): Paragraph {
  const face = r.ascent + r.descent;
  const s = r.spacing;
  const lineSpacing: Paragraph["lineSpacing"] =
    "pct" in s ? { pct: (s.pct * face) / SINGLE_LINE } : "pts" in s ? { pts: s.pts } : s.atLeast > r.size * face ? { pts: s.atLeast } : { pct: face / SINGLE_LINE };
  return { ...r.p, lineSpacing };
}

/** How far (EMU, down) LibreOffice's first baseline is from the renderer's. */
function firstBaselineShift(r: ReadParagraph): number {
  const face = r.ascent + r.descent;
  const model = lineGeometry(r).lineSpacing;
  // Where the renderer puts it (`slide-text.tsx`), in em of the size.
  const ours = "pts" in model ? (0.747 * model.pts) / r.size : 0.955 + 0.85 * (model.pct - 1);
  const s = r.spacing;
  const pct = "pct" in s ? s.pct : 1;
  // Extra proportional spacing goes above the line; less takes from the ascent.
  const theirs = "pts" in s ? s.pts / r.size - r.descent : pct >= 1 ? r.ascent + (pct - 1) * face : pct * r.ascent;
  return (theirs - ours) * r.size * PT;
}

function scaleParagraph(r: ReadParagraph, font: number, spacing: number): void {
  // Impress rounds a fitted size to a whole point.
  const k = (size: number): number => Math.max(1, Math.round(size * font));
  r.size = k(r.size);
  r.p.endSize = k(r.p.endSize);
  for (const run of r.p.runs) run.size = k(run.size);
  if (r.p.bullet && "pts" in r.p.bullet.size) r.p.bullet.size = { pts: r.p.bullet.size.pts * font };
  r.p.spaceBefore = "pts" in r.p.spaceBefore ? { pts: r.p.spaceBefore.pts * spacing } : r.p.spaceBefore;
  r.p.spaceAfter = "pts" in r.p.spaceAfter ? { pts: r.p.spaceAfter.pts * spacing } : r.p.spaceAfter;
  const s = r.spacing;
  r.spacing = "pct" in s ? { pct: s.pct * spacing } : "pts" in s ? { pts: s.pts * spacing } : { atLeast: s.atLeast * spacing };
}

/**
 * The scale Impress shrinks overflowing text by: the largest font scale (to
 * 1%) at which the estimated text fits `h`. Impress also tightens the spacing
 * of the text it shrinks; modelling that measured worse than leaving it.
 */
function fitScale(read: ReadParagraph[], w: number, h: number): { font: number; spacing: number } {
  if (w <= 0 || h <= 0) return { font: 1, spacing: 1 };
  const heightAt = (k: number, sp: number): number =>
    read.reduce((sum, r, i) => {
      const face = r.ascent + r.descent;
      const s = r.spacing;
      const line = "pct" in s ? s.pct * sp * face * r.size * k : "pts" in s ? s.pts * sp : Math.max(s.atLeast * sp, face * r.size * k);
      const before = i === 0 || !("pts" in r.p.spaceBefore) ? 0 : r.p.spaceBefore.pts * sp;
      const after = "pts" in r.p.spaceAfter ? r.p.spaceAfter.pts * sp : 0;
      return sum + (before + after) * PT + lineCount(r.p, k, w) * line * PT;
    }, 0);
  if (heightAt(1, 1) <= h) return { font: 1, spacing: 1 };
  let lo = 0.1;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (heightAt(mid, 1) <= h) lo = mid;
    else hi = mid;
  }
  return { font: Math.floor(lo * 100) / 100, spacing: 1 };
}

/** Lines a paragraph wraps into at scale `k` in a width `w` (EMU), words
 *  wrapped greedily. */
function lineCount(p: Paragraph, k: number, w: number): number {
  let lines = 1;
  const start = (): number => (lines === 1 ? p.marginLeft + p.indent : p.marginLeft);
  let x = start();
  for (const run of p.runs) {
    if (run.kind === "break") {
      lines++;
      x = start();
      continue;
    }
    const em = run.size * k * PT * widthFactor(run.font, run.bold);
    for (const word of run.text.split(/(?<= )/)) {
      const width = [...word].reduce((sum, ch) => sum + advance(ch), 0) * em;
      const ink = word.endsWith(" ") ? width - advance(" ") * em : width;
      if (x + ink > w && x > start()) {
        lines++;
        x = start();
      }
      x += width;
    }
  }
  return lines;
}

/** Advance widths of Arial (and Liberation Sans) for ASCII, in em. */
const ARIAL = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

function advance(ch: string): number {
  const c = ch.codePointAt(0) ?? 32;
  if (c >= 32 && c < 127) return ARIAL[c - 32]! / 1000;
  if (c === 9) return 2;
  if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef)) return 1;
  const base = ch.normalize("NFD").codePointAt(0) ?? 0;
  if (base >= 32 && base < 127) return ARIAL[base - 32]! / 1000;
  return 0.556;
}

/** How much wider or narrower a face sets than Arial, roughly. */
function widthFactor(font: string, bold: boolean): number {
  const f = font.toLowerCase();
  let k = /mono|courier|consol/.test(f) ? 1.08 : /narrow|condensed|compressed/.test(f) ? 0.82 : /calibri|carlito|candara/.test(f) ? 0.9
    : /times|serif|caladea|cambria|georgia|garamond|antiqua|palatino|book/.test(f) ? 0.92 : /verdana|tahoma|segoe|open sans|noto|dejavu/.test(f) ? 1.08 : 1;
  if (bold) k *= 1.07;
  return k;
}

type ListState = {
  /** 1-based depth inside lists; 0 outside any. */
  level: number;
  list: XmlElement | null;
  /** The running number per level. */
  counters: number[];
};

function collect(el: XmlElement, styles: TextStyles, ctx: TextContext, out: ReadParagraph[], state: ListState, item?: { bullet: boolean; start: number | null }): void {
  let first = true;
  for (const c of el.children) {
    switch (c.name) {
      case "text:p":
      case "text:h":
        out.push(readParagraph(c, styles, ctx, state, item && first ? item : null));
        first = false;
        break;
      case "text:list": {
        const own = ctx.pkg.sheet.find(ctx.scope, "list", attr(c, "text:style-name"));
        const level = state.level + 1;
        // A list that doesn't continue its predecessor starts counting again.
        if (level === 1 && attr(c, "text:continue-numbering") !== "true" && !attr(c, "text:continue-list")) state.counters = [];
        const next: ListState = { level, list: own ?? state.list, counters: state.counters };
        for (const li of c.children) {
          if (li.name !== "text:list-item" && li.name !== "text:list-header") continue;
          const start = attr(li, "text:start-value");
          collect(li, styles, ctx, out, next, { bullet: li.name === "text:list-item", start: start === null ? null : Number(start) || 1 });
        }
        state.counters = next.counters;
        first = false;
        break;
      }
      case "text:section":
      case "text:soft-page-break":
        if (c.name === "text:section") collect(c, styles, ctx, out, state);
        break;
      default:
        break;
    }
  }
}

/** Merged property sets, least specific first. */
function merged(...sets: (Props | null | undefined)[]): Props {
  const out: Props = {};
  for (const s of sets) {
    if (!s) continue;
    // An explicit colour beats an inherited «automatic» one, and the other way round.
    if (s["fo:color"] !== undefined && s["style:use-window-font-color"] === undefined) delete out["style:use-window-font-color"];
    if (s["style:use-window-font-color"] === "true" && s["fo:color"] === undefined) delete out["fo:color"];
    mergeProps(out, s);
  }
  return out;
}

function readParagraph(p: XmlElement, styles: TextStyles, ctx: TextContext, state: ListState, item: { bullet: boolean; start: number | null } | null): ReadParagraph {
  const own = ctx.pkg.sheet.resolve(ctx.scope, "paragraph", attr(p, "text:style-name"));
  const outline = state.level > 1 && styles.outline ? styles.outline(state.level) : null;
  const layers: (Resolved | null)[] = [styles.shape, outline, attr(p, "text:style-name") ? own : null];
  const pp = merged(...layers.map((l) => l?.paragraph));
  const tp = merged(...layers.map((l) => l?.text));
  const tabStops = [...layers].reverse().find((l) => l?.tabStops)?.tabStops ?? null;

  const runs: TextRun[] = [];
  const walker = { space: true };
  walkRuns(p, tp, ctx, runs, walker);
  // Trailing white space at the end of a paragraph is not drawn.
  const last = runs[runs.length - 1];
  if (last?.kind === "text") last.text = last.text.replace(/ +$/, "");
  const textRuns = runs.filter((r) => r.kind !== "text" || r.text !== "");

  const size = fontSize(tp);
  let marginLeft = lengthOr(pp["fo:margin-left"], 0);
  let indent = lengthOr(pp["fo:text-indent"], 0);
  let bullet: Bullet | null = null;
  if (state.level > 0) {
    const listStyle = state.list ?? styles.shape.listStyle;
    const levelStyle = levelOf(listStyle, state.level);
    const pos = listPosition(levelStyle);
    // A list level places its label from where the paragraph's first line
    // starts, and its text a label's width after that (measured in Impress).
    if (pos) {
      const start = pos.absolute ? 0 : marginLeft + indent;
      marginLeft = start + pos.marginLeft;
      indent = item?.bullet ? pos.indent : 0;
    }
    if (item?.bullet) {
      // Numbered per level; an item at a level restarts every deeper one.
      const counters = state.counters;
      const previous = counters[state.level - 1];
      if (counters.length > state.level) counters.length = state.level;
      const n = item.start ?? (previous !== undefined ? previous + 1 : Number(attr(levelStyle, "text:start-value") ?? 1) || 1);
      counters[state.level - 1] = n;
      if (textRuns.some((r) => r.kind === "text")) bullet = readBullet(levelStyle, n, ctx);
    }
  }

  const firstRun = textRuns.find((r) => r.kind === "text");
  const [ascent, descent] = styles.fixedLines ? FIXED_METRICS : metricsOf(firstRun?.kind === "text" ? firstRun.font : undefined);
  const lineHeight = pp["fo:line-height"];
  const atLeast = length(pp["style:line-height-at-least"]);
  const leading = length(pp["style:line-spacing"]);
  let spacing: ReadParagraph["spacing"] = { pct: 1 };
  if (lineHeight && lineHeight !== "normal") {
    const pct = percent(lineHeight);
    const l = length(lineHeight);
    if (pct !== null) spacing = { pct };
    else if (l !== null) spacing = { pts: l / PT };
  } else if (atLeast !== null && atLeast > 0) spacing = { atLeast: atLeast / PT };
  else if (leading !== null && leading !== 0) spacing = { pts: Math.max(1, size * (ascent + descent) + leading / PT) };

  // Tab stops are measured from the paragraph's indent, and so are the
  // default ones past them — written out, as the renderer counts those from
  // the box.
  const defaultTab = length(pp["style:tab-stop-distance"] ?? pp["loext:tab-stop-distance"]) || ctx.pkg.defaultTab || 1.25 * 360000;
  const tabs: Paragraph["tabs"] = children(tabStops, "style:tab-stop")
    .map((t) => {
      const type = attr(t, "style:type");
      return { pos: marginLeft + lengthOr(attr(t, "style:position"), 0), align: type === "center" ? "ctr" as const : type === "right" ? "r" as const : type === "char" ? "dec" as const : "l" as const };
    })
    .sort((a, b) => a.pos - b.pos);
  if (textRuns.some((r) => r.kind === "text" && r.text.includes("\t"))) {
    const last = tabs[tabs.length - 1]?.pos ?? -Infinity;
    for (let k = 1; k <= 48; k++) {
      const pos = marginLeft + k * defaultTab;
      if (pos > last) tabs.push({ pos, align: "l" });
    }
  }

  const align = pp["fo:text-align"];
  const rtl = pp["style:writing-mode"] === "rl-tb" || pp["style:writing-mode"] === "rl";
  const paragraph: Paragraph = {
    align: align === "center" ? "ctr" : align === "end" || align === "right" ? (rtl ? "l" : "r") : align === "justify" ? (pp["fo:text-align-last"] === "justify" ? "dist" : "just") : rtl && (align === "start" || !align) ? "r" : "l",
    marginLeft,
    indent,
    lineSpacing: { pct: 1 },
    spaceBefore: { pts: lengthOr(pp["fo:margin-top"], 0) / PT },
    spaceAfter: { pts: lengthOr(pp["fo:margin-bottom"], 0) / PT },
    rtl,
    bullet,
    runs: textRuns,
    endSize: size,
    tabs,
    defaultTab,
  };
  return { p: paragraph, spacing, ascent, descent, size: firstRun?.kind === "text" ? firstRun.size : size };
}

/** The `text:list-level-style-*` of a list style for a level, the deepest
 *  one it defines when it stops short. */
function levelOf(listStyle: XmlElement | null, level: number): XmlElement | null {
  if (!listStyle) return null;
  let best: XmlElement | null = null;
  let bestLevel = 0;
  for (const c of listStyle.children) {
    if (!c.name.startsWith("text:list-level-style-")) continue;
    const l = Number(attr(c, "text:level") ?? 1);
    if (l === level) return c;
    if (l < level && l > bestLevel) [best, bestLevel] = [c, l];
  }
  return best;
}

/** Where a list level puts its paragraphs: the text at `marginLeft`, the
 *  label `indent` before it — past the paragraph's own first-line start,
 *  unless `absolute` (the label-alignment mode, which says where outright). */
function listPosition(levelStyle: XmlElement | null): { marginLeft: number; indent: number; absolute: boolean } | null {
  const props = child(levelStyle, "style:list-level-properties");
  if (!props) return null;
  if (attr(props, "text:list-level-position-and-space-mode") === "label-alignment") {
    const align = child(props, "style:list-level-label-alignment");
    return { marginLeft: lengthOr(attr(align, "fo:margin-left"), 0), indent: lengthOr(attr(align, "fo:text-indent"), 0), absolute: true };
  }
  const before = lengthOr(attr(props, "text:space-before"), 0);
  const label = lengthOr(attr(props, "text:min-label-width"), 0);
  return { marginLeft: before + label, indent: -label, absolute: false };
}

/** OpenSymbol (and StarSymbol) keep a few bullets in the private use area. */
const OPENSYMBOL: Record<string, string> = {
  "": "■", "": "□", "": "◆", "": "◇", "": "●", "": "○", "": "➢", "": "✔", "": "✓",
  "": "➔", "": "–", "": "—", "": "•", "": "➤", "": "◼",
};

function readBullet(levelStyle: XmlElement | null, n: number, ctx: TextContext): Bullet | null {
  if (!levelStyle) return null;
  const tp = child(levelStyle, "style:text-properties");
  const props = child(levelStyle, "style:list-level-properties");
  const relSize = percent(attr(levelStyle, "text:bullet-relative-size")) ?? percent(attr(tp, "fo:font-size"));
  const absSize = length(attr(tp, "fo:font-size"));
  const size: Bullet["size"] = relSize !== null ? { pct: relSize } : absSize !== null ? { pts: absSize / PT } : { pct: 1 };
  const c = attr(tp, "style:use-window-font-color") === "true" ? null : color(attr(tp, "fo:color"));
  const face = ctx.pkg.sheet.fontFamily(attr(tp, "style:font-name")) ?? firstFamily(attr(tp, "fo:font-family"));
  if (levelStyle.name === "text:list-level-style-image") {
    const part = partOf(attr(levelStyle, "xlink:href"), ctx);
    if (!part) {
      miss(ctx.misses, "bullet:image");
      return null;
    }
    imageFormatMiss(part, ctx);
    const h = length(attr(props, "fo:height"));
    return { kind: "image", image: { part, crop: null, fill: null, alpha: 1, effects: [] }, size: h ? { pts: h / PT } : { pct: 1 } };
  }
  if (levelStyle.name === "text:list-level-style-number") {
    const format = attr(levelStyle, "style:num-format") ?? "1";
    if (format === "") return null;
    const text = `${attr(levelStyle, "style:num-prefix") ?? ""}${formatNumber(n, format)}${attr(levelStyle, "style:num-suffix") ?? ""}`;
    return { kind: "char", char: text, font: face && !/symbol|wingdings|webdings/i.test(face) ? `"${face}"` : null, color: c, size };
  }
  const raw = attr(levelStyle, "text:bullet-char") ?? "";
  if (raw === "" || raw === " ") return null;
  const symbolic = face !== null && /wingdings|webdings|^symbol$/i.test(face);
  const char = symbolic ? (SYMBOL_BULLETS[raw] ?? "•") : (OPENSYMBOL[raw] ?? (/[-]/.test(raw) ? "•" : raw));
  // OpenSymbol isn't on a machine without LibreOffice; its bullets are
  // plain Unicode any face has.
  const font = face && !symbolic && !/opensymbol|starsymbol/i.test(face) ? `"${face}"` : null;
  return { kind: "char", char, font, color: c, size };
}

function formatNumber(n: number, format: string): string {
  const roman = (v: number): string => {
    const table: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let out = "";
    for (const [value, letters] of table) while (v >= value) {
      out += letters;
      v -= value;
    }
    return out;
  };
  const alpha = (v: number): string => {
    let out = "";
    while (v > 0) {
      v -= 1;
      out = String.fromCharCode(97 + (v % 26)) + out;
      v = Math.floor(v / 26);
    }
    return out;
  };
  switch (format) {
    case "i": return roman(n);
    case "I": return roman(n).toUpperCase();
    case "a": return alpha(n);
    case "A": return alpha(n).toUpperCase();
    default: return String(n);
  }
}

/** Run properties onto runs, element by element. `walker.space`: the last
 *  character drawn was white space (ODF collapses runs of it, and drops it at
 *  the start of a paragraph). */
function walkRuns(el: XmlElement, props: Props, ctx: TextContext, out: TextRun[], walker: { space: boolean }): void {
  const text = (value: string, collapse: boolean): void => {
    let v = value;
    if (collapse) {
      v = v.replace(/[ \t\r\n]+/g, " ");
      if (walker.space) v = v.replace(/^ /, "");
      if (v === "") return;
      walker.space = v.endsWith(" ");
    } else walker.space = false;
    const prev = out[out.length - 1];
    const run = textRun(v, props, ctx);
    // Consecutive text with the same look is one run.
    if (prev?.kind === "text" && sameLook(prev, run)) prev.text += v;
    else out.push(run);
  };
  for (const c of el.children) {
    switch (c.name) {
      case TEXT_NODE:
        text(c.text, true);
        break;
      case "text:s":
        text(" ".repeat(Math.max(1, Math.min(1000, Number(attr(c, "text:c") ?? 1) || 1))), false);
        break;
      case "text:tab":
        text("\t", false);
        break;
      case "text:line-break":
        out.push({ kind: "break", size: fontSize(props) });
        walker.space = true;
        break;
      case "text:span":
      case "text:a": {
        const style = attr(c, "text:style-name");
        const own = style ? ctx.pkg.sheet.resolve(ctx.scope, "text", style).text : null;
        walkRuns(c, own ? merged(props, own) : props, ctx, out, walker);
        break;
      }
      case "text:page-number":
        text(formatNumber(ctx.pageNumber, attr(c, "style:num-format") ?? "1"), false);
        break;
      case "text:page-count":
        text(String(ctx.pageCount), false);
        break;
      case "presentation:footer":
        text(ctx.fields.footer, true);
        break;
      case "presentation:header":
        text(ctx.fields.header, true);
        break;
      case "presentation:date-time":
        text(ctx.fields.dateTime, true);
        break;
      case "text:page-name":
      case "loext:page-name":
        text(ctx.pageName, true);
        break;
      case "office:annotation":
      case "office:annotation-end":
      case "text:bookmark":
      case "text:bookmark-start":
      case "text:bookmark-end":
      case "text:reference-mark":
      case "text:reference-mark-start":
      case "text:reference-mark-end":
      case "text:soft-page-break":
      case "text:change":
      case "text:change-start":
      case "text:change-end":
      case "text:note":
      case "text:hidden-text":
      case "text:ruby-text":
        break;
      default:
        // Other fields (a date, an author, a file name…) keep their last value
        // as their content; so do the wrappers this doesn't know.
        walkRuns(c, props, ctx, out, walker);
    }
  }
}

function sameLook(a: Extract<TextRun, { kind: "text" }>, b: Extract<TextRun, { kind: "text" }>): boolean {
  const { text: _a, ...ra } = a;
  const { text: _b, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb);
}

/** The run's size in points; a percentage nothing resolved is of 18 pt. */
export function fontSize(props: Props): number {
  const raw = props["fo:font-size"];
  const pct = percent(raw);
  if (pct !== null) return 18 * pct;
  const l = length(raw);
  return l !== null && l > 0 ? l / PT : 18;
}

function textRun(value: string, p: Props, ctx: TextContext): Extract<TextRun, { kind: "text" }> {
  const sheet = ctx.pkg.sheet;
  const face = sheet.fontFamily(p["style:font-name"]) ?? firstFamily(p["fo:font-family"]) ?? "Liberation Sans";
  const ea = sheet.fontFamily(p["style:font-name-asian"]) ?? firstFamily(p["style:font-family-asian"]);
  let size = fontSize(p);
  // `style:text-position`: an offset (percent of the size, or super/sub) and
  // the size the raised or lowered text is drawn at.
  let baseline = 0;
  const position = (p["style:text-position"] ?? "").trim().split(/\s+/);
  if (position[0] && position[0] !== "0%") {
    const offset = position[0] === "super" ? 33 : position[0] === "sub" ? -33 : parseFloat(position[0]);
    const rel = percent(position[1] ?? "58%") ?? 0.58;
    if (Number.isFinite(offset) && offset !== 0 && rel > 0) {
      // The renderer draws a raised run at 2/3 of its size, raised by a share
      // of that size (PowerPoint's rule): both undone, so it ends up at the
      // file's size and height.
      size = (size * rel) / RAISED;
      baseline = (offset * RAISED) / rel;
    }
  }
  const weight = p["fo:font-weight"];
  const transform = p["fo:text-transform"];
  let text = value;
  if (transform === "lowercase") text = text.toLowerCase();
  else if (transform === "capitalize") text = text.replace(/(^|\s)(\S)/g, (_m, s: string, c: string) => s + c.toUpperCase());
  const underline = p["style:text-underline-style"];
  const strike = p["style:text-line-through-style"];
  const strikeType = p["style:text-line-through-type"];
  const highlight = p["fo:background-color"];
  const opacity = percent(p["loext:opacity"]);
  const alpha = opacity !== null && opacity > 0 ? opacity : 1;
  const fill: Fill = { kind: "solid", color: p["style:use-window-font-color"] === "true" || !p["fo:color"] ? autoColor(ctx.background) : (color(p["fo:color"], alpha) ?? "rgb(0,0,0)") };
  if (p["style:font-relief"] && p["style:font-relief"] !== "none") miss(ctx.misses, "text:relief");
  const outline = p["style:text-outline"] === "true";
  const shadow = p["fo:text-shadow"] && p["fo:text-shadow"] !== "none" ? p["fo:text-shadow"].trim().split(/\s+/) : null;
  const effects = shadow
    ? (() => {
        const dx = lengthOr(shadow[0], 12700);
        const dy = lengthOr(shadow[1], 12700);
        return { ...NO_EFFECTS, shadow: { color: "rgba(0,0,0,0.5)", blur: lengthOr(shadow[2], 0), dist: Math.hypot(dx, dy), dir: ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360, inner: false, sx: 1, sy: 1 } };
      })()
    : NO_EFFECTS;
  return {
    kind: "text",
    text,
    font: fontList(face, ea && ea !== face ? ea : null),
    size,
    bold: weight === "bold" || (Number(weight) || 0) >= 600,
    italic: p["fo:font-style"] === "italic" || p["fo:font-style"] === "oblique",
    underline: (underline !== undefined && underline !== "none") || (p["style:text-underline-type"] !== undefined && p["style:text-underline-type"] !== "none"),
    strike: (strike !== undefined && strike !== "none") || (strikeType !== undefined && strikeType !== "none") || (p["style:text-crossing-out"] ?? "none") !== "none",
    caps: transform === "uppercase" ? "all" : p["fo:font-variant"] === "small-caps" ? "small" : "none",
    baseline,
    spacing: (length(p["fo:letter-spacing"]) ?? 0) / PT,
    fill: outline ? null : fill,
    outline: outline && fill.kind === "solid" ? { fill, width: 9525, dash: null, cap: "round", join: "round", head: null, tail: null, compound: "sng" } : null,
    highlight: highlight && highlight !== "transparent" ? color(highlight) : null,
    effects,
  };
}

/** LibreOffice's automatic font colour: white on a dark background, else black. */
function autoColor(background: string | null): string {
  const c = background?.startsWith("#") ? rgba(background) : background ? parseRgb(background) : null;
  if (!c || c.a < 0.5) return "rgb(0,0,0)";
  const luminance = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return luminance <= 62 / 255 ? "rgb(255,255,255)" : "rgb(0,0,0)";
}

function parseRgb(css: string): { r: number; g: number; b: number; a: number } | null {
  const m = css.match(/[\d.]+/g)?.map(Number);
  if (!m || m.length < 3) return null;
  return { r: m[0]! / 255, g: m[1]! / 255, b: m[2]! / 255, a: m[3] ?? 1 };
}
