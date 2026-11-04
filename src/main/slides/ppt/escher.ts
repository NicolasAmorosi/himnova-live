import type { Effects, Fill, GeometryPath, Insets, Line, LineEnd } from "@shared/types/slide-model";
import type { Rec } from "../ppt-binary";

/**
 * OfficeArt (MS-ODRAW, «Escher») as a legacy `.ppt` stores a shape: a property
 * table per shape, inherited from a master shape and from the document's
 * defaults, and the shape type's built-in geometry. Everything here turns
 * those numbers into the `SlideModel` vocabulary `SlideView` already paints.
 *
 * The built-in geometries are LibreOffice's table of Office's own shapes
 * (`resources/ooxml/mso-shapes.json`, extracted from svx
 * `EnhancedCustomShapeGeometry.cxx`, MPL-2.0): vertices, segment commands and
 * formulas in the same binary encoding a freeform carries in its own
 * properties, so one evaluator draws both.
 */

/** Master units per inch (576) → EMU (914 400 per inch). */
export const EMU_PER_MASTER = 914400 / 576;

// -- the property table ------------------------------------------------------

export type Props = {
  simple: Map<number, number>;
  /** Complex data (`fComplex`): arrays, strings — by property id. */
  complex: Map<number, Buffer>;
};

export const emptyProps = (): Props => ({ simple: new Map(), complex: new Map() });

/** `OfficeArtFOPT`/`OfficeArtSecondaryFOPT`/`OfficeArtTertiaryFOPT`: 6-byte
 *  entries, then the complex data of those that have it, in the same order. */
export function readPropTable(buf: Buffer, rec: Rec, into: Props): void {
  const count = rec.recInstance;
  const end = rec.body + rec.len;
  let complexAt = rec.body + count * 6;
  for (let i = 0; i < count; i++) {
    const at = rec.body + i * 6;
    if (at + 6 > end) break;
    const raw = buf.readUInt16LE(at);
    const id = raw & 0x3fff;
    const value = buf.readUInt32LE(at + 2);
    into.simple.set(id, value);
    if (raw & 0x8000) {
      const take = Math.max(0, Math.min(value, end - complexAt));
      into.complex.set(id, buf.subarray(complexAt, complexAt + take));
      complexAt += take;
    }
  }
}

/** Every property set ends in a word of 16 booleans, each meaningful only
 *  under its `fUse` twin in the high half (MS-ODRAW 2.3). */
export const isBooleanProp = (id: number): boolean => (id & 0x3f) === 0x3f;

/** A flag word over the one it inherits from, flag by flag. */
export function mergeFlags(own: number, inherited: number): number {
  const ownUse = (own >>> 16) & 0xffff;
  const values = (own & ownUse) | (inherited & ~ownUse & 0xffff);
  return (((own | inherited) & 0xffff0000) | values) >>> 0;
}

/** `own` over `base`: values replace, flag words merge. */
export function overProps(own: Props, base: Props): Props {
  const simple = new Map(base.simple);
  for (const [id, value] of own.simple) {
    const inherited = base.simple.get(id);
    simple.set(id, inherited !== undefined && isBooleanProp(id) ? mergeFlags(value, inherited) : value);
  }
  const complex = new Map(base.complex);
  for (const [id, data] of own.complex) complex.set(id, data);
  return { simple, complex };
}

/** A flag of a boolean word, or `undefined` when nobody said. */
export function flag(props: Props, id: number, bit: number): boolean | undefined {
  const value = props.simple.get(id);
  if (value === undefined || ((value >>> 16) & bit) === 0) return undefined;
  return (value & bit) !== 0;
}

/** 16.16 fixed point. */
export const fixed = (value: number): number => (value | 0) / 65536;

/** `IMsoArray`: count, allocated count, element size, then the elements. Some
 *  writers leave the header out of the size they declare: read what is there. */
export function msoArray(data: Buffer | undefined): { count: number; size: number; at: (i: number) => number } | null {
  if (!data || data.length < 6) return null;
  const count = data.readUInt16LE(0);
  let size = data.readUInt16LE(4);
  if (size === 0xfff0) size = 4;
  if (size <= 0) return null;
  const fits = Math.floor((data.length - 6) / size);
  return { count: Math.min(count, fits), size, at: (i) => 6 + i * size };
}

/** A UTF-16 string property, its trailing NUL dropped. */
export function propString(props: Props, id: number): string | null {
  const data = props.complex.get(id);
  if (!data || data.length < 2) return null;
  return data.toString("utf16le", 0, data.length & ~1).replace(/\0+$/, "");
}

// -- colours ------------------------------------------------------------------

export type Rgb = { r: number; g: number; b: number };

/** The eight colours of a slide's scheme (`ColorSchemeAtom`): background,
 *  text and lines, shadows, title text, fills, accent, accent and hyperlink,
 *  accent and followed hyperlink. */
export type Scheme = Rgb[];

