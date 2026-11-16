import type { GeometryPath, Insets } from "@shared/types/slide-model";
import { attr, child, children, numAttr, parseXml, type XmlElement } from "./xml";

/**
 * DrawingML geometry: a shape is a list of guides (formulas over the shape's
 * size and its adjust values), a text rectangle and paths drawn with them.
 * The 187 preset shapes are that same language, written out in ECMA-376's
 * `presetShapeDefinitions.xml` (`resources/ooxml/`), so one evaluator draws
 * both a `prstGeom` and a `custGeom`.
 */

/** A geometry as its XML gives it, before any size is known. */
export type GeometryDef = {
  avLst: [string, string][];
  gdLst: [string, string][];
  rect: { l: string; t: string; r: string; b: string } | null;
  paths: XmlElement[];
};

export type PresetTable = ReadonlyMap<string, GeometryDef>;

export function parsePresetDefinitions(xmlText: string): PresetTable {
  const root = parseXml(xmlText);
  const table = new Map<string, GeometryDef>();
  // The file's elements carry DrawingML's namespace, so their names arrive
  // canonical (`a:gdLst`); the shape names themselves are unqualified.
  for (const shape of root?.children ?? []) table.set(shape.name, geometryDef(shape));
  return table;
}

/** `a:prstGeom`/`a:custGeom`'s contents (or a preset's), as a definition. */
export function geometryDef(el: XmlElement): GeometryDef {
  const guides = (list: XmlElement | null): [string, string][] =>
    children(list, "a:gd").map((gd) => [attr(gd, "name") ?? "", attr(gd, "fmla") ?? "val 0"]);
  const rect = child(el, "a:rect");
  return {
    avLst: guides(child(el, "a:avLst")),
    gdLst: guides(child(el, "a:gdLst")),
    rect: rect
      ? { l: attr(rect, "l") ?? "l", t: attr(rect, "t") ?? "t", r: attr(rect, "r") ?? "r", b: attr(rect, "b") ?? "b" }
      : null,
    paths: children(child(el, "a:pathLst"), "a:path"),
  };
}

export type Geometry = { paths: GeometryPath[]; textRect: Insets };

/**
 * The geometry at a size (EMU), with the shape's own adjust values overriding
 * the definition's defaults. Paths come out in the shape's box, 0..w × 0..h.
 */
export function evaluateGeometry(def: GeometryDef, w: number, h: number, adjust: [string, string][] = []): Geometry {
  const vars = builtins(w, h);
  const overrides = new Map(adjust);
  for (const [name, fmla] of def.avLst) vars.set(name, evaluate(overrides.get(name) ?? fmla, vars));
  // A shape may also adjust a guide its definition doesn't list as such (seen in
  // files written by other tools): honour it before the guides that use it.
  for (const [name, fmla] of adjust) if (!vars.has(name)) vars.set(name, evaluate(fmla, vars));
  for (const [name, fmla] of def.gdLst) vars.set(name, evaluate(fmla, vars));

  const value = (token: string): number => resolve(token, vars);
  const textRect = def.rect
    ? { l: value(def.rect.l), t: value(def.rect.t), r: value(def.rect.r), b: value(def.rect.b) }
    : { l: 0, t: 0, r: w, b: h };
  return { paths: def.paths.map((p) => drawPath(p, w, h, vars)), textRect };
}

function builtins(w: number, h: number): Map<string, number> {
  const ss = Math.min(w, h);
  const ls = Math.max(w, h);
  const vars = new Map<string, number>([
    ["w", w], ["h", h], ["l", 0], ["t", 0], ["r", w], ["b", h], ["hc", w / 2], ["vc", h / 2],
    ["ss", ss], ["ls", ls],
    ["cd2", 10800000], ["cd4", 5400000], ["cd8", 2700000],
    ["3cd4", 16200000], ["3cd8", 8100000], ["5cd8", 13500000], ["7cd8", 18900000],
  ]);
  for (const n of [2, 3, 4, 5, 6, 8, 10, 12, 32]) {
    vars.set(`wd${n}`, w / n);
    vars.set(`hd${n}`, h / n);
  }
  for (const n of [2, 4, 6, 8, 16, 32]) vars.set(`ssd${n}`, ss / n);
  return vars;
}

function resolve(token: string, vars: Map<string, number>): number {
  const known = vars.get(token);
  if (known !== undefined) return known;
  const n = Number(token);
  return Number.isFinite(n) ? n : 0;
}

const DEG = Math.PI / 180 / 60000;

/** ECMA-376 §20.1.9.11 guide formulas. Angles are 60 000ths of a degree. */
function evaluate(fmla: string, vars: Map<string, number>): number {
  const [op = "val", ...args] = fmla.trim().split(/\s+/);
  const [x = 0, y = 0, z = 0] = args.map((a) => resolve(a, vars));
  switch (op) {
    case "val":
      return x;
    case "*/":
      return z === 0 ? 0 : (x * y) / z;
    case "+-":
      return x + y - z;
    case "+/":
      return z === 0 ? 0 : (x + y) / z;
    case "?:":
      return x > 0 ? y : z;
    case "abs":
      return Math.abs(x);
    case "at2":
      return Math.atan2(y, x) / DEG;
    case "cat2":
      return x * Math.cos(Math.atan2(z, y));
    case "sat2":
      return x * Math.sin(Math.atan2(z, y));
    case "cos":
      return x * Math.cos(y * DEG);
    case "sin":
      return x * Math.sin(y * DEG);
    case "tan":
      return x * Math.tan(y * DEG);
    case "max":
      return Math.max(x, y);
    case "min":
      return Math.min(x, y);
    case "mod":
      return Math.sqrt(x * x + y * y + z * z);
    case "pin":
      return y < x ? x : y > z ? z : y;
    case "sqrt":
      return Math.sqrt(Math.max(0, x));
    default:
      return 0;
  }
}

