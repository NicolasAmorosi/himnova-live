import type { Effects, Fill, Frame, GroupElement, Line, ShapeElement, SlideElement } from "@shared/types/slide-model";
import { resolveColor, toHsl } from "./color";
import { evaluateGeometry, type PresetTable } from "./geometry";
import { between, newState, place, props, shapeType, visibleShape, type LayoutState } from "./smartart/layout";
import { buildLayoutTree, readDataModel, select, variable, type Box, type DataModel, type LayoutNode, type Point } from "./smartart/model";
import { fillIn, miss, NO_EFFECTS, readEffects, readLine, themeStyle } from "./style";
import { readTextBody, type TextContext } from "./text";
import { attr, child, children, parseXml, type XmlElement } from "./xml";

/**
 * SmartArt saved without its drawing (by LibreOffice, python-pptx, older
 * Office, or with the drawing stripped): laid out here from its data model,
 * layout definition, quick style and colours, the way PowerPoint re-lays it
 * out on open, into plain shapes. An approximation — PowerPoint solves the
 * layout's constraints and rules together; this applies the constraints, runs
 * the algorithms over them and fits the text afterwards — but never nothing:
 * a layout it can't make sense of falls back to the basic grid of boxes.
 */
export type DiagramParts = {
  data: XmlElement | null;
  layout: XmlElement | null;
  style: XmlElement | null;
  colors: XmlElement | null;
  /** The part whose relationships the data model's pictures resolve against. */
  dataPart: string;
};

export function layoutSmartArt(parts: DiagramParts, frame: Frame, ctx: TextContext, presets: PresetTable): GroupElement {
  const model = readDataModel(parts.data);
  const env: Env = { model, parts, ctx: { ...ctx, part: parts.dataPart }, presets };
  let elements = run(buildLayoutTree(parts.layout, model), frame, env);
  if (elements.length === 0 && hasText(model.root)) elements = run(buildLayoutTree(fallbackLayout(), model), frame, env);
  return { kind: "group", frame, childFrame: { x: 0, y: 0, w: frame.w || 1, h: frame.h || 1 }, children: elements };
}

type Env = { model: DataModel; parts: DiagramParts; ctx: TextContext; presets: PresetTable };

function hasText(p: Point): boolean {
  return pointHasText(p) || p.children.some(hasText);
}

function pointHasText(p: Point): boolean {
  return (p.text?.children ?? []).some((para) => para.name === "a:p" && para.children.some((r) => r.name === "a:r" && (child(r, "a:t")?.text ?? "") !== ""));
}

function run(root: LayoutNode | null, frame: Frame, env: Env): SlideElement[] {
  if (!root) return [];
  // Box sizes may follow the font size the text ends up at (a list row as
  // tall as its text), and the font size follows the boxes: a few rounds. A
  // diagram whose font-sized parts overflow the frame shrinks its text first,
  // as PowerPoint's rules do, before anything is scaled down.
  let fitted = new Map<string, number>();
  let state = newState(fitted);
  let drawn = fitted;
  for (let round = 0; round < 6; round++) {
    reset(root);
    state = newState(fitted);
    root.props.set("w", frame.w);
    root.props.set("h", frame.h);
    const own = props(root, state);
    const pw = own.get("w") ?? frame.w, ph = own.get("h") ?? frame.h;
    const k = Math.min(frame.w / pw, frame.h / ph);
    const w = Number.isFinite(k) && k > 0 ? pw * k : frame.w;
    const h = Number.isFinite(k) && k > 0 ? ph * k : frame.h;
    place(root, { x: (frame.w - w) / 2, y: (frame.h - h) / 2, w, h }, state);
    placeConnectors(root, state, env);
    const over = overflow(root, frame);
    if (state.fontLengths && over < 0.97 && round < 4) {
      fitted = shrinkFonts(root, state, fitted, over, env);
      continue;
    }
    fitInto(root, frame);
    drawn = fitText(root, state, env);
    if (!state.fontLengths || same(drawn, fitted)) break;
    fitted = drawn;
  }
  const out: SlideElement[] = [];
  const bg = background(frame, env);
  if (bg) out.push(bg);
  draw(root, state, drawn, env, out);
  return out;
}

/** The diagram's own background and outline (`dgm:bg`, `dgm:whole`). */
function background(frame: Frame, env: Env): ShapeElement | null {
  const dm = env.parts.data;
  const fill = fillIn(child(dm, "dgm:bg"), env.ctx) ?? null;
  const line = readLine(child(child(dm, "dgm:whole"), "a:ln"), env.ctx, null);
  if (!fill && !line?.fill) return null;
  const box = { x: 0, y: 0, w: frame.w, h: frame.h };
  const geom = evaluateGeometry(env.presets.get("rect")!, box.w, box.h);
  return { kind: "shape", frame: frameOf(box, 0), paths: geom.paths, fill, line: line?.fill ? line : null, effects: NO_EFFECTS, textRect: geom.textRect, text: null };
}

