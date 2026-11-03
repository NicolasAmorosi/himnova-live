import type { GeometryPath, Insets } from "@shared/types/slide-model";
import { evaluateGeometry, type PresetTable } from "../pptx/geometry";
import { attr, children, type XmlElement } from "../pptx/xml";

/**
 * ODF geometry. A `draw:custom-shape` is drawn by `draw:enhanced-geometry`:
 * a path language of its own (`draw:enhanced-path`, one letter per command)
 * over a coordinate space (`svg:viewBox`), with parameters that are numbers,
 * modifiers (`$0`, the shape's handles), equations (`?f3`, a small formula
 * language, `draw:equation`) or keywords. What follows mirrors LibreOffice's
 * own evaluator (`svx/source/customshapes/EnhancedCustomShape2d.cxx`); every
 * path comes out as SVG in the shape's box, 0..w × 0..h, EMU.
 */

/** 1/100 mm, LibreOffice's logical unit, in EMU. */
export const EMU_PER_MM100 = 360;

// -- formulas ---------------------------------------------------------------------------------

type Node =
  | { k: "num"; v: number }
  | { k: "id"; v: string }
  | { k: "eq"; v: string }
  | { k: "mod"; v: number }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "fn"; f: string; args: Node[] };

const FUNCTIONS: Record<string, number> = { abs: 1, sqrt: 1, sin: 1, cos: 1, tan: 1, atan: 1, min: 2, max: 2, atan2: 2, if: 3 };

/** Parses a `draw:formula`; `null` for one that doesn't parse (it evaluates
 *  to 0, as an equation LibreOffice can't read does). */
export function parseFormula(source: string): Node | null {
  const tokens = source.match(/\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+|\?[A-Za-z0-9]+|\$\d+|[A-Za-z][A-Za-z0-9]*|[-+*/(),]/g) ?? [];
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const additive = (): Node => {
    let left = multiplicative();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[at++]!;
      left = { k: "bin", op, a: left, b: multiplicative() };
    }
    return left;
  };
  const multiplicative = (): Node => {
    let left = unary();
    while (peek() === "*" || peek() === "/") {
      const op = tokens[at++]!;
      left = { k: "bin", op, a: left, b: unary() };
    }
    return left;
  };
  const unary = (): Node => {
    if (peek() === "-") {
      at++;
      return { k: "neg", a: basic() };
    }
    if (peek() === "+") at++;
    return basic();
  };
  const basic = (): Node => {
    const t = tokens[at++];
    if (t === undefined) throw new Error("end of formula");
    if (t === "(") {
      const inner = additive();
      if (tokens[at++] !== ")") throw new Error("expected )");
      return inner;
    }
    if (t[0] === "?") return { k: "eq", v: t.slice(1) };
    if (t[0] === "$") return { k: "mod", v: Number(t.slice(1)) };
    if (/^[\d.]/.test(t)) return { k: "num", v: Number(t) };
    if (/^[A-Za-z]/.test(t)) {
      const arity = FUNCTIONS[t];
      if (arity !== undefined && peek() === "(") {
        at++;
        const args: Node[] = [additive()];
        while (peek() === ",") {
          at++;
          args.push(additive());
        }
        if (tokens[at++] !== ")" || args.length !== arity) throw new Error(`bad call to ${t}`);
        return { k: "fn", f: t, args };
      }
      return { k: "id", v: t };
    }
    throw new Error(`unexpected ${t}`);
  };
  try {
    const node = additive();
    return at === tokens.length ? node : null;
  } catch {
    return null;
  }
}

/** What a geometry's parameters are evaluated against: the coordinate space
 *  of the subpath being drawn and the shape's own state. */
type Space = {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Stretch-point ratios (`draw:path-stretchpoint-x/y`): 1 when unused. */
  xRatio: number;
  yRatio: number;
  xStretch: number;
  yStretch: number;
  logWidth: number;
  logHeight: number;
  modifiers: number[];
  hasFill: boolean;
  hasStroke: boolean;
};

class Evaluator {
  private readonly values = new Map<string, number>();
  private depth = 0;
  constructor(private readonly equations: Map<string, Node | null>, private readonly space: Space) {}