export const P = {
  rotation: 0x0004,
  dxTextLeft: 0x0081, dyTextTop: 0x0082, dxTextRight: 0x0083, dyTextBottom: 0x0084,
  wrapText: 0x0085, anchorText: 0x0087, txflTextFlow: 0x0088, textBooleans: 0x00bf,
  gtextUnicode: 0x00c0, gtextAlign: 0x00c2, gtextSize: 0x00c3, gtextFont: 0x00c5, gtextBooleans: 0x00ff,
  cropTop: 0x0100, cropBottom: 0x0101, cropLeft: 0x0102, cropRight: 0x0103, pib: 0x0104, pibFlags: 0x0106,
  pictureContrast: 0x0108, pictureBrightness: 0x0109, pictureBooleans: 0x013f,
  geoLeft: 0x0140, geoTop: 0x0141, geoRight: 0x0142, geoBottom: 0x0143,
  vertices: 0x0145, segments: 0x0146, adjust1: 0x0147, guides: 0x0156, inscribe: 0x0157,
  fillType: 0x0180, fillColor: 0x0181, fillOpacity: 0x0182, fillBackColor: 0x0183, fillBackOpacity: 0x0184,
  fillBlip: 0x0186, fillWidth: 0x0189, fillHeight: 0x018a, fillAngle: 0x018b, fillFocus: 0x018c,
  fillToLeft: 0x018d, fillToTop: 0x018e, fillToRight: 0x018f, fillToBottom: 0x0190, fillShadeColors: 0x0197,
  fillBooleans: 0x01bf,
  lineColor: 0x01c0, lineOpacity: 0x01c1, lineType: 0x01c4, lineWidth: 0x01cb, lineStyle: 0x01cd, lineDashing: 0x01ce,
  lineDashStyle: 0x01cf, lineStartArrow: 0x01d0, lineEndArrow: 0x01d1, lineStartArrowWidth: 0x01d2,
  lineStartArrowLength: 0x01d3, lineEndArrowWidth: 0x01d4, lineEndArrowLength: 0x01d5, lineJoin: 0x01d6,
  lineEndCap: 0x01d7, lineBooleans: 0x01ff,
  shadowType: 0x0200, shadowColor: 0x0201, shadowOpacity: 0x0204, shadowOffsetX: 0x0205, shadowOffsetY: 0x0206,
  shadowBooleans: 0x023f,
  threeDBooleans: 0x02ff,
  hspMaster: 0x0301, shapeBooleans: 0x033f, groupBooleans: 0x03bf,
} as const;

/** Special colours a `fSysIndex` colour may name (MS-ODRAW 2.2.2): another of
 *  the same shape's colours, then darkened, lightened… by a parameter. */
const SYS_FILL = 0xf0, SYS_LINE_OR_FILL = 0xf1, SYS_LINE = 0xf2, SYS_SHADOW = 0xf3, SYS_THIS = 0xf4;
const SYS_FILL_BACK = 0xf5, SYS_LINE_BACK = 0xf6, SYS_FILL_THEN_LINE = 0xf7;

/** Windows system colours by index (COLOR_*), as Office draws them. */
const SYSTEM: Rgb[] = [
  [0xc0, 0xc0, 0xc0], [0x00, 0x80, 0x80], [0x00, 0x00, 0x80], [0x80, 0x80, 0x80], [0xc0, 0xc0, 0xc0], [0xff, 0xff, 0xff],
  [0x00, 0x00, 0x00], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00], [0xff, 0xff, 0xff], [0xc0, 0xc0, 0xc0], [0xc0, 0xc0, 0xc0],
  [0x80, 0x80, 0x80], [0x00, 0x00, 0x80], [0xff, 0xff, 0xff], [0xc0, 0xc0, 0xc0], [0x80, 0x80, 0x80], [0x80, 0x80, 0x80],
  [0x00, 0x00, 0x00], [0xc0, 0xc0, 0xc0], [0xff, 0xff, 0xff], [0x00, 0x00, 0x00], [0xdf, 0xdf, 0xdf], [0x00, 0x00, 0x00],
  [0xff, 0xff, 0xe1],
].map(([r, g, b]) => ({ r: r!, g: g!, b: b! }));