function same(a: Map<string, number>, b: Map<string, number>): boolean {
  return a.size === b.size && [...a].every(([k, v]) => Math.abs((b.get(k) ?? 0) - v) < 0.5);
}

function shrinkFonts(root: LayoutNode, s: LayoutState, fitted: Map<string, number>, k: number, env: Env): Map<string, number> {
  const out = new Map(fitted);
  walk(root, (n) => {
    if (paragraphs(n, env).length === 0) return;
    const now = fitted.get(n.name) ?? fontSizes(n, s).prim;
    out.set(n.name, Math.max(5, Math.min(out.get(n.name) ?? Infinity, now * Math.max(0.5, k))));
  });
  return out;
}

function leafBounds(root: LayoutNode): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  walk(root, (n) => {
    if (!n.box || n.children.length > 0 || (n.alg === "sp" && !visibleShape(n))) return;
    x0 = Math.min(x0, n.box.x);
    y0 = Math.min(y0, n.box.y);
    x1 = Math.max(x1, n.box.x + n.box.w);
    y1 = Math.max(y1, n.box.y + n.box.h);
  });
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/** How much the drawing must shrink to fit the frame (1: it fits). */
function overflow(root: LayoutNode, frame: Frame): number {
  const b = leafBounds(root);
  if (!b) return 1;
  return Math.min(1, frame.w / Math.max(1, b.x1 - b.x0), frame.h / Math.max(1, b.y1 - b.y0));
}

function reset(n: LayoutNode): void {
  n.props = new Map();
  n.box = null;
  n.rot = 0;
  n.adjust = null;
  for (const c of n.children) reset(c);
}

const walk = (n: LayoutNode, f: (n: LayoutNode) => void): void => {
  f(n);
  for (const c of n.children) walk(c, f);
};

const isConn = (n: LayoutNode): boolean => n.alg === "conn" || shapeType(n) === "conn";

function textPoints(n: LayoutNode, env: Env): Point[] {
  if (!n.presOf || Object.keys(n.presOf.attrs).length === 0) return [];
  return select(n.presOf, n.point, env.model);
}

/** The depth a node's text counts its levels from: where its last `des`
 *  step started (a body under a title: its items are level 1), else its
 *  shallowest point (`ch ch desOrSelf` reaches a grandchild: level 0). */
function textBase(n: LayoutNode, points: Point[], env: Env): number {
  const el = n.presOf;
  const axes = (attr(el, "axis") ?? "").split(/\s+/).filter(Boolean);
  const last = axes[axes.length - 1];
  if (el && (last === "des" || last === "desOrSelf")) {
    const cut = (name: string): string => (attr(el, name) ?? "").split(/\s+/).filter(Boolean).slice(0, axes.length - 1).join(" ");
    const head = axes.length > 1 ? select({ ...el, attrs: { ...el.attrs, axis: cut("axis"), ptType: cut("ptType"), st: cut("st"), cnt: cut("cnt") } }, n.point, env.model) : [n.point];
    if (head.length > 0) return Math.min(...head.map((p) => p.depth));
  }
  return points.length > 0 ? Math.min(...points.map((p) => p.depth)) : n.point.depth;
}

/** Does this node draw anything: a shape, or text? */
function draws(n: LayoutNode, env: Env): boolean {
  if (!n.box || isConn(n)) return false;
  return visibleShape(n) || paragraphs(n, env).length > 0;
}

/** The drawn node that stands for a data point (a connector's ends). */
function nodeFor(root: LayoutNode, p: Point | null, env: Env, name?: string): LayoutNode | null {
  if (!p) return null;
  let found: LayoutNode | null = null;
  let named: LayoutNode | null = null;
  walk(root, (n) => {
    if (n.point !== p || !n.box) return;
    if (name && n.name === name && !named) named = n;
    if (!found && draws(n, env)) found = n;
  });
  return named ?? found;
}

/** The two points a connector joins: a sibling transition joins its node to
 *  the next (the first, round a cycle); a parent transition, parent to child. */
function ends(p: Point): [Point | null, Point | null] {
  if (p.type === "parTrans") return [p.parent, p.owner];
  if (p.type === "sibTrans" && p.owner && p.parent) {
    const sibs = p.parent.children;
    const at = sibs.indexOf(p.owner);
    return [p.owner, sibs[at + 1] ?? sibs[0] ?? null];
  }
  return [null, null];
}