function drawPath(p: XmlElement, w: number, h: number, vars: Map<string, number>): GeometryPath {
  // A path may define its own coordinate space; it is stretched onto the box.
  const pw = numAttr(p, "w", 0);
  const ph = numAttr(p, "h", 0);
  const sx = pw > 0 ? w / pw : 1;
  const sy = ph > 0 ? h / ph : 1;
  const value = (token: string | null): number => resolve(token ?? "0", vars);
  const point = (pt: XmlElement | null): [number, number] => [value(attr(pt, "x")) * sx, value(attr(pt, "y")) * sy];

  const out: string[] = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  for (const cmd of p.children) {
    switch (cmd.name) {
      case "a:moveTo": {
        [cx, cy] = point(child(cmd, "a:pt"));
        [startX, startY] = [cx, cy];
        out.push(`M${n(cx)} ${n(cy)}`);
        break;
      }
      case "a:lnTo": {
        [cx, cy] = point(child(cmd, "a:pt"));
        out.push(`L${n(cx)} ${n(cy)}`);
        break;
      }
      case "a:quadBezTo": {
        const pts = children(cmd, "a:pt").map(point);
        if (pts.length < 2) break;
        out.push(`Q${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(" ")}`);
        [cx, cy] = pts[pts.length - 1]!;
        break;
      }
      case "a:cubicBezTo": {
        const pts = children(cmd, "a:pt").map(point);
        if (pts.length < 3) break;
        out.push(`C${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(" ")}`);
        [cx, cy] = pts[pts.length - 1]!;
        break;
      }
      case "a:arcTo": {
        const rx = value(attr(cmd, "wR")) * sx;
        const ry = value(attr(cmd, "hR")) * sy;
        const st = value(attr(cmd, "stAng")) * DEG;
        const sw = value(attr(cmd, "swAng")) * DEG;
        const arc = arcTo(cx, cy, rx, ry, st, sw);
        out.push(arc.d);
        [cx, cy] = [arc.x, arc.y];
        break;
      }
      case "a:close":
        out.push("Z");
        [cx, cy] = [startX, startY];
        break;
      default:
        break;
    }
  }
  const fill = attr(p, "fill");
  return {
    d: out.join(""),
    fill: fill === "none" || fill === "lighten" || fill === "lightenLess" || fill === "darken" || fill === "darkenLess" ? fill : "norm",
    stroke: attr(p, "stroke") !== "0" && attr(p, "stroke") !== "false",
  };
}

/**
 * An arc continuing from the current point. `st` and `sw` are VISUAL angles —
 * the angle of the ray from the ellipse's centre, as PowerPoint measures them —
 * so on a non-circular ellipse they are turned into the parametric angle that
 * puts the point on that ray (`t = atan2(rx·sin a, ry·cos a)`).
 */
function arcTo(x: number, y: number, rx: number, ry: number, st: number, sw: number): { d: string; x: number; y: number } {
  if (rx <= 0 || ry <= 0 || sw === 0 || !Number.isFinite(sw)) return { d: "", x, y };
  // Past a full turn an arc only draws the same ellipse again, half a turn per step: a `swAng` of 1e15 (from the
  // file or a guide) ran the worker out of memory (2026-11-15 audit, S5). One turn plus the remainder draws the
  // same and ends at the same point.
  const TURN = 2 * Math.PI;
  if (Math.abs(sw) > TURN) sw = (sw % TURN) + Math.sign(sw) * TURN;
  const t0 = parametric(st, rx, ry);
  const t1 = parametric(st + sw, rx, ry);
  const centerX = x - rx * Math.cos(t0);
  const centerY = y - ry * Math.sin(t0);
  const at = (t: number): [number, number] => [centerX + rx * Math.cos(t), centerY + ry * Math.sin(t)];
  // SVG's arc can't draw a full turn; split anything past half a turn.
  const steps = Math.max(1, Math.ceil(Math.abs(t1 - t0) / Math.PI));
  let d = "";
  for (let i = 1; i <= steps; i++) {
    const [ex, ey] = at(t0 + ((t1 - t0) * i) / steps);
    d += `A${n(rx)} ${n(ry)} 0 0 ${sw > 0 ? 1 : 0} ${n(ex)} ${n(ey)}`;
  }
  const [endX, endY] = at(t1);
  return { d, x: endX, y: endY };
}

/** The parametric angle of the point at visual angle `a`, continuous in `a`. */
function parametric(a: number, rx: number, ry: number): number {
  const t = Math.atan2(rx * Math.sin(a), ry * Math.cos(a));
  return t + 2 * Math.PI * Math.round((a - t) / (2 * Math.PI));
}

const n = (v: number): string => String(Math.round(v * 100) / 100);