/** An `OfficeArtCOLORREF` as a colour, or `null` when it names nothing. */
export function color(value: number, scheme: Scheme, props: Props | null, depth = 0): Rgb | null {
  const r = value & 0xff, g = (value >>> 8) & 0xff, b = (value >>> 16) & 0xff;
  const flags = value >>> 24;
  if (flags & 0x10) {
    // fSysIndex: a system colour, or another colour of this shape, modified.
    const index = value & 0xff;
    const fn = (value >>> 8) & 0x0f;
    const extra = (value >>> 8) & 0xf0;
    const param = b;
    let base: Rgb | null = null;
    const ref = (id: number, fallback: number): Rgb | null => {
      const v = props?.simple.get(id) ?? fallback;
      return depth > 2 || (v >>> 24) & 0x10 ? null : color(v, scheme, props, depth + 1);
    };
    const lineOn = props ? flag(props, P.lineBooleans, 0x08) !== false : true;
    switch (index) {
      case SYS_FILL: case SYS_THIS: base = ref(P.fillColor, 0xffffff); break;
      case SYS_LINE: base = ref(P.lineColor, 0); break;
      case SYS_LINE_OR_FILL: base = lineOn ? ref(P.lineColor, 0) : ref(P.fillColor, 0xffffff); break;
      case SYS_FILL_THEN_LINE: base = ref(P.fillColor, 0xffffff); break;
      case SYS_SHADOW: base = ref(P.shadowColor, 0x808080); break;
      case SYS_FILL_BACK: base = ref(P.fillBackColor, 0xffffff); break;
      case SYS_LINE_BACK: base = ref(0x01c2, 0xffffff); break; // lineBackColor
      default: base = SYSTEM[index] ?? null;
    }
    if (!base) return null;
    let { r: rr, g: gg, b: bb } = base;
    if (extra & 0x80) {
      // Gray first, as Office (and LibreOffice) apply it.
      const grey = Math.round(0.299 * rr + 0.587 * gg + 0.114 * bb);
      rr = gg = bb = grey;
    }
    switch (fn) {
      case 1: rr = (param * rr) >> 8; gg = (param * gg) >> 8; bb = (param * bb) >> 8; break; // darken
      case 2: {
        const inv = (0xff - param) * 0xff; // lighten
        rr = (inv + param * rr) >> 8; gg = (inv + param * gg) >> 8; bb = (inv + param * bb) >> 8;
        break;
      }
      case 3: rr = Math.min(255, rr + param); gg = Math.min(255, gg + param); bb = Math.min(255, bb + param); break;
      case 4: rr = Math.max(0, rr - param); gg = Math.max(0, gg - param); bb = Math.max(0, bb - param); break;
      case 5: rr = Math.max(0, param - rr); gg = Math.max(0, param - gg); bb = Math.max(0, param - bb); break;
      case 6: rr = rr < param ? 0 : 255; gg = gg < param ? 0 : 255; bb = bb < param ? 0 : 255; break;
    }
    if (extra & 0x40) {
      rr ^= 0x80; gg ^= 0x80; bb ^= 0x80;
    }
    if (extra & 0x20) {
      rr = 255 - rr; gg = 255 - gg; bb = 255 - bb;
    }
    return { r: rr, g: gg, b: bb };
  }
  if (flags & 0x08) return scheme[r] ?? null; // fSchemeIndex
  return { r, g, b };
}

/** The model's colour format (`pptx/color.ts` `css`): the painter reads the
 *  channels back out of it to blend gradient stops. */
export const cssColor = (c: Rgb, alpha = 1): string =>
  alpha >= 1 ? `rgb(${c.r},${c.g},${c.b})` : `rgba(${c.r},${c.g},${c.b},${Math.round(Math.max(0, alpha) * 1000) / 1000})`;

// -- fill, line, shadow -------------------------------------------------------

/** What the shape's pictures are, resolved by the reader (a BLIP id → part). */
export type BlipResolver = (pib: number) => { part: string; size: { w: number; h: number } | null } | null;

export type DrawContext = {
  scheme: Scheme;
  blip: BlipResolver;
  miss: (what: string) => void;
};

/** The fill a shape paints, or `null` for none. `filledByDefault` is the shape
 *  type's own default when no property says (lines, brackets and arcs are not
 *  filled). */
export function readFill(props: Props, ctx: DrawContext, filledByDefault: boolean): Fill | null {
  const filled = flag(props, P.fillBooleans, 0x10) ?? filledByDefault;
  if (!filled) return null;
  const v = (id: number, fallback: number): number => props.simple.get(id) ?? fallback;
  const fillColor = color(v(P.fillColor, 0xffffff), ctx.scheme, props) ?? { r: 255, g: 255, b: 255 };
  const backColor = color(v(P.fillBackColor, 0xffffff), ctx.scheme, props) ?? { r: 255, g: 255, b: 255 };
  const opacity = props.simple.has(P.fillOpacity) ? fixed(v(P.fillOpacity, 65536)) : 1;
  const backOpacity = props.simple.has(P.fillBackOpacity) ? fixed(v(P.fillBackOpacity, 65536)) : 1;
  const type = v(P.fillType, 0);
  switch (type) {
    case 0:
      return { kind: "solid", color: cssColor(fillColor, opacity) };
    case 1: {
      // A two-colour 8×8 bitmap pattern: drawn as its average.
      ctx.miss("fill:pattern");
      const mix = (a: number, b: number): number => Math.round((a + b) / 2);
      return { kind: "solid", color: cssColor({ r: mix(fillColor.r, backColor.r), g: mix(fillColor.g, backColor.g), b: mix(fillColor.b, backColor.b) }, opacity) };
    }
    case 2:
    case 3: {
      const picture = ctx.blip(v(P.fillBlip, 0));
      if (!picture) {
        ctx.miss("fill:picture-missing");
        return { kind: "solid", color: cssColor(fillColor, opacity) };
      }
      const image = { part: picture.part, crop: null, fill: null, alpha: opacity, effects: [] };
      if (type === 3) return { kind: "image", image, mode: "stretch" };
      // A texture: tiled at its own size, or the size the file asks for.
      const w = props.simple.get(P.fillWidth) ?? (picture.size ? picture.size.w : 914400);
      const h = props.simple.get(P.fillHeight) ?? (picture.size ? picture.size.h : 914400);
      return { kind: "image", image, mode: "tile", tile: { size: { w, h }, sx: 1, sy: 1, tx: 0, ty: 0, align: "tl", flip: "none" } };
    }
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
      return gradient(type, props, ctx, fillColor, backColor, opacity, backOpacity);
    case 9:
      return { kind: "background" };
    default:
      ctx.miss(`fill:type-${type}`);
      return { kind: "solid", color: cssColor(fillColor, opacity) };
  }
}