/** Connectors no algorithm placed: along the gap between what they join. */
function placeConnectors(root: LayoutNode, s: LayoutState, env: Env): void {
  walk(root, (n) => {
    if (!isConn(n) || n.params.get("dim") === "1D") return;
    const placed = n.parent && (n.parent.alg === "lin" || n.parent.alg === "cycle" || n.parent.alg === "snake");
    if (placed && n.box) return;
    const [a, b] = ends(n.point);
    const from = nodeFor(root, a, env, n.params.get("srcNode"));
    const to = nodeFor(root, b, env, n.params.get("dstNode"));
    if (from?.box && to?.box && from !== to) between(n, from.box, to.box, s);
    else n.box = null;
  });
}

/** The drawing is centred in the frame, and what spills out of it is scaled
 *  back in (a funnel two thirds the width of its box sits mid-frame). */
function fitInto(root: LayoutNode, frame: Frame): void {
  const b = leafBounds(root);
  if (!b) return;
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const k = Math.min(1, frame.w / bw, frame.h / bh);
  const dx = (frame.w - bw * k) / 2 - b.x0 * k;
  const dy = (frame.h - bh * k) / 2 - b.y0 * k;
  walk(root, (n) => {
    if (n.box) n.box = { x: n.box.x * k + dx, y: n.box.y * k + dy, w: n.box.w * k, h: n.box.h * k };
  });
}

// --- text ------------------------------------------------------------------

/** `wide`: how much wider than Calibri its face and weight set (Tahoma bold ≈ 1.3). */
type Para = { el: XmlElement; level: number; text: string; bullet: boolean; wide: number };

function paragraphs(n: LayoutNode, env: Env): Para[] {
  if (n.alg === "sp") return [];
  const bullets = variable("bulletEnabled", n, env.model) === "1";
  const stBullet = Number(n.params.get("stBulletLvl") ?? 1) || 1;
  const out: Para[] = [];
  const points = textPoints(n, env);
  const base = textBase(n, points, env);
  for (const p of points) {
    const level = Math.max(0, p.depth - base);
    for (const el of children(p.text, "a:p")) {
      const text = el.children.filter((r) => r.name === "a:r" || r.name === "a:fld").map((r) => child(r, "a:t")?.text ?? "").join("");
      if (text.trim() === "") continue;
      out.push({ el, level, text, bullet: bullets && level >= stBullet, wide: widthFactor(el, n, env) });
    }
  }
  return out;
}

/** A ceiling well above real SmartArt text (65 pt when the layout says nothing). The fit loop below shrinks a
 *  point at a time from the start size, so a `primFontSz` of 1e20 from the file (where `1e20 - 1 === 1e20`) hung
 *  the deck worker for good (2026-11-15 audit, S4). */
const MAX_FONT_PT = 400;

/** Sizes, in points, of a node's first-level text and of the rest. */
function fontSizes(n: LayoutNode, s: LayoutState): { prim: number; sec: number } {
  const p = props(n, s);
  const prim = Math.min(p.get("primFontSz") ?? 65, MAX_FONT_PT);
  return { prim, sec: p.get("secFontSz") ?? prim * 0.78 };
}

const MARGIN_DEFAULT = 0.56;

function margins(n: LayoutNode, size: number, s: LayoutState): { l: number; t: number; r: number; b: number } {
  const p = props(n, s);
  const f = s.marginFactors.get(n);
  const m = (k: string): number => {
    const fact = f?.get(k);
    if (fact !== undefined) return fact * size * 12700;
    return p.get(k) ?? MARGIN_DEFAULT * size * 12700;
  };
  return { l: m("lMarg"), t: m("tMarg"), r: m("rMarg"), b: m("bMarg") };
}

/** Average advance of a face against Calibri's, by family name. */
const FACE_WIDTH: [RegExp, number][] = [
  [/verdana/i, 1.3], [/tahoma|segoe ui|trebuchet|century gothic|lucida sans/i, 1.18], [/arial|helvetica|liberation sans|arimo|open sans|noto sans|roboto|montserrat|poppins/i, 1.12],
  [/franklin|gill sans|candara|corbel/i, 1.05], [/times|georgia|cambria|garamond|book antiqua|palatino/i, 1.02],
];

function widthFactor(p: XmlElement, n: LayoutNode, env: Env): number {
  const rPr = child(p.children.find((r) => r.name === "a:r") ?? null, "a:rPr");
  const named = attr(child(rPr, "a:latin"), "typeface");
  const face = named && !named.startsWith("+") ? named : env.ctx.fonts[named === "+mj-lt" || attr(child(child(byLabel(env.parts.style, styleLabel(n, env)), "dgm:style"), "a:fontRef"), "idx") === "major" ? "+mj-lt" : "+mn-lt"];
  const base = FACE_WIDTH.find(([re]) => re.test(face ?? ""))?.[1] ?? 1;
  return base * (attr(rPr, "b") === "1" ? 1.07 : 1);
}