  equation(name: string): number {
    const known = this.values.get(name);
    if (known !== undefined) return known;
    const node = this.equations.get(name);
    // A cycle (an equation that needs itself) reads as 0, never forever.
    if (!node || this.depth > 64) return 0;
    this.depth++;
    this.values.set(name, 0);
    const v = this.eval(node);
    this.depth--;
    const value = Number.isFinite(v) ? v : 0;
    this.values.set(name, value);
    return value;
  }

  identifier(name: string): number {
    const s = this.space;
    switch (name) {
      case "pi": return Math.PI;
      case "left": return s.left;
      case "top": return s.top;
      case "right": return (s.left + s.width) * s.xRatio;
      case "bottom": return (s.top + s.height) * s.yRatio;
      case "xstretch": return s.xStretch;
      case "ystretch": return s.yStretch;
      case "hasstroke": return s.hasStroke ? 1 : 0;
      case "hasfill": return s.hasFill ? 1 : 0;
      case "width": return s.width;
      case "height": return s.height;
      case "logwidth": return s.logWidth;
      case "logheight": return s.logHeight;
      default: return 0;
    }
  }

  eval(n: Node): number {
    switch (n.k) {
      case "num": return n.v;
      case "id": return this.identifier(n.v);
      case "eq": return this.equation(n.v);
      case "mod": return this.space.modifiers[n.v] ?? 0;
      case "neg": return -this.eval(n.a);
      case "bin": {
        const a = this.eval(n.a);
        const b = this.eval(n.b);
        return n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : b === 0 ? 0 : a / b;
      }
      case "fn": {
        const [x = 0, y = 0, z = 0] = n.args.map((a) => this.eval(a));
        switch (n.f) {
          case "abs": return Math.abs(x);
          case "sqrt": return Math.sqrt(Math.max(0, x));
          case "sin": return Math.sin(x);
          case "cos": return Math.cos(x);
          case "tan": return Math.tan(x);
          case "atan": return Math.atan(x);
          case "min": return Math.min(x, y);
          case "max": return Math.max(x, y);
          case "atan2": return Math.atan2(x, y);
          case "if": return x > 0 ? y : z;
          default: return 0;
        }
      }
    }
  }

  /** A path parameter: a literal, `?f`, `$n` or a keyword. A literal equal to
   *  the view's width (height) is stretched with it, as LibreOffice does for
   *  shapes with a stretch point. */
  param(token: string, axis: "x" | "y" | null): number {
    if (token[0] === "?") return this.equation(token.slice(1));
    if (token[0] === "$") return this.space.modifiers[Number(token.slice(1))] ?? 0;
    const n = Number(token);
    if (Number.isFinite(n)) {
      if (axis === "x" && n === this.space.width && Number.isInteger(n)) return n * this.space.xRatio;
      if (axis === "y" && n === this.space.height && Number.isInteger(n)) return n * this.space.yRatio;
      return n;
    }
    return this.identifier(token);
  }
}

// -- enhanced geometry ------------------------------------------------------------------------

export type ShapeGeometry = { paths: GeometryPath[]; textRect: Insets; flipH: boolean; flipV: boolean; rotation: number };

const COMMANDS = new Set(["M", "L", "C", "Z", "N", "F", "S", "T", "U", "A", "B", "W", "V", "X", "Y", "Q", "G", "H", "I", "J", "K"]);

/** LibreOffice's own shape types (`draw:type`) that have an OOXML preset of the
 *  same outline — what a geometry that comes without its path is drawn as. */
const TYPE_PRESETS: Record<string, string> = {
  rectangle: "rect", "round-rectangle": "roundRect", ellipse: "ellipse", circle: "ellipse", diamond: "diamond",
  "isosceles-triangle": "triangle", "right-triangle": "rtTriangle", parallelogram: "parallelogram", trapezoid: "trapezoid",
  hexagon: "hexagon", octagon: "octagon", pentagon: "pentagon", cross: "plus", star5: "star5", star4: "star4", star8: "star8",
  "right-arrow": "rightArrow", "left-arrow": "leftArrow", "up-arrow": "upArrow", "down-arrow": "downArrow",
  "left-right-arrow": "leftRightArrow", "up-down-arrow": "upDownArrow", heart: "heart", smiley: "smileyFace", moon: "moon",
  sun: "sun", can: "can", cube: "cube", ring: "donut", "block-arc": "blockArc", frame: "frame", "flowchart-process": "flowChartProcess",
  "flowchart-decision": "flowChartDecision", "flowchart-terminator": "flowChartTerminator", "flowchart-connector": "flowChartConnector",
  "round-rectangular-callout": "wedgeRoundRectCallout", "rectangular-callout": "wedgeRectCallout", "round-callout": "wedgeEllipseCallout",
  "cloud-callout": "cloudCallout", chevron: "chevron", "pentagon-right": "homePlate", "horizontal-scroll": "horizontalScroll",
  "vertical-scroll": "verticalScroll", "lightning": "lightningBolt", "flower": "flowChartConnector",
};

