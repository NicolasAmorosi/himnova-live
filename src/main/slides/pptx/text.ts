import type { Bullet, Fill, Paragraph, TextBody, TextRun } from "@shared/types/slide-model";
import { colorIn, css, schemeColor } from "./color";
import { fillIn, miss, NO_EFFECTS, readEffects, readImage, readLine, type StyleContext } from "./style";
import { attr, child, children, isTrue, numAttr, type XmlElement } from "./xml";

export type ThemeFonts = Record<"+mj-lt" | "+mn-lt" | "+mj-ea" | "+mn-ea" | "+mj-cs" | "+mn-cs", string>;

export type TextContext = StyleContext & {
  fonts: ThemeFonts;
  /** The master's `p:txStyles`. */
  txStyles: XmlElement | null;
  /** `presentation.xml`'s `p:defaultTextStyle`. */
  defaultTextStyle: XmlElement | null;
  slideNumber: number;
};

/** Which of the master's text styles a placeholder takes its levels from. */
export type TextCategory = "title" | "body" | "other";

/**
 * A shape's text with every property resolved. `inherited` are the `txBody`s
 * of the placeholders this shape inherits from (layout, then master), most
 * specific first; `fontRef` is the shape style's font reference.
 */
export function readTextBody(
  txBody: XmlElement,
  inherited: XmlElement[],
  category: TextCategory | null,
  fontRef: XmlElement | null,
  ctx: TextContext,
): TextBody {
  const bodies = [txBody, ...inherited];
  const bodyPrs = bodies.map((b) => child(b, "a:bodyPr")).filter((b): b is XmlElement => b !== null);
  const first = (name: string): string | null => {
    for (const b of bodyPrs) if (b.attrs[name] !== undefined) return b.attrs[name];
    return null;
  };
  const num = (name: string, fallback: number): number => {
    const v = first(name);
    return v === null || !Number.isFinite(Number(v)) ? fallback : Number(v);
  };

  let autofit: TextBody["autofit"] = { kind: "none" };
  for (const b of bodyPrs) {
    const norm = child(b, "a:normAutofit");
    if (norm) {
      const scale = attr(norm, "fontScale");
      autofit = {
        kind: "normal",
        fontScale: scale === null ? null : Number(scale) / 100000,
        lineReduction: numAttr(norm, "lnSpcReduction", 0) / 100000,
      };
      break;
    }
    if (child(b, "a:spAutoFit")) {
      autofit = { kind: "shape" };
      break;
    }
    if (child(b, "a:noAutofit")) break;
  }
  if (bodyPrs.some((b) => child(b, "a:prstTxWarp") && attr(child(b, "a:prstTxWarp"), "prst") !== "textNoShape")) {
    miss(ctx, "text:warp");
  }
  if (bodyPrs.some((b) => child(b, "a:scene3d") || child(b, "a:sp3d"))) miss(ctx, "text:3d");

  const vert = first("vert") ?? "horz";
  const anchor = first("anchor");
  const fontScale = autofit.kind === "normal" ? (autofit.fontScale ?? 1) : 1;
  const lineReduction = autofit.kind === "normal" ? autofit.lineReduction : 0;

  const paragraphs: Paragraph[] = [];
  const counters = new Map<string, number>();
  for (const p of children(txBody, "a:p")) {
    const paragraph = readParagraph(p, bodies, category, fontRef, ctx, fontScale, lineReduction, counters);
    paragraphs.push(paragraph);
  }

  return {
    insets: { l: num("lIns", 91440), t: num("tIns", 45720), r: num("rIns", 91440), b: num("bIns", 45720) },
    anchor: anchor === "ctr" || anchor === "b" ? anchor : "t",
    anchorCenter: first("anchorCtr") === "1",
    wrap: first("wrap") !== "none",
    vertical: vert === "vert" || vert === "vert270" || vert === "eaVert" || vert === "wordArtVert" ? vert : "horz",
    autofit,
    columns: { count: Math.max(1, num("numCol", 1)), spacing: num("spcCol", 0) },
    rotation: num("rot", 0) / 60000,
    upright: first("upright") === "1",
    paragraphs,
  };
}

/** The `lvlNpPr` elements that apply to a paragraph at `level` (1..9), most
 *  specific first: the shape's and its placeholders' list styles, the master
 *  text style, then the presentation default. */