/** A shaded fill, following LibreOffice's reading of the same properties
 *  (`ImportGradientColor`): which colour starts depends on the angle's sign
 *  and on the focus, and a focus near the middle is an axial gradient. */
function gradient(type: number, props: Props, ctx: DrawContext, fill: Rgb, back: Rgb, opacity: number, backOpacity: number): Fill {
  const angleFix = props.simple.get(P.fillAngle) ?? 0;
  let swap = (angleFix | 0) >= 0;
  let focus = (props.simple.get(P.fillFocus) ?? 0) | 0;
  if (focus === 0) swap = !swap;
  else if (focus < 0) {
    focus = -focus;
    swap = !swap;
  }
  let style: "linear" | "axial" | "rect" = "linear";
  if (focus > 40 && focus < 60) {
    style = "axial";
    swap = !swap;
  }
  if (type === 5 || type === 6) {
    style = "rect";
    swap = !swap;
  }
  let c1 = { color: fill, alpha: opacity };
  let c2 = { color: back, alpha: backOpacity };
  if (swap) [c1, c2] = [c2, c1];
  // `fillShadeColors` lists the stops from the fill colour's end (1) to the
  // back colour's (0); kept only for the two-colour reading's direction.
  const stopsFrom = (from: typeof c1, to: typeof c1): { pos: number; color: string }[] => {
    const shade = msoArray(props.complex.get(P.fillShadeColors));
    if (shade && shade.count >= 2 && shade.size >= 8) {
      const data = props.complex.get(P.fillShadeColors)!;
      const stops: { pos: number; color: string }[] = [];
      for (let i = 0; i < shade.count; i++) {
        const at = shade.at(i);
        const c = color(data.readUInt32LE(at), ctx.scheme, props);
        if (c) stops.push({ pos: 1 - fixed(data.readInt32LE(at + 4)), color: cssColor(c) });
      }
      stops.sort((a, b) => a.pos - b.pos);
      // LibreOffice's order: stop 0 is the back colour. Flip with the swap.
      return from.color === back ? stops : stops.map((s) => ({ pos: 1 - s.pos, color: s.color })).reverse();
    }
    return [
      { pos: 0, color: cssColor(from.color, from.alpha) },
      { pos: 1, color: cssColor(to.color, to.alpha) },
    ];
  };
  // LibreOffice's angle (counter-clockwise, 0 = top to bottom) is 360 − the
  // file's clockwise one; ours is OOXML's direction the colours run.
  const fileAngle = fixed(angleFix);
  const angle = (((fileAngle + 90) % 360) + 360) % 360;
  if (style === "rect") {
    const f = (id: number): number => fixed(props.simple.get(id) ?? 0);
    const focusRect =
      type === 6
        ? { l: 0.5, t: 0.5, r: 0.5, b: 0.5 }
        : { l: f(P.fillToLeft), t: f(P.fillToTop), r: 1 - f(P.fillToRight), b: 1 - f(P.fillToBottom) };
    // A path gradient's first stop is at the focus; LibreOffice's start is at the border.
    return { kind: "path", shape: type === 6 ? "shape" : "rect", focus: focusRect, stops: stopsFrom(c1, c2) };
  }
  const stops = stopsFrom(c2, c1);
  if (style === "axial") {
    const half = stops.map((s) => ({ pos: s.pos / 2, color: s.color }));
    const mirrored = [...stops].reverse().map((s) => ({ pos: 1 - s.pos / 2, color: s.color }));
    return { kind: "linear", angle, scaled: type === 7, stops: [...half, ...mirrored.slice(1)] };
  }
  return { kind: "linear", angle, scaled: type === 7, stops };
}

const DASHES: Record<number, number[]> = {
  1: [3, 1], 2: [1, 1], 3: [3, 1, 1, 1], 4: [3, 1, 1, 1, 1, 1], 5: [1, 3], 6: [4, 3], 7: [8, 3], 8: [4, 3, 1, 3],
  9: [8, 3, 1, 3], 10: [8, 3, 1, 3, 1, 3],
};

const ARROWS: Record<number, LineEnd["type"]> = { 1: "triangle", 2: "stealth", 3: "diamond", 4: "oval", 5: "arrow", 6: "arrow", 7: "arrow" };