/** Width of a character in ems — Calibri's, near enough for any sans.
 *  ponytail: a width table, not the font's metrics; text that fits by a hair
 *  may wrap differently. Measure with the embedded/Office fonts if it shows. */
function charWidth(ch: string): number {
  if (ch === " ") return 0.23;
  if ("ijl.,:;'|!`íìï".includes(ch)) return 0.24;
  if ("frtI()[]{}\"-/".includes(ch)) return 0.34;
  if ("mM".includes(ch)) return 0.82;
  if ("wW".includes(ch)) return 0.78;
  if (ch >= "A" && ch <= "Z") return 0.6;
  if (ch >= "0" && ch <= "9") return 0.51;
  return 0.5;
}

/** Does the text fit a box at this size? Every word on one line, every line
 *  within the height (90 % line spacing, a little after each paragraph). */
function fitsAt(paras: Para[], size: number, ratio: number, inner: { w: number; h: number }): boolean {
  let height = 0;
  paras.forEach((p, i) => {
    const em = size * (p.level === 0 ? 1 : ratio) * 12700;
    const indent = p.bullet ? 171450 * p.level : 0;
    const width = Math.max(1, inner.w - indent);
    let lines = 1;
    let line = 0;
    for (const word of p.text.split(/\s+/).filter(Boolean)) {
      const ww = [...word].reduce((a, c) => a + charWidth(c), 0) * em * p.wide;
      if (ww > width) {
        height = Infinity;
        return;
      }
      const space = line > 0 ? 0.23 * em * p.wide : 0;
      if (line + space + ww > width) {
        lines += 1;
        line = ww;
      } else line += space + ww;
    }
    height += lines * em * 1.08 + (i < paras.length - 1 ? em * (p.level === 0 ? 0.42 : 0.18) : 0);
  });
  return height <= inner.h;
}

/** SmartArt shrinks text to fit, and keeps nodes of the same kind at one size:
 *  each node's largest size that fits, the smallest of them per name. */
function fitText(root: LayoutNode, s: LayoutState, env: Env): Map<string, number> {
  const best = new Map<string, number>();
  walk(root, (n) => {
    if (!n.box || isConn(n) || n.box.w <= 0 || n.box.h <= 0) return;
    const paras = paragraphs(n, env);
    if (paras.length === 0) return;
    const { prim, sec } = fontSizes(n, s);
    const ratio = prim > 0 ? sec / prim : 0.78;
    const geom = geometryFor(n, env, n.box);
    const rect = { w: geom.textRect.r - geom.textRect.l, h: geom.textRect.b - geom.textRect.t };
    let size = Math.max(5, prim);
    for (; size > 5; size -= size > 20 ? 1 : 0.5) {
      const m = margins(n, size, s);
      if (fitsAt(paras, size, ratio, { w: rect.w - m.l - m.r, h: rect.h - m.t - m.b })) break;
    }
    best.set(n.name, Math.min(best.get(n.name) ?? Infinity, Math.max(5, size)));
  });
  return best;
}