function levelChain(level: number, bodies: XmlElement[], category: TextCategory | null, ctx: TextContext): XmlElement[] {
  const name = `a:lvl${level}pPr`;
  const out: XmlElement[] = [];
  for (const b of bodies) {
    const l = child(child(b, "a:lstStyle"), name);
    if (l) out.push(l);
  }
  if (category) {
    const style = child(ctx.txStyles, category === "title" ? "p:titleStyle" : category === "body" ? "p:bodyStyle" : "p:otherStyle");
    const l = child(style, name);
    if (l) out.push(l);
  }
  const d = child(ctx.defaultTextStyle, name);
  if (d) out.push(d);
  return out;
}

function readParagraph(
  p: XmlElement,
  bodies: XmlElement[],
  category: TextCategory | null,
  fontRef: XmlElement | null,
  ctx: TextContext,
  fontScale: number,
  lineReduction: number,
  counters: Map<string, number>,
): Paragraph {
  const pPr = child(p, "a:pPr");
  const level = Math.min(9, Math.max(1, numAttr(pPr, "lvl", 0) + 1));
  const chain = [pPr, ...levelChain(level, bodies, category, ctx)].filter((x): x is XmlElement => x !== null);
  const pick = (name: string): string | null => {
    for (const el of chain) if (el.attrs[name] !== undefined) return el.attrs[name];
    return null;
  };
  const pickChild = (name: string): XmlElement | null => {
    for (const el of chain) {
      const c = child(el, name);
      if (c) return c;
    }
    return null;
  };
  const spacing = (name: string, fallback: { pct: number } | { pts: number }): { pct: number } | { pts: number } => {
    const s = pickChild(name);
    const pct = child(s, "a:spcPct");
    if (pct) return { pct: numAttr(pct, "val", 100000) / 100000 };
    const pts = child(s, "a:spcPts");
    if (pts) return { pts: numAttr(pts, "val", 0) / 100 };
    return fallback;
  };

  // Run defaults: each level's defRPr, then the shape style's font reference.
  const defRPrs = chain.map((el) => child(el, "a:defRPr")).filter((x): x is XmlElement => x !== null);
  const runs: TextRun[] = [];
  for (const r of p.children) {
    if (r.name === "a:br") {
      runs.push({ kind: "break", size: sizeOf([child(r, "a:rPr"), ...defRPrs]) * fontScale });
      continue;
    }
    if (r.name !== "a:r" && r.name !== "a:fld") continue;
    let text = child(r, "a:t")?.text ?? "";
    if (r.name === "a:fld" && attr(r, "type") === "slidenum") text = String(ctx.slideNumber);
    if (text === "") continue;
    runs.push(readRun(text, [child(r, "a:rPr"), ...defRPrs], fontRef, ctx, fontScale));
  }

  const endSize = sizeOf([child(p, "a:endParaRPr"), ...defRPrs]) * fontScale;
  const lineSpacing = spacing("a:lnSpc", { pct: 1 });

  return {
    align: alignOf(pick("algn")),
    marginLeft: Number(pick("marL") ?? 0),
    indent: Number(pick("indent") ?? 0),
    lineSpacing: "pct" in lineSpacing ? { pct: Math.max(0, lineSpacing.pct - lineReduction) } : lineSpacing,
    spaceBefore: spacing("a:spcBef", { pts: 0 }),
    spaceAfter: spacing("a:spcAft", { pts: 0 }),
    rtl: pick("rtl") === "1",
    bullet: runs.some((r) => r.kind === "text") ? readBullet(chain, runs, ctx, counters, level) : null,
    runs,
    endSize,
    tabs: children(pickChild("a:tabLst"), "a:tab")
      .map((t) => ({ pos: numAttr(t, "pos", 0), align: tabAlign(attr(t, "algn")) }))
      .sort((a, b) => a.pos - b.pos),
    defaultTab: Number(pick("defTabSz") ?? 914400) || 914400,
  };
}

function tabAlign(v: string | null): Paragraph["tabs"][number]["align"] {
  return v === "ctr" || v === "r" || v === "dec" ? v : "l";
}

function alignOf(v: string | null): Paragraph["align"] {
  return v === "ctr" || v === "r" || v === "just" || v === "dist" ? v : v === "justLow" || v === "thaiDist" ? "just" : "l";
}