/** The line a shape draws, or `null` for none. */
export function readLine(props: Props, ctx: DrawContext, strokedByDefault: boolean): Line | null {
  const on = flag(props, P.lineBooleans, 0x08) ?? strokedByDefault;
  if (!on) return null;
  const v = (id: number, fallback: number): number => props.simple.get(id) ?? fallback;
  const c = color(v(P.lineColor, 0), ctx.scheme, props) ?? { r: 0, g: 0, b: 0 };
  const opacity = props.simple.has(P.lineOpacity) ? fixed(v(P.lineOpacity, 65536)) : 1;
  if (v(P.lineType, 0) !== 0) ctx.miss("line:fill");
  const end = (type: number, width: number, length: number): LineEnd | null => {
    const kind = ARROWS[type];
    if (!kind) return null;
    const size = (n: number): LineEnd["w"] => (n === 0 ? "sm" : n === 2 ? "lg" : "med");
    return { type: kind, w: size(width), len: size(length) };
  };
  const dashing = v(P.lineDashing, 0);
  let dash = DASHES[dashing] ?? null;
  const custom = msoArray(props.complex.get(P.lineDashStyle));
  if (custom && custom.size === 4 && dashing === 0 && custom.count > 0) {
    const data = props.complex.get(P.lineDashStyle)!;
    dash = Array.from({ length: custom.count }, (_, i) => data.readUInt32LE(custom.at(i)) / 65536);
  }
  const style = v(P.lineStyle, 0);
  const join = v(P.lineJoin, 2);
  const cap = v(P.lineEndCap, 2);
  return {
    fill: { kind: "solid", color: cssColor(c, opacity) },
    width: v(P.lineWidth, 9525),
    dash,
    cap: cap === 0 ? "round" : cap === 1 ? "square" : "flat",
    join: join === 0 ? "bevel" : join === 1 ? "miter" : "round",
    head: end(v(P.lineStartArrow, 0), v(P.lineStartArrowWidth, 1), v(P.lineStartArrowLength, 1)),
    tail: end(v(P.lineEndArrow, 0), v(P.lineEndArrowWidth, 1), v(P.lineEndArrowLength, 1)),
    compound: style === 1 ? "dbl" : style === 2 ? "thickThin" : style === 3 ? "thinThick" : style === 4 ? "tri" : "sng",
  };
}

export const NO_EFFECTS: Effects = { shadow: null, glow: null, softEdge: null, reflection: null, overlay: null };

/** The shape's shadow (an offset copy, the only kind PowerPoint 97 draws). */
export function readEffects(props: Props, ctx: DrawContext): Effects {
  if (!flag(props, P.shadowBooleans, 0x02)) return NO_EFFECTS;
  const type = props.simple.get(P.shadowType) ?? 0;
  if (type !== 0 && type !== 1) ctx.miss(`shadow:type-${type}`);
  const c = color(props.simple.get(P.shadowColor) ?? 0x808080, ctx.scheme, props) ?? { r: 128, g: 128, b: 128 };
  const opacity = props.simple.has(P.shadowOpacity) ? fixed(props.simple.get(P.shadowOpacity)!) : 1;
  const dx = (props.simple.get(P.shadowOffsetX) ?? 25400) | 0;
  const dy = (props.simple.get(P.shadowOffsetY) ?? 25400) | 0;
  return {
    ...NO_EFFECTS,
    shadow: { color: cssColor(c, opacity), blur: 0, dist: Math.hypot(dx, dy), dir: (Math.atan2(dy, dx) * 180) / Math.PI, inner: false, sx: 1, sy: 1 },
  };
}

// -- geometry -------------------------------------------------------------------

/** One built-in shape of `mso-shapes.json`. Coordinates and formula operands
 *  are numbers, or `"@n"` for formula n's result. */
export type MsoShape = {
  w: number;
  h: number;
  v?: (number | string)[][];
  s?: number[];
  c?: number[][];
  d?: number[];
  t?: (number | string)[][];
  /** Adjust values that are angles (16.16 in a file, degrees in the table). */
  a?: number[];
};

export type MsoShapeTable = { shapes: Map<number, MsoShape>; notFilled: Set<number>; notStroked: Set<number> };

export function parseMsoShapes(json: string): MsoShapeTable {
  const raw = JSON.parse(json) as { shapes: Record<string, MsoShape>; notFilled: number[]; notStroked: number[] };
  return {
    shapes: new Map(Object.entries(raw.shapes).map(([k, v]) => [Number(k), v])),
    notFilled: new Set(raw.notFilled),
    notStroked: new Set(raw.notStroked),
  };
}

export type ShapeGeometry = { paths: GeometryPath[]; textRect: Insets };

const DFF_ADJUST = 0x147;
const DFF_GEO_LEFT = 0x140, DFF_GEO_TOP = 0x141, DFF_GEO_RIGHT = 0x142, DFF_GEO_BOTTOM = 0x143;

type Operand = number | string;
type Source = {
  coordW: number;
  coordH: number;
  /** View box origin (`geoLeft`/`geoTop`). */
  left: number;
  top: number;
  vertices: Operand[][];
  segments: number[];
  formulas: number[][];
  adjust: number[];
  textRects: Operand[][];
  /** Angles inside formulas are 16.16 (a file's own guides) or degrees (the table). */
  fileAngles: boolean;
  /** A freeform of the file: its angle-ellipse angles are 16.16 start and swing. */
  fromFile: boolean;
};

/**
 * A shape's geometry in its own box (0..w × 0..h, EMU): its freeform
 * properties when it has them, else its type's built-in definition with the
 * file's adjust values. `null` when there is nothing to draw it from.
 */