function textBody(n: LayoutNode, size: number, paras: Para[], style: NodeStyle, s: LayoutState): XmlElement {
  const { prim, sec } = fontSizes(n, s);
  const ratio = prim > 0 ? sec / prim : 0.78;
  const m = margins(n, size, s);
  const hasTop = paras.some((p) => p.level === 0);
  const anchorParam = hasTop ? n.params.get("txAnchorVert") : (n.params.get("txAnchorVertCh") ?? (paras.some((p) => p.bullet) ? "t" : n.params.get("txAnchorVert")));
  const anchor = anchorParam === "t" ? "t" : anchorParam === "b" ? "b" : "ctr";
  const topAlign = n.params.get("parTxLTRAlign") ?? "ctr";
  const childAlign = n.params.get("shpTxLTRAlignCh") ?? "l";
  const el = (name: string, attrs: Record<string, string>, kids: XmlElement[] = []): XmlElement => ({ name, attrs, children: kids, text: "" });
  // The quick style's font, not the presentation's default text style (an old
  // deck's Times New Roman): SmartArt text takes its face from its `fontRef`.
  const face = attr(style.fontRef, "idx") === "major" ? "+mj" : "+mn";
  const color = [...(style.text ? [el("a:solidFill", {}, [style.text])] : []), el("a:latin", { typeface: `${face}-lt` }), el("a:ea", { typeface: `${face}-ea` }), el("a:cs", { typeface: `${face}-cs` })];
  const levels = Array.from({ length: 9 }, (_, k) =>
    el(`a:lvl${k + 1}pPr`, {}, [el("a:defRPr", { sz: String(Math.round((k === 0 || !hasTop ? size : size * ratio) * 100)) }, color)]),
  );
  const ps = paras.map((p) => {
    const pPr = child(p.el, "a:pPr");
    const algn = p.bullet ? childAlign : topAlign;
    const attrs: Record<string, string> = {
      algn: algn === "l" || algn === "r" ? algn : "ctr",
      ...(p.bullet ? { marL: String(171450 * p.level), indent: "-171450" } : {}),
      ...pPr?.attrs,
      lvl: String(Math.min(8, hasTop ? p.level : 0)),
    };
    const own = pPr?.children ?? [];
    const has = (name: string): boolean => own.some((c) => c.name === name);
    const kids = [...own];
    if (!has("a:lnSpc")) kids.push(el("a:lnSpc", {}, [el("a:spcPct", { val: "90000" })]));
    if (!has("a:spcBef")) kids.push(el("a:spcBef", {}, [el("a:spcPct", { val: "0" })]));
    if (!has("a:spcAft")) kids.push(el("a:spcAft", {}, [el("a:spcPct", { val: p.level === 0 ? "35000" : "15000" })]));
    if (!["a:buNone", "a:buChar", "a:buAutoNum", "a:buBlip"].some(has)) kids.push(p.bullet ? el("a:buChar", { char: "•" }) : el("a:buNone", {}));
    return { ...p.el, children: [el("a:pPr", attrs, kids), ...p.el.children.filter((c) => c.name !== "a:pPr")] };
  });
  return el("a:txBody", {}, [
    el("a:bodyPr", { wrap: "square", lIns: r(m.l), tIns: r(m.t), rIns: r(m.r), bIns: r(m.b), anchor, anchorCtr: "0" }, [el("a:noAutofit", {})]),
    el("a:lstStyle", {}, levels),
    ...ps,
  ]);
}

const r = (v: number): string => String(Math.max(0, Math.round(v)));

// --- style -----------------------------------------------------------------

type NodeStyle = { fill: Fill | null; line: Line | null; effects: Effects; text: XmlElement | null; fontRef: XmlElement | null };

function presPoint(n: LayoutNode, env: Env): XmlElement | null {
  return env.model.pres.get(`${n.point.id}|${n.name}`) ?? null;
}

function styleLabel(n: LayoutNode, env: Env): string {
  const pres = attr(child(presPoint(n, env), "dgm:prSet"), "presStyleLbl");
  if (pres) return pres;
  for (let a: LayoutNode | null = n; a; a = a.parent) if (a.styleLbl) return a.styleLbl;
  return isConn(n) ? (n.params.get("dim") === "1D" ? "parChTrans1D1" : "sibTrans2D1") : "node1";
}

function styleIndex(n: LayoutNode, env: Env): { idx: number; cnt: number } {
  const prSet = child(presPoint(n, env), "dgm:prSet");
  const idx = attr(prSet, "presStyleIdx");
  const cnt = attr(prSet, "presStyleCnt");
  if (idx !== null) return { idx: Number(idx) || 0, cnt: Number(cnt ?? 1) || 1 };
  const sibs = n.parent?.children.filter((c) => c.name === n.name) ?? [n];
  return { idx: Math.max(0, sibs.indexOf(n)), cnt: sibs.length };
}

function byLabel(root: XmlElement | null, label: string): XmlElement | null {
  const all = children(root, "dgm:styleLbl");
  return all.find((l) => attr(l, "name") === label) ?? null;
}