function sizeOf(rPrs: (XmlElement | null)[]): number {
  for (const r of rPrs) if (r?.attrs["sz"] !== undefined) return Number(r.attrs["sz"]) / 100;
  return 18;
}

function readRun(text: string, rPrs: (XmlElement | null)[], fontRef: XmlElement | null, ctx: TextContext, fontScale: number): TextRun {
  const list = rPrs.filter((x): x is XmlElement => x !== null);
  const pick = (name: string): string | null => {
    for (const el of list) if (el.attrs[name] !== undefined) return el.attrs[name];
    return null;
  };
  const pickChild = (name: string): XmlElement | null => {
    for (const el of list) {
      const c = child(el, name);
      if (c) return c;
    }
    return null;
  };

  // The fill: the first rPr that names one; else the style's font colour;
  // else the theme's text colour.
  let fill: Fill | null | undefined;
  for (const el of list) {
    fill = fillIn(el, ctx);
    if (fill !== undefined) break;
  }
  if (fill === undefined) {
    const c = colorIn(fontRef, ctx.colors) ?? schemeColor("tx1", ctx.colors);
    fill = c ? { kind: "solid", color: css(c) } : { kind: "solid", color: "rgb(0,0,0)" };
  }

  const latin = attr(pickChild("a:latin"), "typeface");
  const ea = attr(pickChild("a:ea"), "typeface");
  const refFont = attr(fontRef, "idx") === "major" ? "+mj-lt" : "+mn-lt";
  const face = resolveFace(latin ?? refFont, ctx) ?? resolveFace("+mn-lt", ctx) ?? "Calibri";
  const eaFace = ea ? resolveFace(ea, ctx) : null;

  const highlight = colorIn(pickChild("a:highlight"), ctx.colors);
  const underline = pick("u");
  const strike = pick("strike");
  const cap = pick("cap");
  const outlineEl = pickChild("a:ln");
  const effectsHolder = list.find((el) => child(el, "a:effectLst")) ?? null;
  return {
    kind: "text",
    text,
    font: fontList(face, eaFace),
    size: sizeOf(list) * fontScale,
    bold: isTrue(pick("b")),
    italic: isTrue(pick("i")),
    underline: underline !== null && underline !== "none",
    strike: strike !== null && strike !== "noStrike",
    caps: cap === "all" ? "all" : cap === "small" ? "small" : "none",
    baseline: Number(pick("baseline") ?? 0) / 1000,
    spacing: Number(pick("spc") ?? 0) / 100,
    fill,
    outline: outlineEl && !child(outlineEl, "a:noFill") ? readLine(outlineEl, ctx, null) : null,
    highlight: highlight ? css(highlight) : null,
    effects: effectsHolder ? readEffects(effectsHolder, ctx, NO_EFFECTS) : NO_EFFECTS,
  };
}

function resolveFace(typeface: string | null, ctx: TextContext): string | null {
  if (!typeface) return null;
  if (typeface in ctx.fonts) return ctx.fonts[typeface as keyof ThemeFonts] || null;
  return typeface;
}

/**
 * Faces that ship with Office but not with macOS or Linux, and the
 * metric-compatible faces that keep the file's line breaks when they are
 * missing. Listed after the file's own face, so an installed original wins.
 */
export const METRIC_TWINS: Record<string, string[]> = {
  calibri: ["Carlito"],
  "calibri light": ["Carlito"],
  cambria: ["Caladea"],
  arial: ["Liberation Sans", "Arimo"],
  "times new roman": ["Liberation Serif", "Tinos"],
  "courier new": ["Liberation Mono", "Cousine"],
  "arial narrow": ["Liberation Sans Narrow"],
  // ChromeOS's names for the Liberation designs (Google Slides writes them).
  arimo: ["Liberation Sans"],
  tinos: ["Liberation Serif"],
  cousine: ["Liberation Mono"],
};

export function fontList(face: string, ea: string | null): string {
  const faces = [face, ...(METRIC_TWINS[face.toLowerCase()] ?? []), ...(ea && ea !== face ? [ea] : [])];
  return [...faces.map((f) => `"${f.replace(/"/g, "")}"`), "sans-serif"].join(", ");
}

const SYMBOL_BYTE_BULLETS: Record<string, string> = {
  "§": "▪", "Ø": "➢", "ü": "✓", "q": "❑", "v": "❖", "n": "■", "l": "●", "o": "○", "Ü": "➢", "à": "➔",
  "è": "➔", "Ÿ": "•", "·": "•",
};