export function shapeGeometry(type: number, props: Props, w: number, h: number, table: MsoShapeTable): ShapeGeometry | null {
  const def = table.shapes.get(type);
  const fileVertices = vertexArray(props.complex.get(P.vertices));
  const fileSegments = segmentArray(props.complex.get(P.segments));
  const left = (props.simple.get(P.geoLeft) ?? 0) | 0;
  const top = (props.simple.get(P.geoTop) ?? 0) | 0;
  const right = props.simple.get(P.geoRight);
  const bottom = props.simple.get(P.geoBottom);
  const useFile = fileVertices !== null && (type === 0 || !def || fileVertices.length > 0);
  if (!def && !useFile) return null;

  const defaults = def?.d ?? [];
  const adjust: number[] = [];
  for (let i = 0; i < 10; i++) {
    const own = props.simple.get(DFF_ADJUST + i);
    if (own === undefined) adjust.push(defaults[i] ?? 0);
    else adjust.push(def?.a?.includes(i) ? fixed(own) : own | 0);
  }
  const source: Source = {
    coordW: useFile ? ((right ?? 21600) | 0) - left : (def?.w ?? 21600),
    coordH: useFile ? ((bottom ?? 21600) | 0) - top : (def?.h ?? 21600),
    left: useFile ? left : 0,
    top: useFile ? top : 0,
    vertices: useFile ? (fileVertices ?? []) : (def?.v ?? []),
    segments: useFile ? (fileSegments ?? []) : (def?.s ?? []),
    formulas: useFile && props.complex.has(P.guides) ? guideArray(props.complex.get(P.guides)) : (def?.c ?? []),
    adjust,
    textRects: useFile && props.complex.has(P.inscribe) ? textRectArray(props.complex.get(P.inscribe)) : (def?.t ?? []),
    fileAngles: useFile && props.complex.has(P.guides),
    fromFile: useFile,
  };
  // ponytail: the table's stretch points (`xr`/`yr`, callouts and a few arrows) are ignored: a
  // shape far from its design proportions bends a little differently than in PowerPoint.

  return evaluate(source, w, h, props);
}

function vertexArray(data: Buffer | undefined): Operand[][] | null {
  const arr = msoArray(data);
  if (!arr || !data) return null;
  const out: Operand[][] = [];
  for (let i = 0; i < arr.count; i++) {
    const at = arr.at(i);
    if (arr.size >= 8) out.push([vertexValue(data.readUInt32LE(at)), vertexValue(data.readUInt32LE(at + 4))]);
    else out.push([vertexValue16(data.readUInt16LE(at)), vertexValue16(data.readUInt16LE(at + 2))]);
  }
  return out;
}

const vertexValue = (v: number): Operand => (v >>> 16 === 0x8000 ? `@${v & 0xffff}` : v | 0);
/** A 16-bit vertex: 0xFFF0 and above are formula references in some writers. */
const vertexValue16 = (v: number): Operand => (v >= 0xfff0 ? `@${v - 0xfff0}` : v);

function segmentArray(data: Buffer | undefined): number[] | null {
  const arr = msoArray(data);
  if (!arr || !data || arr.size !== 2) return null;
  return Array.from({ length: arr.count }, (_, i) => data.readUInt16LE(arr.at(i)));
}

function guideArray(data: Buffer | undefined): number[][] {
  const arr = msoArray(data);
  if (!arr || !data || arr.size < 8) return [];
  return Array.from({ length: arr.count }, (_, i) => {
    const at = arr.at(i);
    return [data.readUInt16LE(at), data.readUInt16LE(at + 2), data.readUInt16LE(at + 4), data.readUInt16LE(at + 6)];
  });
}

function textRectArray(data: Buffer | undefined): Operand[][] {
  const arr = msoArray(data);
  if (!arr || !data || arr.size < 16) return [];
  return Array.from({ length: arr.count }, (_, i) => {
    const at = arr.at(i);
    return [0, 4, 8, 12].map((o) => vertexValue(data.readUInt32LE(at + o)));
  });
}

/** Formula evaluation, the binary encoding (MS-ODRAW 2.2.?? `SG`): a function
 *  code and three operands, each a constant unless its «special» bit says it
 *  names an adjust value, a geometry bound or another formula. */