/** The colour a `dgm:*ClrLst` gives the node at `idx` of `cnt`. */
function listColor(list: XmlElement | null, idx: number, cnt: number, env: Env): XmlElement | null {
  const colors = list?.children.filter((c) => c.name.startsWith("a:")) ?? [];
  if (colors.length === 0) return null;
  if (colors.length === 1) return colors[0]!;
  const meth = attr(list, "meth") ?? "span";
  if (meth === "cycle") return colors[idx % colors.length]!;
  if (meth === "repeat") return colors[Math.min(idx, colors.length - 1)]!;
  const pos = (cnt > 1 ? idx / (cnt - 1) : 0) * (colors.length - 1);
  const i = Math.min(colors.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = resolveColor(colors[i]!, env.ctx.colors);
  const b = resolveColor(colors[i + 1]!, env.ctx.colors);
  if (!a || !b) return colors[Math.round(pos)]!;
  // Spanned round the colour wheel, clockwise unless `hueDir="ccw"`
  // (colorful4: yellow, green, teal, blue — not through brown).
  const [h1, s1, l1] = toHsl(a);
  const [h2, s2, l2] = toHsl(b);
  const turn = attr(list, "hueDir") === "ccw" ? -((h1 - h2 + 360) % 360) : (h2 - h1 + 360) % 360;
  const at = (x: number, y: number): number => x + (y - x) * f;
  const val = (v: number): string => String(Math.round(v * 100000));
  const alpha = at(a.a, b.a);
  const kids: XmlElement[] = alpha < 1 ? [{ name: "a:alpha", attrs: { val: val(alpha) }, children: [], text: "" }] : [];
  return { name: "a:hslClr", attrs: { hue: String(Math.round((((h1 + turn * f) % 360) + 360) % 360 * 60000)), sat: val(at(s1, s2)), lum: val(at(l1, l2)) }, children: kids, text: "" };
}

function nodeStyle(n: LayoutNode, env: Env): NodeStyle {
  const label = styleLabel(n, env);
  const { idx, cnt } = styleIndex(n, env);
  const qs = child(byLabel(env.parts.style, label) ?? byLabel(env.parts.style, "node1"), "dgm:style");
  const cs = byLabel(env.parts.colors, label);
  const pick = (name: string): XmlElement | null => listColor(child(cs, name), idx, cnt, env);
  const ref = (name: string, fallbackIdx: string, color: XmlElement | null): XmlElement => {
    const own = child(qs, name);
    const kids = color ? [color] : (own?.children ?? []);
    return { name, attrs: { idx: attr(own, "idx") ?? fallbackIdx }, children: kids, text: "" };
  };
  const ctx = env.ctx;
  let fill = themeStyle(ref("a:fillRef", qs ? "0" : "1", pick("dgm:fillClrLst") ?? accent1()), "fill", ctx).fill ?? null;
  let line = themeStyle(ref("a:lnRef", qs ? "0" : "2", pick("dgm:linClrLst")), "line", ctx).line ?? null;
  let effects = themeStyle(ref("a:effectRef", "0", pick("dgm:effectClrLst")), "effect", ctx).effects ?? NO_EFFECTS;
  // The user's own formatting: on the data point the shape shows (its first
  // text point: a step bound to the diagram shows a child's text), then on
  // the presentation point of this very shape.
  const shown = textPoints(n, env)[0] ?? n.point;
  for (const spPr of [shown.spPr, child(presPoint(n, env), "dgm:spPr")]) {
    if (!spPr) continue;
    const own = fillIn(spPr, ctx);
    if (own !== undefined) fill = own;
    line = readLine(child(spPr, "a:ln"), ctx, line);
    effects = readEffects(spPr, ctx, effects);
  }
  const fontRef = child(qs, "a:fontRef");
  const text = pick("dgm:txFillClrLst") ?? (fontRef?.children.find((c) => c.name.startsWith("a:")) ?? null);
  return { fill, line, effects, text, fontRef };
}

const accent1 = (): XmlElement => ({ name: "a:schemeClr", attrs: { val: "accent1" }, children: [], text: "" });

// --- drawing ---------------------------------------------------------------

function adjustments(n: LayoutNode, env: Env, preset: string): [string, string][] {
  if (n.adjust) return n.adjust;
  const def = env.presets.get(preset);
  const names = def?.avLst.map(([name]) => name) ?? [];
  return children(child(n.shape, "dgm:adjLst"), "dgm:adj").flatMap((a) => {
    const i = Number(attr(a, "idx") ?? 1);
    const name = names.includes(`adj${i}`) ? `adj${i}` : i === 1 && names.includes("adj") ? "adj" : null;
    const v = Number(attr(a, "val"));
    if (!name || !Number.isFinite(v)) return [];
    // Angles are degrees; everything else a fraction.
    const dflt = Number(def?.avLst.find(([nm]) => nm === name)?.[1].split(" ")[1] ?? 0);
    const angle = Math.abs(dflt) >= 1000000 || ANGLE_ADJUSTS[preset]?.includes(name) === true;
    return [[name, `val ${Math.round(angle ? v * 60000 : v * 100000)}`]];
  });
}

/** Angle adjusts whose preset default (0) doesn't give them away. */
const ANGLE_ADJUSTS: Record<string, string[]> = {
  pie: ["adj1", "adj2"], arc: ["adj1", "adj2"], blockArc: ["adj1", "adj2"], chord: ["adj1", "adj2"],
  circularArrow: ["adj3", "adj4"], leftCircularArrow: ["adj3", "adj4"], leftRightCircularArrow: ["adj3", "adj4"],
};

function geometryFor(n: LayoutNode, env: Env, box: Box): ReturnType<typeof evaluateGeometry> {
  const type = shapeType(n);
  const preset = isConn(n) ? connPreset(n) : type || "rect";
  const def = env.presets.get(preset);
  if (!def) {
    miss(env.ctx, `geometry:${preset}`);
    return evaluateGeometry(env.presets.get("rect")!, box.w, box.h);
  }
  return evaluateGeometry(def, box.w, box.h, adjustments(n, env, preset));
}

function connPreset(n: LayoutNode): string {
  const beg = n.params.get("begSty");
  const end = n.params.get("endSty") ?? "arr";
  if (beg === "arr" && end === "arr") return "leftRightArrow";
  if (beg === "arr") return "leftArrow";
  return "rightArrow";
}

function frameOf(box: Box, rot: number): Frame {
  return { x: box.x, y: box.y, w: Math.max(1, box.w), h: Math.max(1, box.h), rot: ((rot % 360) + 360) % 360, flipH: false, flipV: false };
}

function draw(n: LayoutNode, s: LayoutState, fitted: Map<string, number>, env: Env, out: SlideElement[]): void {
  if (isConn(n) && n.params.get("dim") === "1D") drawConnector(n, s, env, out);
  else if (n.box && Number.isFinite(n.box.w) && Number.isFinite(n.box.h)) {
    if (isConn(n)) drawConnector(n, s, env, out);
    else if (draws(n, env)) out.push(...drawShape(n, s, fitted, env));
  }
  const kids = n.topFirst ? [...n.children].reverse() : n.children;
  // `zOrderOff` moves a child that many places, ahead of whoever is there.
  const order = kids.map((c, i) => {
    const off = Number(attr(c.shape, "zOrderOff") ?? 0) || 0;
    return { c, key: i + off + Math.sign(off) * 0.5, i };
  });
  order.sort((a, b) => a.key - b.key || a.i - b.i);
  for (const { c } of order) {
    if (isConn(n) && n.box && !c.box) c.box = n.box;
    if (isConn(n)) c.rot = n.rot;
    draw(c, s, fitted, env, out);
  }
}

/** A node's shape and text. A shape the layout turns (`rot="90"` fills its
 *  box turned, so its sides swap) keeps its text level, in the box. */
function drawShape(n: LayoutNode, s: LayoutState, fitted: Map<string, number>, env: Env): ShapeElement[] {
  const box = n.box!;
  const turn = Number(attr(n.shape, "rot") ?? 0);
  const rot = n.rot + turn;
  const swap = Math.abs(turn % 180) === 90;
  const geoBox = swap ? { x: box.x + (box.w - box.h) / 2, y: box.y + (box.h - box.w) / 2, w: box.h, h: box.w } : box;
  const geom = geometryFor(n, env, geoBox);
  const style = nodeStyle(n, env);
  const visible = visibleShape(n);
  const paras = paragraphs(n, env);
  const size = fitted.get(n.name) ?? fontSizes(n, s).prim;
  const text = paras.length > 0 ? readTextBody(textBody(n, size, paras, style, s), [], null, style.fontRef, env.ctx) : null;
  const level = rot % 360 === 0 || (n.params.get("autoTxRot") ?? "upr") === "none";
  const shape: ShapeElement = {
    kind: "shape",
    frame: frameOf(geoBox, rot),
    paths: visible ? geom.paths : [],
    fill: visible ? style.fill : null,
    line: visible ? style.line : null,
    effects: visible ? style.effects : NO_EFFECTS,
    textRect: geom.textRect,
    text: level ? text : null,
  };
  if (level || !text) return [shape];
  const flat = geometryFor(n, env, box).textRect;
  return [shape, { kind: "shape", frame: frameOf(box, 0), paths: [], fill: null, line: null, effects: NO_EFFECTS, textRect: swap ? { l: 0, t: 0, r: box.w, b: box.h } : flat, text }];
}

function drawConnector(n: LayoutNode, s: LayoutState, env: Env, out: SlideElement[]): void {
  if (n.shape?.attrs["hideGeom"] === "1") return;
  const style = nodeStyle(n, env);
  if (n.params.get("dim") !== "1D") {
    const box = n.box!;
    const geom = geometryFor(n, env, box);
    out.push({ kind: "shape", frame: frameOf(box, n.rot), paths: geom.paths, fill: style.fill, line: style.line, effects: style.effects, textRect: geom.textRect, text: null });
    return;
  }
  const root = rootOf(n);
  const [a, b] = ends(n.point);
  const from = nodeFor(root, a, env, n.params.get("srcNode"))?.box;
  const to = nodeFor(root, b, env, n.params.get("dstNode"))?.box;
  if (!from || !to) return;
  const pts = route(n, from, to, s);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${Math.round(x - x0)} ${Math.round(y - y0)}`).join("");
  const end = n.params.get("endSty") ?? "arr";
  const line: Line | null = style.line
    ? { ...style.line, tail: end === "arr" ? { type: "triangle", w: "med", len: "med" } : null, head: n.params.get("begSty") === "arr" ? { type: "triangle", w: "med", len: "med" } : null }
    : null;
  out.push({
    kind: "shape",
    frame: frameOf({ x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }, 0),
    paths: [{ d, fill: "none", stroke: true }],
    fill: null,
    line,
    effects: NO_EFFECTS,
    textRect: { l: 0, t: 0, r: 0, b: 0 },
    text: null,
  });
}

function rootOf(n: LayoutNode): LayoutNode {
  let r = n;
  while (r.parent) r = r.parent;
  return r;
}

/** A one-dimensional connector's points: an elbow for `bend`, else straight. */
function route(n: LayoutNode, a: Box, b: Box, s: LayoutState): [number, number][] {
  const endPts = n.params.get("endPts") ?? "auto";
  const begPts = n.params.get("begPts") ?? "auto";
  if ((n.params.get("connRout") ?? "stra") === "bend" && /mid[LR]/.test(begPts)) {
    // Sideways: out of the source's side, across, into the target's side.
    const right = b.x + b.w / 2 >= a.x + a.w / 2;
    const sx = right ? a.x + a.w : a.x, sy = a.y + a.h / 2;
    const ex = right ? b.x : b.x + b.w, ey = b.y + b.h / 2;
    const mx = (sx + ex) / 2;
    return [[sx, sy], [mx, sy], [mx, ey], [ex, ey]];
  }
  if ((n.params.get("connRout") ?? "stra") === "bend") {
    const sx = a.x + a.w / 2, sy = a.y + a.h;
    if (endPts.includes("midL") || endPts.includes("midR")) {
      const right = b.x + b.w / 2 >= sx;
      const ex = right ? b.x : b.x + b.w;
      const ey = b.y + b.h / 2;
      const x = right ? Math.min(sx, (a.x + b.x) / 2) : Math.max(sx, (a.x + a.w + b.x + b.w) / 2);
      return [[x, sy], [x, ey], [ex, ey]];
    }
    const ex = b.x + b.w / 2, ey = b.y;
    const bend = props(n, s).get("bendDist");
    const my = bend !== undefined && Number.isFinite(bend) && bend > 0 ? ey - Math.min(bend, (ey - sy) * 0.9) : (sy + ey) / 2;
    return [[sx, sy], [sx, my], [ex, my], [ex, ey]];
  }
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  return [[ax, ay], [bx, by]];
}

/** The basic block list: what a diagram whose layout we can't read draws. */
function fallbackLayout(): XmlElement | null {
  return parseXml(`<dgm:layoutDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:layoutNode name="diagram">
<dgm:alg type="snake"><dgm:param type="off" val="ctr"/></dgm:alg><dgm:presOf/>
<dgm:constrLst><dgm:constr type="w" for="ch" forName="node" refType="w"/><dgm:constr type="h" for="ch" forName="node" refType="w" refFor="ch" refForName="node" fact="0.6"/>
<dgm:constr type="w" for="ch" forName="sibTrans" refType="w" refFor="ch" refForName="node" fact="0.1"/><dgm:constr type="sp" refType="w" refFor="ch" refForName="sibTrans"/>
<dgm:constr type="primFontSz" for="ch" forName="node" op="equ" val="65"/></dgm:constrLst>
<dgm:forEach axis="ch" ptType="node"><dgm:layoutNode name="node" styleLbl="node1"><dgm:varLst><dgm:bulletEnabled val="1"/></dgm:varLst><dgm:alg type="tx"/>
<dgm:shape type="roundRect"><dgm:adjLst><dgm:adj idx="1" val="0.1"/></dgm:adjLst></dgm:shape><dgm:presOf axis="desOrSelf" ptType="node"/>
<dgm:constrLst><dgm:constr type="lMarg" refType="primFontSz" fact="0.3"/><dgm:constr type="rMarg" refType="primFontSz" fact="0.3"/>
<dgm:constr type="tMarg" refType="primFontSz" fact="0.3"/><dgm:constr type="bMarg" refType="primFontSz" fact="0.3"/></dgm:constrLst></dgm:layoutNode>
<dgm:forEach axis="followSib" ptType="sibTrans" cnt="1"><dgm:layoutNode name="sibTrans"><dgm:alg type="sp"/></dgm:layoutNode></dgm:forEach>
</dgm:forEach></dgm:layoutNode></dgm:layoutDef>`);
}