/** Preset shapes LibreOffice draws a `U` of as a full ellipse, whatever its angles. */
const FULL_ELLIPSE_TYPES = new Set(["ellipse", "ring", "smiley", "sun", "forbidden", "flowchart-connector", "flowchart-summing-junction", "flowchart-or", "cloud-callout"]);

/**
 * A `draw:enhanced-geometry` at a size (EMU). `null` when it says nothing that
 * can be drawn: no path and no type with a preset to stand in for it.
 */
export function enhancedGeometry(
  geo: XmlElement,
  w: number,
  h: number,
  look: { hasFill: boolean; hasStroke: boolean },
  presets: PresetTable,
  miss: (what: string) => void,
): ShapeGeometry | null {
  const type = attr(geo, "draw:type") ?? "non-primitive";
  const flipH = attr(geo, "draw:mirror-horizontal") === "true";
  const flipV = attr(geo, "draw:mirror-vertical") === "true";
  const rotation = -(Number(attr(geo, "draw:text-rotate-angle") ?? 0) || 0);
  // LibreOffice writes its full path (with `G` arcs, an extension) in its own
  // namespace, and a plain-ODF approximation of it in `draw:`; it reads the former.
  const source = attr(geo, "drawooo:enhanced-path") ?? attr(geo, "draw:enhanced-path");
  const modifiers = (attr(geo, "draw:modifiers") ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number).map((v) => (Number.isFinite(v) ? v : 0));
  if (!source) {
    const name = type.startsWith("ooxml-") ? type.slice(6) : TYPE_PRESETS[type];
    const def = name ? presets.get(name) : undefined;
    if (!def) return null;
    // An `ooxml-` shape keeps PowerPoint's own adjust values as its modifiers.
    const adjust: [string, string][] = type.startsWith("ooxml-") ? def.avLst.map(([n], i) => [n, `val ${modifiers[i] ?? 0}`] as [string, string]).filter((_, i) => modifiers[i] !== undefined) : [];
    if (!type.startsWith("ooxml-")) miss("shape:preset-approx");
    const g = evaluateGeometry(def, w, h, adjust);
    return { paths: g.paths, textRect: g.textRect, flipH, flipV, rotation };
  }
  const ooxml = type.startsWith("ooxml-");
  const vb = (attr(geo, "svg:viewBox") ?? "0 0 21600 21600").trim().split(/[\s,]+/).map(Number);
  const [vl = 0, vt = 0, vw = 21600, vh = 21600] = vb.map((v) => (Number.isFinite(v) ? v : 0));
  const subSizes = (Object.entries(geo.attrs).find(([k]) => k.endsWith(":sub-view-size"))?.[1] ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const xStretchAttr = attr(geo, "draw:path-stretchpoint-x");
  const yStretchAttr = attr(geo, "draw:path-stretchpoint-y");
  const equations = new Map<string, Node | null>();
  for (const eq of children(geo, "draw:equation")) {
    const name = attr(eq, "draw:name");
    if (name) equations.set(name, parseFormula(attr(eq, "draw:formula") ?? "0"));
  }
  const logWidth = w / EMU_PER_MM100;
  const logHeight = h / EMU_PER_MM100;

  /** The coordinate space of subpath `index`, and how it maps onto the box. */
  const spaceOf = (index: number): { ev: Evaluator; sx: number; sy: number } => {
    const sw = subSizes[index * 2] ?? 0;
    const sh = subSizes[index * 2 + 1] ?? 0;
    const width = sw && sh ? sw : vw;
    const height = sw && sh ? sh : vh;
    // EMU per coordinate unit. A zero view is the shape's own logical space
    // for a shape that came from PowerPoint (LibreOffice scales it 1:1).
    let sx = width === 0 ? (ooxml ? EMU_PER_MM100 : 0) : w / width;
    let sy = height === 0 ? (ooxml ? EMU_PER_MM100 : 0) : h / height;
    let xRatio = 1;
    let yRatio = 1;
    if (xStretchAttr !== null && h > 0 && w / h > 1) {
      xRatio = w / h;
      sx /= xRatio;
    }
    if (yStretchAttr !== null && w > 0 && h / w > 1) {
      yRatio = h / w;
      sy /= yRatio;
    }
    const space: Space = {
      left: vl, top: vt, width, height, xRatio, yRatio,
      xStretch: Number(xStretchAttr ?? 0) || 0, yStretch: Number(yStretchAttr ?? 0) || 0,
      logWidth, logHeight, modifiers, hasFill: look.hasFill, hasStroke: look.hasStroke,
    };
    return { ev: new Evaluator(equations, space), sx, sy };
  };

  // Commands are single capitals; parameters are numbers, `?f` and `$n`
  // (LibreOffice skips any other letter, and so does this).
  const tokens = source.match(/[A-Z]|\?[A-Za-z0-9]+|\$\d+|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const paths: GeometryPath[] = [];
  let index = 0;
  let cur = spaceOf(0);
  const px = (t: string): number => (cur.ev.param(t, "x") - vl) * cur.sx;
  const py = (t: string): number => (cur.ev.param(t, "y") - vt) * cur.sy;
  let d: string[] = [];
  let noFill = false;
  let noStroke = false;
  let shade: GeometryPath["fill"] = "norm";
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let open = false;
  const moveTo = (nx: number, ny: number): void => {
    d.push(`M${n(nx)} ${n(ny)}`);
    [x, y, startX, startY, open] = [nx, ny, nx, ny, true];
  };
  const lineTo = (nx: number, ny: number): void => {
    if (!open) return moveTo(nx, ny);
    d.push(`L${n(nx)} ${n(ny)}`);
    [x, y] = [nx, ny];
  };
  const flush = (): void => {
    if (d.length > 0) paths.push({ d: d.join(""), fill: noFill ? "none" : shade, stroke: !noStroke });
    d = [];
    noFill = false;
    noStroke = false;
    shade = "norm";
    open = false;
    index++;
    cur = spaceOf(index);
  };
  /** An arc of the axis-aligned ellipse centred at (cx, cy), from parametric
   *  angle `t0` through `sweep` radians (positive: clockwise on screen). */
  const arc = (cx: number, cy: number, rx: number, ry: number, t0: number, sweep: number, join: "move" | "line"): void => {
    const sx0 = cx + rx * Math.cos(t0);
    const sy0 = cy + ry * Math.sin(t0);
    if (join === "move" || !open) moveTo(sx0, sy0);
    else lineTo(sx0, sy0);
    if (rx <= 0 || ry <= 0 || sweep === 0) return;
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / Math.PI - 1e-9));
    for (let k = 1; k <= steps; k++) {
      const t = t0 + (sweep * k) / steps;
      const ex = cx + rx * Math.cos(t);
      const ey = cy + ry * Math.sin(t);
      d.push(`A${n(rx)} ${n(ry)} 0 0 ${sweep > 0 ? 1 : 0} ${n(ex)} ${n(ey)}`);
      [x, y] = [ex, ey];
    }
  };

  let command = "";
  let i = 0;
  const has = (count: number): boolean => i + count <= tokens.length && tokens.slice(i, i + count).every((t) => !COMMANDS.has(t));
  const take = (): string => tokens[i++]!;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (COMMANDS.has(t)) {
      command = t;
      i++;
      switch (t) {
        case "Z":
          if (open) d.push("Z");
          [x, y] = [startX, startY];
          open = false;
          continue;
        case "N":
          flush();
          continue;
        case "F":
          noFill = true;
          continue;
        case "S":
          noStroke = true;
          continue;
        case "H":
          shade = "darken";
          continue;
        case "I":
          shade = "darkenLess";
          continue;
        case "J":
          shade = "lighten";
          continue;
        case "K":
          shade = "lightenLess";
          continue;
        default:
          break;
      }
      continue;
    }
    // Parameters for the current command; a command repeats while its
    // parameters do.
    switch (command) {
      case "M": {
        if (!has(2)) { i++; break; }
        const nx = px(take());
        const ny = py(take());
        moveTo(nx, ny);
        command = "L";
        break;
      }
      case "L": {
        if (!has(2)) { i++; break; }
        lineTo(px(take()), py(take()));
        break;
      }
      case "C": {
        if (!has(6)) { i = tokens.length; break; }
        const pts = [0, 1, 2].map(() => [px(take()), py(take())] as const);
        if (!open) moveTo(x, y);
        d.push(`C${pts.map(([a, b]) => `${n(a)} ${n(b)}`).join(" ")}`);
        [x, y] = pts[2]!;
        break;
      }
      case "Q": {
        if (!has(4)) { i = tokens.length; break; }
        const c = [px(take()), py(take())] as const;
        const e = [px(take()), py(take())] as const;
        if (!open) moveTo(x, y);
        d.push(`Q${n(c[0])} ${n(c[1])} ${n(e[0])} ${n(e[1])}`);
        [x, y] = e;
        break;
      }
      case "T":
      case "U": {
        if (!has(6)) { i = tokens.length; break; }
        const cx = px(take());
        const cy = py(take());
        const wrRaw = cur.ev.param(take(), "x");
        const hrRaw = cur.ev.param(take(), "y");
        const a0 = cur.ev.param(take(), null);
        const a1 = cur.ev.param(take(), null);
        const rx = Math.abs(wrRaw * cur.sx);
        const ry = Math.abs(hrRaw * cur.sy);
        const join = command === "U" ? "move" : "line";
        if (command === "U" && FULL_ELLIPSE_TYPES.has(type)) {
          arc(cx, cy, rx, ry, 0, 2 * Math.PI, join);
        } else if (type.startsWith("mso")) {
          // From a binary PowerPoint shape: degrees·2¹⁶, a start and a swing,
          // counter-clockwise, measured on the circle.
          const start = type === "mso-spt143" ? -a0 : -a0 / 65536;
          const swing = type === "mso-spt143" ? -a1 : -a1 / 65536;
          arc(cx, cy, rx, ry, (start * Math.PI) / 180, (swing * Math.PI) / 180, join);
        } else if (Math.abs(Math.abs(a1 - a0) - 360) < 1e-9) {
          const t0 = circleAngle(wrRaw, hrRaw, a0);
          arc(cx, cy, rx, ry, t0, 2 * Math.PI, join);
        } else {
          const t0 = circleAngle(wrRaw, hrRaw, a0);
          let sweep = circleAngle(wrRaw, hrRaw, a1) - t0;
          if (sweep < 0) sweep += 2 * Math.PI;
          arc(cx, cy, rx, ry, t0, sweep, join);
        }
        break;
      }
      case "A":
      case "B":
      case "W":
      case "V": {
        if (!has(8)) { i = tokens.length; break; }
        const p = [0, 1, 2, 3].map(() => [px(take()), py(take())] as const);
        const [[x1, y1], [x2, y2]] = p as [[number, number], [number, number]];
        // A rectangle given right to left (or bottom up, not both) swaps the
        // arc's ends, as LibreOffice's `CreateArc` does.
        const swap = x1 > x2 !== y1 > y2;
        const [x3, y3] = p[swap ? 3 : 2]!;
        const [x4, y4] = p[swap ? 2 : 3]!;
        const clockwise = command === "W" || command === "V";
        const join = command === "B" || command === "V" ? "move" : "line";
        const l = Math.min(x1, x2);
        const r = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const b = Math.max(y1, y2);
        const rx = (r - l) / 2;
        const ry = (b - top) / 2;
        if (rx <= 0 || ry <= 0) break;
        const cx = l + rx;
        const cy = top + ry;
        // Where the rays from the centre through the two points meet the ellipse.
        const ts = Math.atan2((y3 - cy) * rx, (x3 - cx) * ry);
        const te = Math.atan2((y4 - cy) * rx, (x4 - cx) * ry);
        let sweep = clockwise ? te - ts : ts - te;
        if (sweep <= 0) sweep += 2 * Math.PI;
        arc(cx, cy, rx, ry, ts, clockwise ? sweep : -sweep, join);
        break;
      }
      case "X":
      case "Y": {
        if (!has(2)) { i++; break; }
        const ex = px(take());
        const ey = py(take());
        if (!open) {
          moveTo(ex, ey);
          break;
        }
        const rx = Math.abs(ex - x);
        const ry = Math.abs(ey - y);
        const xFirst = command === "X";
        // Clockwise on screen when the turn from the start radius to the end
        // radius is.
        const cw = xFirst ? (ey - y) * (ex - x) > 0 : (x - ex) * (ey - y) > 0;
        d.push(rx > 0 && ry > 0 ? `A${n(rx)} ${n(ry)} 0 0 ${cw ? 1 : 0} ${n(ex)} ${n(ey)}` : `L${n(ex)} ${n(ey)}`);
        [x, y] = [ex, ey];
        // Several points alternate the direction.
        command = xFirst ? "Y" : "X";
        break;
      }
      case "G": {
        if (!has(4)) { i = tokens.length; break; }
        // Read as a point that isn't scaled — the view's origin still comes off.
        const wr = cur.ev.param(take(), null) - vl;
        const hr = cur.ev.param(take(), null) - vt;
        const st = cur.ev.param(take(), null) - vl;
        let sw = cur.ev.param(take(), null) - vt;
        if (ooxml) sw = Math.max(-360, Math.min(360, sw));
        if (!open) break;
        const rx = Math.abs(wr * cur.sx);
        const ry = Math.abs(hr * cur.sy);
        const t0 = circleAngle(wr, hr, st);
        let sweep: number;
        if (Math.abs(sw) >= 360) sweep = Math.sign(sw) * 2 * Math.PI;
        else {
          const t1 = circleAngle(wr, hr, st + sw);
          sweep = t1 - t0;
          if (sw > 0 && sweep < 0) sweep += 2 * Math.PI;
          if (sw < 0 && sweep > 0) sweep -= 2 * Math.PI;
        }
        // The arc continues from the current point.
        arc(x - rx * Math.cos(t0), y - ry * Math.sin(t0), rx, ry, t0, sweep, "line");
        break;
      }
      default:
        i++;
        break;
    }
  }
  if (d.length > 0) paths.push({ d: d.join(""), fill: noFill ? "none" : shade, stroke: !noStroke });

  const first = spaceOf(0);
  const areas = (attr(geo, "draw:text-areas") ?? "").trim().split(/\s+/).filter(Boolean);
  const textRect: Insets = areas.length >= 4
    ? {
        l: (first.ev.param(areas[0]!, "x") - vl) * first.sx,
        t: (first.ev.param(areas[1]!, "y") - vt) * first.sy,
        r: (first.ev.param(areas[2]!, "x") - vl) * first.sx,
        b: (first.ev.param(areas[3]!, "y") - vt) * first.sy,
      }
    : { l: 0, t: 0, r: w, b: h };
  if (textRect.l > textRect.r) [textRect.l, textRect.r] = [textRect.r, textRect.l];
  if (textRect.t > textRect.b) [textRect.t, textRect.b] = [textRect.b, textRect.t];
  return { paths, textRect, flipH, flipV, rotation };
}