/** Bullets drawn with a symbol font map to the Unicode character they show:
 *  Wingdings and Symbol are not on a Mac or a Linux box. A file stores the
 *  font's byte either as is or in the private-use page U+F0xx. */
export const SYMBOL_BULLETS: Record<string, string> = {
  ...SYMBOL_BYTE_BULLETS,
  ...Object.fromEntries(Object.entries(SYMBOL_BYTE_BULLETS).map(([k, v]) => [String.fromCharCode(0xf000 + k.charCodeAt(0)), v])),
};

function readBullet(chain: XmlElement[], runs: TextRun[], ctx: TextContext, counters: Map<string, number>, level: number): Bullet | null {
  // The first level element that says anything about bullets decides.
  let kind: XmlElement | null = null;
  for (const el of chain) {
    kind = child(el, "a:buNone") ?? child(el, "a:buChar") ?? child(el, "a:buAutoNum") ?? child(el, "a:buBlip");
    if (kind) break;
  }
  if (!kind || kind.name === "a:buNone") {
    for (const k of [...counters.keys()]) if (k.startsWith(`${level}:`)) counters.delete(k);
    return null;
  }
  const pickChild = (name: string): XmlElement | null => {
    for (const el of chain) {
      const c = child(el, name);
      if (c) return c;
    }
    return null;
  };
  const firstRun = runs.find((r) => r.kind === "text");
  const sizePct = pickChild("a:buSzPct");
  const sizePts = pickChild("a:buSzPts");
  const size = sizePts ? { pts: numAttr(sizePts, "val", 0) / 100 } : { pct: sizePct ? numAttr(sizePct, "val", 100000) / 100000 : 1 };
  const buFont = attr(pickChild("a:buFont"), "typeface");
  const color = colorIn(pickChild("a:buClr"), ctx.colors);
  const colorCss = color ? css(color) : firstRun?.kind === "text" && firstRun.fill?.kind === "solid" ? firstRun.fill.color : null;
  const font = buFont && !/wingdings|symbol|webdings/i.test(buFont) ? `"${buFont}"` : null;

  if (kind.name === "a:buBlip") {
    const image = readImage(kind, ctx);
    if (image) return { kind: "image", image, size };
    miss(ctx, "bullet:image");
    return null;
  }
  if (kind.name === "a:buChar") {
    const raw = attr(kind, "char") ?? "•";
    const char = buFont && /wingdings|symbol|webdings/i.test(buFont) ? (SYMBOL_BULLETS[raw] ?? "•") : raw;
    return { kind: "char", char, font, color: colorCss, size };
  }
  // Numbered: counted per level over consecutive paragraphs numbered with the
  // same scheme — a different scheme (or startAt) starts again.
  const scheme = attr(kind, "type") ?? "arabicPeriod";
  const startAt = numAttr(kind, "startAt", 1);
  const key = `${level}:${scheme}:${startAt}`;
  for (const k of [...counters.keys()]) if (k.startsWith(`${level}:`) && k !== key) counters.delete(k);
  const next = (counters.get(key) ?? startAt - 1) + 1;
  counters.set(key, next);
  return { kind: "char", char: autoNumber(scheme, next), font, color: colorCss, size };
}

function autoNumber(scheme: string, n: number): string {
  const roman = (v: number): string => {
    const table: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let out = "";
    for (const [value, letters] of table) while (v >= value) { out += letters; v -= value; }
    return out;
  };
  const alpha = (v: number): string => {
    let out = "";
    while (v > 0) { v -= 1; out = String.fromCharCode(97 + (v % 26)) + out; v = Math.floor(v / 26); }
    return out;
  };
  const body = scheme.startsWith("romanUc") ? roman(n).toUpperCase()
    : scheme.startsWith("romanLc") ? roman(n)
    : scheme.startsWith("alphaUc") ? alpha(n).toUpperCase()
    : scheme.startsWith("alphaLc") ? alpha(n)
    : String(n);
  if (scheme.endsWith("ParenBoth")) return `(${body})`;
  if (scheme.endsWith("ParenR")) return `${body})`;
  if (scheme.endsWith("Plain")) return body;
  if (scheme.endsWith("Minus")) return `- ${body} -`;
  return `${body}.`;
}