function evaluate(src: Source, w: number, h: number, props: Props): ShapeGeometry {
  const results: number[] = [];
  const special = (p: number): number => {
    if (p & 0x400) return results[p & 0xff] ?? 0;
    if (p >= DFF_ADJUST && p < DFF_ADJUST + 10) return src.adjust[p - DFF_ADJUST] ?? 0;
    switch (p) {
      case DFF_GEO_LEFT: return src.left;
      case DFF_GEO_TOP: return src.top;
      case DFF_GEO_RIGHT: return src.left + src.coordW;
      case DFF_GEO_BOTTOM: return src.top + src.coordH;
      case 0x153: return (props.simple.get(P.lineWidth) ?? 9525) / 12700; // pixelLineWidth, approximately
      default: return 0;
    }
  };
  const deg = (a: number): number => ((src.fileAngles ? a / 65536 : a) * Math.PI) / 180;
  for (const [fl = 0, p1 = 0, p2 = 0, p3 = 0] of src.formulas) {
    const a = fl & 0x2000 ? special(p1) : p1 > 0x7fff && src.fileAngles ? p1 - 0x10000 : p1;
    const b = fl & 0x4000 ? special(p2) : p2 > 0x7fff && src.fileAngles ? p2 - 0x10000 : p2;
    const c = fl & 0x8000 ? special(p3) : p3 > 0x7fff && src.fileAngles ? p3 - 0x10000 : p3;
    let r = 0;
    switch (fl & 0xff) {
      case 0: case 14: r = a + b - c; break;
      case 1: r = c === 0 ? a * b : (a * b) / c; break;
      case 2: r = (a + b) / 2; break;
      case 3: r = Math.abs(a); break;
      case 4: r = Math.min(a, b); break;
      case 5: r = Math.max(a, b); break;
      case 6: r = a > 0 ? b : c; break;
      case 7: r = Math.sqrt(a * a + b * b + c * c); break;
      case 8: r = (Math.atan2(b, a) * 180) / Math.PI * (src.fileAngles ? 65536 : 1); break;
      case 9: r = a * Math.sin(deg(b)); break;
      case 10: r = a * Math.cos(deg(b)); break;
      case 11: r = a * Math.cos(Math.atan2(c, b)); break;
      case 12: r = a * Math.sin(Math.atan2(c, b)); break;
      case 13: r = Math.sqrt(Math.max(0, a)); break;
      case 15: r = b === 0 ? 0 : c * Math.sqrt(Math.max(0, 1 - (a / b) * (a / b))); break;
      case 16: r = a * Math.tan(deg(b)); break;
      case 0x80: r = Math.sqrt(Math.max(0, c * c - a * a)); break;
      case 0x81: r = Math.cos(deg(c)) * (a - 10800) + Math.sin(deg(c)) * (b - 10800) + 10800; break;
      case 0x82: r = -(Math.sin(deg(c)) * (a - 10800) - Math.cos(deg(c)) * (b - 10800)) + 10800; break;
    }
    results.push(Number.isFinite(r) ? r : 0);
  }
  const num = (o: Operand | undefined): number => (typeof o === "string" ? (results[Number(o.slice(1))] ?? 0) : (o ?? 0));
  const sx = src.coordW === 0 ? 0 : w / src.coordW;
  const sy = src.coordH === 0 ? 0 : h / src.coordH;
  const X = (o: Operand | undefined): number => (num(o) - src.left) * sx;
  const Y = (o: Operand | undefined): number => (num(o) - src.top) * sy;
  const f = (n: number): string => String(Math.round(n));

  const paths: GeometryPath[] = [];
  let d = "";
  let fill: GeometryPath["fill"] = "norm";
  let stroke = true;
  let cur: [number, number] | null = null;
  let start: [number, number] | null = null;
  const flush = (): void => {
    if (d) paths.push({ d: d.trim(), fill, stroke });
    d = "";
    fill = "norm";
    stroke = true;
    cur = null;
    start = null;
  };
  const moveTo = (x: number, y: number): void => {
    d += `M${f(x)} ${f(y)} `;
    cur = [x, y];
    start = [x, y];
  };
  const lineTo = (x: number, y: number): void => {
    if (!cur) return moveTo(x, y);
    d += `L${f(x)} ${f(y)} `;
    cur = [x, y];
  };
  const v = src.vertices;
  let pt = 0;
  const point = (): [number, number] => {
    const p = v[pt++];
    return [X(p?.[0]), Y(p?.[1])];
  };

  if (src.segments.length === 0) {
    // No segments: one closed polygon through every vertex.
    v.forEach((p, i) => (i === 0 ? moveTo(X(p[0]), Y(p[1])) : lineTo(X(p[0]), Y(p[1]))));
    if (d) d += "Z ";
    flush();
  }
  for (const seg of src.segments) {
    const top3 = seg >>> 13;
    let count = seg & 0x1fff;
    if (top3 === 0) {
      for (let i = 0; i < Math.max(1, count) && pt < v.length; i++) lineTo(...point());
    } else if (top3 === 1) {
      for (let i = 0; i < Math.max(1, count) && pt + 2 < v.length; i++) {
        const [x1, y1] = point(), [x2, y2] = point(), [x3, y3] = point();
        if (!cur) moveTo(x1, y1);
        d += `C${f(x1)} ${f(y1)} ${f(x2)} ${f(y2)} ${f(x3)} ${f(y3)} `;
        cur = [x3, y3];
      }
    } else if (top3 === 2) {
      for (let i = 0; i < Math.max(1, count) && pt < v.length; i++) moveTo(...point());
    } else if (top3 === 3) {
      if (d) d += "Z ";
      if (start) cur = start;
    } else if (top3 === 4) {
      flush();
    } else {
      const escape = (seg >>> 8) & 0x1f;
      const n = seg & 0xff;
      switch (escape) {
        case 0x0: // extension: a line
          for (let i = 0; i < Math.max(1, n) && pt < v.length; i++) lineTo(...point());
          break;
        case 0x1: // angle ellipse to
        case 0x2: // angle ellipse
          count = Math.floor(n / 3);
          for (let i = 0; i < count && pt + 2 < v.length; i++) {
            const c = v[pt]!, size = v[pt + 1]!, angles = v[pt + 2]!;
            pt += 3;
            angleEllipse(X(c[0]), Y(c[1]), num(size[0]) * sx, num(size[1]) * sy, num(angles[0]), num(angles[1]), escape === 0x2);
          }
          break;
        case 0x3: case 0x4: case 0x5: case 0x6: { // arcto, arc, clockwise arcto, clockwise arc
          count = n >> 2;
          for (let i = 0; i < count && pt + 3 < v.length; i++) {
            const [x1, y1] = point(), [x2, y2] = point(), [x3, y3] = point(), [x4, y4] = point();
            arc(x1, y1, x2, y2, x3, y3, x4, y4, escape === 0x5 || escape === 0x6, escape === 0x4 || escape === 0x6);
          }
          break;
        }
        case 0x7: case 0x8: { // elliptical quadrant x / y, alternating
          let horizontal = escape === 0x7;
          for (let i = 0; i < Math.max(1, n) && pt < v.length; i++) {
            const [x1, y1] = point();
            if (!cur) {
              moveTo(x1, y1);
            } else {
              const [x0, y0] = cur;
              const k = 0.5522847498;
              const c1 = horizontal ? [x0 + k * (x1 - x0), y0] : [x0, y0 + k * (y1 - y0)];
              const c2 = horizontal ? [x1, y1 - k * (y1 - y0)] : [x1 - k * (x1 - x0), y1];
              d += `C${f(c1[0]!)} ${f(c1[1]!)} ${f(c2[0]!)} ${f(c2[1]!)} ${f(x1)} ${f(y1)} `;
              cur = [x1, y1];
            }
            horizontal = !horizontal;
          }
          break;
        }
        case 0xa: fill = "none"; break;
        case 0xb: stroke = false; break;
        default: break; // auto line/curve, corner, … carry no points we draw
      }
    }
  }
  flush();

  function angleEllipse(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, move: boolean): void {
    // The table's angles are degrees (start, end); a file's are 16.16 (start, swing).
    let startDeg: number, endDeg: number;
    if (src.fromFile) {
      startDeg = a0 / 65536;
      endDeg = startDeg + a1 / 65536;
    } else {
      startDeg = a0;
      endDeg = a1;
    }
    if (rx === 0 && ry === 0) return lineTo(cx, cy);
    // Office measures counter-clockwise from 3 o'clock, y up.
    const at = (deg: number): [number, number] => [cx + rx * Math.cos((deg * Math.PI) / 180), cy - ry * Math.sin((deg * Math.PI) / 180)];
    const [sx0, sy0] = at(startDeg);
    if (move || !cur) moveTo(sx0, sy0);
    else lineTo(sx0, sy0);
    const sweep = endDeg - startDeg;
    if (Math.abs(sweep) >= 360 - 1e-9) {
      const [hx, hy] = at(startDeg + 180);
      d += `A${f(rx)} ${f(ry)} 0 1 ${sweep > 0 ? 0 : 1} ${f(hx)} ${f(hy)} A${f(rx)} ${f(ry)} 0 1 ${sweep > 0 ? 0 : 1} ${f(sx0)} ${f(sy0)} `;
      cur = [sx0, sy0];
      return;
    }
    const [ex, ey] = at(endDeg);
    d += `A${f(rx)} ${f(ry)} 0 ${Math.abs(sweep) > 180 ? 1 : 0} ${sweep > 0 ? 0 : 1} ${f(ex)} ${f(ey)} `;
    cur = [ex, ey];
  }

  function arc(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number, clockwise: boolean, move: boolean): void {
    const l = Math.min(x1, x2), r = Math.max(x1, x2), t = Math.min(y1, y2), b = Math.max(y1, y2);
    const rx = (r - l) / 2, ry = (b - t) / 2;
    if (rx <= 0 || ry <= 0) return;
    const cx = (l + r) / 2, cy = (t + b) / 2;
    const angle = (x: number, y: number): number => Math.atan2((y - cy) / ry, (x - cx) / rx);
    const a0 = angle(x3, y3), a1 = angle(x4, y4);
    const sx0 = cx + rx * Math.cos(a0), sy0 = cy + ry * Math.sin(a0);
    const ex = cx + rx * Math.cos(a1), ey = cy + ry * Math.sin(a1);
    if (move || !cur) moveTo(sx0, sy0);
    else lineTo(sx0, sy0);
    // Screen angles grow clockwise (y down).
    let span = clockwise ? a1 - a0 : a0 - a1;
    while (span <= 0) span += 2 * Math.PI;
    if (Math.abs(span - 2 * Math.PI) < 1e-6 || (Math.abs(sx0 - ex) < 0.5 && Math.abs(sy0 - ey) < 0.5)) {
      const hx = cx + rx * Math.cos(a0 + Math.PI), hy = cy + ry * Math.sin(a0 + Math.PI);
      const s = clockwise ? 1 : 0;
      d += `A${f(rx)} ${f(ry)} 0 1 ${s} ${f(hx)} ${f(hy)} A${f(rx)} ${f(ry)} 0 1 ${s} ${f(ex)} ${f(ey)} `;
    } else {
      d += `A${f(rx)} ${f(ry)} 0 ${span > Math.PI ? 1 : 0} ${clockwise ? 1 : 0} ${f(ex)} ${f(ey)} `;
    }
    cur = [ex, ey];
  }

  const rect = src.textRects[0];
  const textRect = rect
    ? { l: X(rect[0]), t: Y(rect[1]), r: X(rect[2]), b: Y(rect[3]) }
    : { l: 0, t: 0, r: w, b: h };
  return { paths, textRect };
}