/** The parametric angle (radians, 0..2π) of the point at `deg` degrees on an
 *  ellipse of radii `wr`, `hr` — LibreOffice's `lcl_getNormalizedCircleAngleRad`. */
function circleAngle(wr: number, hr: number, deg: number): number {
  let a = deg % 360;
  if (a < 0) a += 360;
  if (a === 0 || a === 90 || a === 180 || a === 270) return (a * Math.PI) / 180;
  const r = (a * Math.PI) / 180;
  const t = Math.atan2(wr * Math.sin(r), hr * Math.cos(r));
  return t < 0 ? t + 2 * Math.PI : t;
}

// -- SVG paths --------------------------------------------------------------------------------

/**
 * An SVG path (`svg:d`, `svg:points`) from a view box onto the shape's box:
 * every coordinate made absolute, moved by `(-ox, -oy)` and scaled by
 * `(sx, sy)`. Arcs keep their rotation; under a non-uniform scale that is an
 * approximation.
 */
export function mapSvgPath(d: string, ox: number, oy: number, sx: number, sy: number): string {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let sx0 = 0;
  let sy0 = 0;
  const X = (v: number): string => n((v - ox) * sx);
  const Y = (v: number): string => n((v - oy) * sy);
  const num = (): number => Number(tokens[i++]);
  const isNum = (k = 0): boolean => i + k < tokens.length && !/^[A-Za-z]$/.test(tokens[i + k]!);
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i]!)) cmd = tokens[i++]!;
    else if (cmd === "") {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const pt = (): [number, number] => {
      const a = num();
      const b = num();
      return rel ? [x + a, y + b] : [a, b];
    };
    switch (C) {
      case "Z":
        out.push("Z");
        [x, y] = [sx0, sy0];
        cmd = "";
        break;
      case "M": {
        if (!isNum(1)) { i = tokens.length; break; }
        [x, y] = pt();
        [sx0, sy0] = [x, y];
        out.push(`M${X(x)} ${Y(y)}`);
        cmd = rel ? "l" : "L";
        break;
      }
      case "L":
      case "T": {
        if (!isNum(1)) { i = tokens.length; break; }
        [x, y] = pt();
        out.push(`${C}${X(x)} ${Y(y)}`);
        break;
      }
      case "H": {
        if (!isNum()) { i = tokens.length; break; }
        const v = num();
        x = rel ? x + v : v;
        out.push(`L${X(x)} ${Y(y)}`);
        break;
      }
      case "V": {
        if (!isNum()) { i = tokens.length; break; }
        const v = num();
        y = rel ? y + v : v;
        out.push(`L${X(x)} ${Y(y)}`);
        break;
      }
      case "C": {
        if (!isNum(5)) { i = tokens.length; break; }
        const p1 = pt();
        const p2 = pt();
        const p3 = pt();
        out.push(`C${X(p1[0])} ${Y(p1[1])} ${X(p2[0])} ${Y(p2[1])} ${X(p3[0])} ${Y(p3[1])}`);
        [x, y] = p3;
        break;
      }
      case "S":
      case "Q": {
        if (!isNum(3)) { i = tokens.length; break; }
        const p1 = pt();
        const p2 = pt();
        out.push(`${C}${X(p1[0])} ${Y(p1[1])} ${X(p2[0])} ${Y(p2[1])}`);
        [x, y] = p2;
        break;
      }
      case "A": {
        if (!isNum(6)) { i = tokens.length; break; }
        const rx = Math.abs(num() * sx);
        const ry = Math.abs(num() * sy);
        const rot = num();
        const large = num();
        let sweep = num();
        if (sx * sy < 0) sweep = sweep ? 0 : 1;
        const e = pt();
        out.push(`A${n(rx)} ${n(ry)} ${rot} ${large ? 1 : 0} ${sweep ? 1 : 0} ${X(e[0])} ${Y(e[1])}`);
        [x, y] = e;
        break;
      }
      default:
        i++;
    }
  }
  return out.join("");
}

/** `svg:points` (`x,y x,y …`) as a path, open or closed. */
export function pointsPath(points: string, closed: boolean, ox: number, oy: number, sx: number, sy: number): string {
  const v = (points.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
  const out: string[] = [];
  for (let k = 0; k + 1 < v.length; k += 2) out.push(`${k === 0 ? "M" : "L"}${n((v[k]! - ox) * sx)} ${n((v[k + 1]! - oy) * sy)}`);
  if (closed && out.length > 0) out.push("Z");
  return out.join("");
}

export function rectPath(w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r === 0) return `M0 0L${n(w)} 0L${n(w)} ${n(h)}L0 ${n(h)}Z`;
  const a = (ex: number, ey: number): string => `A${n(r)} ${n(r)} 0 0 1 ${n(ex)} ${n(ey)}`;
  return `M${n(r)} 0L${n(w - r)} 0${a(w, r)}L${n(w)} ${n(h - r)}${a(w - r, h)}L${n(r)} ${n(h)}${a(0, h - r)}L0 ${n(r)}${a(r, 0)}Z`;
}

/**
 * `draw:ellipse`/`draw:circle` in its box: a full ellipse, or the part
 * `draw:kind` keeps between two angles (degrees, counter-clockwise from three
 * o'clock): `arc` (the curve alone), `cut` (closed by its chord), `section`
 * (a slice, through the centre).
 */
export function ellipsePath(w: number, h: number, kind: string, startDeg: number, endDeg: number): string {
  const rx = w / 2;
  const ry = h / 2;
  if (kind !== "arc" && kind !== "cut" && kind !== "section") {
    return `M0 ${n(ry)}A${n(rx)} ${n(ry)} 0 1 1 ${n(w)} ${n(ry)}A${n(rx)} ${n(ry)} 0 1 1 0 ${n(ry)}Z`;
  }
  const at = (deg: number): [number, number] => [rx + rx * Math.cos((deg * Math.PI) / 180), ry - ry * Math.sin((deg * Math.PI) / 180)];
  let span = (endDeg - startDeg) % 360;
  if (span <= 0) span += 360;
  const [x0, y0] = at(startDeg);
  const [xm, ym] = at(startDeg + span / 2);
  const [x1, y1] = at(startDeg + span);
  // Two halves, so a span past 180° needs no large-arc flag.
  const curve = `A${n(rx)} ${n(ry)} 0 0 0 ${n(xm)} ${n(ym)}A${n(rx)} ${n(ry)} 0 0 0 ${n(x1)} ${n(y1)}`;
  if (kind === "arc") return `M${n(x0)} ${n(y0)}${curve}`;
  if (kind === "cut") return `M${n(x0)} ${n(y0)}${curve}Z`;
  return `M${n(rx)} ${n(ry)}L${n(x0)} ${n(y0)}${curve}Z`;
}

/** An angle attribute in degrees: `30`, `30deg`, `0.5rad`, `33.3grad`. */
export function degrees(value: string | null | undefined, fallback = 0): number {
  if (!value) return fallback;
  const v = parseFloat(value);
  if (!Number.isFinite(v)) return fallback;
  if (value.endsWith("rad") && !value.endsWith("grad")) return (v * 180) / Math.PI;
  if (value.endsWith("grad")) return v * 0.9;
  return v;
}

// -- transforms -------------------------------------------------------------------------------

/** An affine map `[a b c d e f]`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` followed by `n`. */
export function compose(m: Matrix, k: Matrix): Matrix {
  return [
    k[0] * m[0] + k[2] * m[1],
    k[1] * m[0] + k[3] * m[1],
    k[0] * m[2] + k[2] * m[3],
    k[1] * m[2] + k[3] * m[3],
    k[0] * m[4] + k[2] * m[5] + k[4],
    k[1] * m[4] + k[3] * m[5] + k[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * `draw:transform`, each operation applied after the previous one — the
 * order ODF lists them in, unlike SVG. Rotation is counter-clockwise on
 * screen and skews are mirrored, as LibreOffice reads them
 * (`xmloff/source/draw/xexptran.cxx`). Lengths go through `length` (EMU).
 */
export function parseTransform(value: string, length: (v: string) => number | null): Matrix {
  let m = IDENTITY;
  for (const [, op, args] of value.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const a = args!.trim().split(/[\s,]+/).filter(Boolean);
    switch (op) {
      case "rotate": {
        const t = Number(a[0]) || 0;
        m = compose(m, [Math.cos(t), -Math.sin(t), Math.sin(t), Math.cos(t), 0, 0]);
        break;
      }
      case "translate":
        m = compose(m, [1, 0, 0, 1, length(a[0] ?? "0") ?? 0, length(a[1] ?? "0") ?? 0]);
        break;
      case "scale":
        m = compose(m, [Number(a[0] ?? 1) || 1, 0, 0, Number(a[1] ?? a[0] ?? 1) || 1, 0, 0]);
        break;
      case "skewX":
        m = compose(m, [1, 0, -Math.tan(Number(a[0]) || 0), 1, 0, 0]);
        break;
      case "skewY":
        m = compose(m, [1, -Math.tan(Number(a[0]) || 0), 0, 1, 0, 0]);
        break;
      case "matrix": {
        const v = a.map((s, k) => (k >= 4 ? (length(s) ?? 0) : Number(s) || 0));
        if (v.length === 6) m = compose(m, v as Matrix);
        break;
      }
      default:
        break;
    }
  }
  return m;
}

const n = (v: number): string => String(Math.round(v * 100) / 100);
