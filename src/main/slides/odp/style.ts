import type { Effects, Fill, GradientStop, ImageEffect, ImageRef, Line, LineEnd } from "@shared/types/slide-model";
import { imagePixelSize } from "../native-deck";
import { css, type Rgba } from "../pptx/color";
import { imageNaturalSize } from "../pptx/image-size";
import { NO_EFFECTS } from "../pptx/style";
import { attr, children } from "../pptx/xml";
import { readZipEntries } from "../zip-reader";
import { degrees } from "./geometry";
import type { OdpPackage, Props } from "./package";

/** Constructs met and not drawn exactly, counted per slide. */
export type Misses = Map<string, number>;

export function miss(misses: Misses, what: string): void {
  misses.set(what, (misses.get(what) ?? 0) + 1);
}

const EMU: Record<string, number> = { cm: 360000, mm: 36000, in: 914400, inch: 914400, pt: 12700, pc: 152400, px: 9525 };

/** An ODF length (`1.5cm`, `12pt`, `0.3in`) in EMU; a bare number is in
 *  LibreOffice's 1/100 mm. `null` for a percentage or anything unreadable. */
export function length(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(value);
  if (!m) return null;
  const v = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit === "") return v * 360;
  const k = EMU[unit];
  return k === undefined ? null : v * k;
}

export function lengthOr(value: string | null | undefined, fallback: number): number {
  return length(value) ?? fallback;
}

/** `50%` → 0.5; `null` when not a percentage. */
export function percent(value: string | null | undefined): number | null {
  if (!value || !value.trim().endsWith("%")) return null;
  const v = parseFloat(value);
  return Number.isFinite(v) ? v / 100 : null;
}

export function rgba(hex: string | null | undefined, alpha = 1): Rgba | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1]!, 16);
  return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255, a: alpha };
}

export function color(hex: string | null | undefined, alpha = 1): string | null {
  const c = rgba(hex, alpha);
  return c ? css(c) : null;
}

/** What a fill or line needs besides its properties. */
export type PaintContext = { pkg: OdpPackage; misses: Misses };

/**
 * A fill from graphic (or drawing-page) properties. `fallback` is what an
 * element with no `draw:fill` anywhere in its styles gets — LibreOffice's
 * pool default (solid) for a drawn shape, none for a frame.
 */
export function readFill(props: Props, ctx: PaintContext, fallback: "solid" | "none", box: { w: number; h: number }): Fill | null {
  const kind = props["draw:fill"] ?? fallback;
  const opacity = opacityOf(props, ctx);
  switch (kind) {
    case "none":
      return null;
    case "solid": {
      const base = props["draw:fill-color"] ?? "#729fcf";
      if (opacity.gradient) {
        const c = color(base) ?? "rgb(114,159,207)";
        return withOpacity({ kind: "linear", angle: opacity.angle, scaled: false, stops: [{ pos: 0, color: c }, { pos: 1, color: c }] }, opacity);
      }
      const c = color(base, opacity.flat);
      return c ? { kind: "solid", color: c } : null;
    }
    case "gradient": {
      const fill = gradient(ctx.pkg.sheet.definition("draw:gradient", props["draw:fill-gradient-name"]));
      if (!fill) return color(props["draw:fill-color"], opacity.flat) ? { kind: "solid", color: color(props["draw:fill-color"], opacity.flat)! } : null;
      return withOpacity(fill, opacity);
    }
    case "hatch":
      return hatch(props, ctx, opacity.flat);
    case "bitmap":
      return bitmap(props, ctx, opacity.flat, box);
    default:
      return null;
  }
}

type Opacity = { flat: number; angle: number; gradient: { stops: { pos: number; alpha: number }[] } | null };

/** `draw:opacity` (a flat 0..100%) or `draw:opacity-name` (a transparency
 *  gradient, which LibreOffice also draws over any fill). */
function opacityOf(props: Props, ctx: PaintContext): Opacity {
  const def = ctx.pkg.sheet.definition("draw:opacity", props["draw:opacity-name"]);
  if (def) {
    const start = percent(attr(def, "draw:start")) ?? 1;
    const end = percent(attr(def, "draw:end")) ?? 1;
    const style = attr(def, "draw:style") ?? "linear";
    if (style !== "linear" && style !== "axial") miss(ctx.misses, "fill:transparency-gradient");
    const border = percent(attr(def, "draw:border")) ?? 0;
    const stops = style === "axial"
      ? [{ pos: 0, alpha: end }, { pos: (1 - border) / 2, alpha: start }, { pos: 1 - (1 - border) / 2, alpha: start }, { pos: 1, alpha: end }]
      : [{ pos: 0, alpha: start }, { pos: border, alpha: start }, { pos: 1, alpha: end }];
    const raw = attr(def, "draw:angle") ?? "0";
    const angle = /[a-z]/i.test(raw) ? degrees(raw) : (Number(raw) || 0) / 10;
    const mean = (start + end) / 2;
    const flat = style === "linear" || style === "axial" ? stops : [{ pos: 0, alpha: mean }, { pos: 1, alpha: mean }];
    return { flat: 1, angle: (((90 - angle) % 360) + 360) % 360, gradient: { stops: flat } };
  }
  const flat = percent(props["draw:opacity"]);
  return { flat: flat === null ? 1 : Math.max(0, Math.min(1, flat)), angle: 0, gradient: null };
}

function withOpacity(fill: Fill, opacity: Opacity): Fill {
  if (fill.kind !== "linear" && fill.kind !== "path") return fill;
  const alphaAt = (pos: number): number => {
    const s = opacity.gradient?.stops;
    if (!s) return opacity.flat;
    for (let k = 1; k < s.length; k++) {
      const a = s[k - 1]!;
      const b = s[k]!;
      if (pos <= b.pos) return b.pos === a.pos ? b.alpha : a.alpha + ((b.alpha - a.alpha) * (pos - a.pos)) / (b.pos - a.pos);
    }
    return s[s.length - 1]!.alpha;
  };
  // Every position either gradient changes at.
  const positions = [...new Set([...fill.stops.map((s) => s.pos), ...(opacity.gradient?.stops.map((s) => s.pos) ?? [])])].sort((a, b) => a - b);
  const colorAt = (pos: number): Rgba => {
    const s = fill.stops.map((st) => ({ pos: st.pos, c: parseCss(st.color) }));
    let lo = s[0]!;
    let hi = s[s.length - 1]!;
    for (const st of s) {
      if (st.pos <= pos) lo = st;
      if (st.pos >= pos) {
        hi = st;
        break;
      }
    }
    const t = hi.pos === lo.pos ? 0 : (pos - lo.pos) / (hi.pos - lo.pos);
    return { r: lo.c.r + (hi.c.r - lo.c.r) * t, g: lo.c.g + (hi.c.g - lo.c.g) * t, b: lo.c.b + (hi.c.b - lo.c.b) * t, a: 1 };
  };
  const stops: GradientStop[] = positions.map((pos) => ({ pos, color: css({ ...colorAt(pos), a: alphaAt(pos) }) }));
  return { ...fill, stops };
}

/** `rgb(…)`/`rgba(…)` (what `css` writes) back to channels. */
function parseCss(c: string): Rgba {
  const m = c.match(/[\d.]+/g)?.map(Number) ?? [];
  return { r: (m[0] ?? 0) / 255, g: (m[1] ?? 0) / 255, b: (m[2] ?? 0) / 255, a: m[3] ?? 1 };
}

/**
 * `draw:gradient` as the model's gradients, the way LibreOffice exports one to
 * OOXML (`oox/source/export/drawingml.cxx`): a linear angle turned from
 * "counter-clockwise from the start colour on top" into "the direction the
 * colours run", axial stops mirrored about the middle, and every concentric
 * style's stops reversed — ODF puts its start colour on the OUTSIDE.
 */
export function gradient(def: XmlElementLike | null): Fill | null {
  if (!def) return null;
  const style = attr(def, "draw:style") ?? "linear";
  const intensity = (name: string): number => percent(attr(def, name)) ?? 1;
  const scale = (c: Rgba, k: number): Rgba => ({ r: c.r * k, g: c.g * k, b: c.b * k, a: c.a });
  const start = scale(rgba(attr(def, "draw:start-color")) ?? { r: 0, g: 0, b: 0, a: 1 }, intensity("draw:start-intensity"));
  const end = scale(rgba(attr(def, "draw:end-color")) ?? { r: 1, g: 1, b: 1, a: 1 }, intensity("draw:end-intensity"));
  let stops: { pos: number; c: Rgba }[] = children(def, "loext:gradient-stop")
    .map((s) => ({ pos: Number(attr(s, "svg:offset") ?? 0), c: rgba(attr(s, "loext:color-value")) }))
    .filter((s): s is { pos: number; c: Rgba } => s.c !== null && Number.isFinite(s.pos))
    .sort((a, b) => a.pos - b.pos);
  if (stops.length < 2) stops = [{ pos: 0, c: start }, { pos: 1, c: end }];
  const border = Math.max(0, Math.min(1, percent(attr(def, "draw:border")) ?? 0));
  if (border > 0) stops = [{ pos: 0, c: stops[0]!.c }, ...stops.map((s) => ({ pos: border + s.pos * (1 - border), c: s.c }))];
  // Older files write the angle in tenths of a degree with no unit.
  const rawAngle = attr(def, "draw:angle") ?? "0";
  const angle = /[a-z]/i.test(rawAngle) ? degrees(rawAngle) : (Number(rawAngle) || 0) / 10;
  const out = (list: { pos: number; c: Rgba }[]): GradientStop[] => list.map((s) => ({ pos: Math.max(0, Math.min(1, s.pos)), color: css(s.c) }));
  if (style === "linear" || style === "axial") {
    if (style === "axial") stops = [...stops.map((s) => ({ pos: 0.5 - s.pos / 2, c: s.c })).reverse(), ...stops.map((s) => ({ pos: 0.5 + s.pos / 2, c: s.c }))];
    return { kind: "linear", angle: (((90 - angle) % 360) + 360) % 360, scaled: false, stops: out(stops) };
  }
  const cx = percent(attr(def, "draw:cx")) ?? 0.5;
  const cy = percent(attr(def, "draw:cy")) ?? 0.5;
  const reversed = stops.map((s) => ({ pos: 1 - s.pos, c: s.c })).reverse();
  return {
    kind: "path",
    shape: style === "radial" || style === "ellipsoid" ? "circle" : "rect",
    focus: { l: cx, t: cy, r: 1 - cx, b: 1 - cy },
    stops: out(reversed),
  };
}

type XmlElementLike = Parameters<typeof attr>[0];

/** A hatch as the nearest of the 8 × 8 preset patterns. */
function hatch(props: Props, ctx: PaintContext, alpha: number): Fill | null {
  const def = ctx.pkg.sheet.definition("draw:hatch", props["draw:fill-hatch-name"]);
  miss(ctx.misses, "fill:hatch");
  const fg = color(attr(def, "draw:color") ?? "#000000", alpha) ?? "rgb(0,0,0)";
  const bg = props["draw:fill-hatch-solid"] === "true" ? (color(props["draw:fill-color"] ?? "#ffffff", alpha) ?? "rgb(255,255,255)") : "rgba(0,0,0,0)";
  const raw = attr(def, "draw:rotation") ?? "0";
  const rotation = ((/[a-z]/i.test(raw) ? degrees(raw) : (Number(raw) || 0) / 10) % 180 + 180) % 180;
  const dist = (lengthOr(attr(def, "draw:distance"), 36000) / 12700) || 4;
  const style = attr(def, "draw:style") ?? "single";
  const near = (a: number): boolean => Math.abs(rotation - a) < 22.5 || Math.abs(rotation - a - 180) < 22.5;
  let preset: string;
  if (style !== "single") preset = near(45) || near(135) ? "diagCross" : dist <= 4 ? "smGrid" : "cross";
  else if (near(0)) preset = dist <= 2.5 ? "narHorz" : dist <= 5 ? "ltHorz" : "horz";
  else if (near(90)) preset = dist <= 2.5 ? "narVert" : dist <= 5 ? "ltVert" : "vert";
  else if (near(45)) preset = dist <= 5 ? "ltUpDiag" : "upDiag";
  else preset = dist <= 5 ? "ltDnDiag" : "dnDiag";
  return { kind: "pattern", preset, fg, bg };
}

/** A picture fill: stretched, tiled at its own size (or the one the style
 *  gives), or once at its anchor. */
function bitmap(props: Props, ctx: PaintContext, alpha: number, box: { w: number; h: number }): Fill | null {
  const def = ctx.pkg.sheet.definition("draw:fill-image", props["draw:fill-image-name"]);
  const part = def ? partOf(attr(def, "xlink:href"), ctx) : null;
  if (!part) {
    miss(ctx.misses, def ? "image:linked" : "fill:bitmap-missing");
    return null;
  }
  const image: ImageRef = { part, crop: null, fill: null, alpha, effects: [] };
  imageFormatMiss(part, ctx);
  const repeat = props["style:repeat"] ?? "stretch";
  if (repeat === "stretch") return { kind: "image", image, mode: "stretch" };
  const natural = naturalSize(ctx.pkg.file, part);
  if (!natural) {
    miss(ctx.misses, "fill:tile-size");
    return { kind: "image", image, mode: "stretch" };
  }
  const size = (value: string | undefined, nat: number): number => {
    const p = percent(value);
    if (p !== null) return nat * p;
    const l = length(value);
    return l && l > 0 ? l : nat;
  };
  const tw = size(props["draw:fill-image-width"], natural.w);
  const th = size(props["draw:fill-image-height"], natural.h);
  const align = ALIGN[props["draw:fill-image-ref-point"] ?? "center"] ?? "ctr";
  if (repeat === "no-repeat" && box.w > 0 && box.h > 0) {
    // Once, at its anchor: a stretched picture whose fill rectangle is that spot.
    const { w, h } = box;
    const x = align.endsWith("r") ? w - tw : align === "ctr" || align === "t" || align === "b" ? (w - tw) / 2 : 0;
    const y = align.startsWith("b") ? h - th : align === "ctr" || align === "l" || align === "r" ? (h - th) / 2 : 0;
    return { kind: "image", image: { ...image, fill: { l: x / w, t: y / h, r: (w - x - tw) / w, b: (h - y - th) / h } }, mode: "stretch" };
  }
  if (props["draw:tile-repeat-offset"] && parseFloat(props["draw:tile-repeat-offset"]) !== 0) miss(ctx.misses, "fill:tile-offset");
  return { kind: "image", image, mode: "tile", tile: { size: { w: tw, h: th }, sx: 1, sy: 1, tx: 0, ty: 0, align, flip: "none" } };
}

const ALIGN: Record<string, string> = {
  "top-left": "tl", top: "t", "top-right": "tr", left: "l", center: "ctr", right: "r", "bottom-left": "bl", bottom: "b", "bottom-right": "br",
};

/** A picture's natural size in EMU, as LibreOffice sizes it: its pixels at
 *  its own DPI, 96 when it states none. */
export function naturalSize(file: string, part: string): { w: number; h: number } | null {
  const bytes = readZipEntries(file, (n) => n === part)[part];
  if (!bytes) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // GIF and BMP state their pixels in the header, and no DPI LibreOffice uses.
  if (buf.length >= 10 && buf.toString("latin1", 0, 3) === "GIF") return { w: buf.readUInt16LE(6) * 9525, h: buf.readUInt16LE(8) * 9525 };
  if (buf.length >= 26 && buf.toString("latin1", 0, 2) === "BM") return { w: Math.abs(buf.readInt32LE(18)) * 9525, h: Math.abs(buf.readInt32LE(22)) * 9525 };
  const natural = imageNaturalSize(bytes);
  if (!natural) return null;
  const px = imagePixelSize(buf, buf[0] === 0x89 ? "png" : "jpeg");
  // `imageNaturalSize` assumes 72 dpi (PowerPoint's choice) when the file states none.
  if (px && Math.abs(natural.w - (px.width * 914400) / 72) < 1) return { w: px.width * 9525, h: px.height * 9525 };
  return natural;
}

/** A package entry from an `xlink:href`; `null` for a link outside it. */
export function partOf(href: string | null | undefined, ctx: { pkg: OdpPackage }): string | null {
  if (!href) return null;
  let name = href.trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep it as written
  }
  name = name.replace(/^\.\//, "").replace(/^\/+/, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(name) || name.startsWith("../")) return null;
  return ctx.pkg.parts.has(name) ? name : null;
}

/** Picture formats Chromium can't decode, counted (EMF/WMF and SVG are served
 *  as SVG). */
const UNDRAWABLE = new Set(["tif", "tiff", "wdp", "jxr", "pict", "pct", "svm", "eps", "pcx", "tga", "ras", "pbm", "pgm", "ppm", "xbm", "xpm"]);

export function imageFormatMiss(part: string, ctx: { misses: Misses }): void {
  const ext = part.slice(part.lastIndexOf(".") + 1).toLowerCase();
  if (UNDRAWABLE.has(ext)) miss(ctx.misses, `image:${ext}`);
}

const DRAWABLE = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "emf", "wmf", "emz", "wmz", "ico"]);

export function drawableFormat(part: string): boolean {
  return DRAWABLE.has(part.slice(part.lastIndexOf(".") + 1).toLowerCase());
}

/** A picture's colour mode and adjustments, as the model's image effects. */
export function imageEffects(props: Props, ctx: { misses: Misses }): ImageEffect[] {
  const effects: ImageEffect[] = [];
  const mode = props["draw:color-mode"];
  if (mode === "greyscale") effects.push({ kind: "grayscale" });
  else if (mode === "mono") effects.push({ kind: "biLevel", threshold: 0.5 });
  else if (mode === "watermark") effects.push({ kind: "lum", bright: 0.7, contrast: -0.7 });
  const lum = percent(props["draw:luminance"]) ?? 0;
  const contrast = percent(props["draw:contrast"]) ?? 0;
  if (lum !== 0 || contrast !== 0) effects.push({ kind: "lum", bright: lum, contrast });
  const off = (k: string): boolean => (percent(props[k]) ?? 0) !== 0;
  if (off("draw:red") || off("draw:green") || off("draw:blue") || (percent(props["draw:gamma"]) ?? 1) !== 1) miss(ctx.misses, "image:color-adjust");
  return effects;
}

/** The hairline LibreOffice draws a 0-width line as: one pixel at 96 dpi. */
export const HAIRLINE = 9525;

/**
 * A line from graphic properties. `fallback` as for fills: a drawn shape is
 * outlined unless its styles say otherwise, a frame is not.
 */
export function readLine(props: Props, ctx: PaintContext, fallback: "solid" | "none"): Line | null {
  const kind = props["draw:stroke"] ?? fallback;
  if (kind === "none") return null;
  const alpha = percent(props["svg:stroke-opacity"]) ?? 1;
  const c = color(props["svg:stroke-color"] ?? "#000000", alpha) ?? "rgb(0,0,0)";
  const width = Math.max(HAIRLINE, lengthOr(props["svg:stroke-width"], 0));
  let dash: number[] | null = null;
  let cap: Line["cap"] = props["svg:stroke-linecap"] === "round" ? "round" : props["svg:stroke-linecap"] === "square" ? "square" : "flat";
  if (kind === "dash") {
    const def = ctx.pkg.sheet.definition("draw:stroke-dash", props["draw:stroke-dash"]);
    // A length is absolute; a percentage is of the line's width.
    const rel = (v: string | null, fallbackWidths: number): number => {
      const p = percent(v);
      if (p !== null) return p;
      const l = length(v);
      return l === null ? fallbackWidths : l / width;
    };
    const dots = (count: string | null, len: string | null): number[] => {
      const k = Math.max(0, Math.min(64, Number(count ?? 0) || 0));
      // A dot of length 0 is as long as the line is wide.
      const d = rel(len, 1) || 1;
      return Array.from({ length: k }, () => d);
    };
    const gap = rel(attr(def, "draw:distance"), 1) || 1;
    const marks = [...dots(attr(def, "draw:dots1"), attr(def, "draw:dots1-length")), ...dots(attr(def, "draw:dots2"), attr(def, "draw:dots2-length"))];
    dash = marks.length > 0 ? marks.flatMap((m) => [m, gap]) : [4, 3];
    if (attr(def, "draw:style") === "round") cap = "round";
  }
  const join = props["draw:stroke-linejoin"];
  return {
    fill: { kind: "solid", color: c },
    width,
    dash,
    cap,
    join: join === "round" ? "round" : join === "bevel" ? "bevel" : join === "miter" ? "miter" : "round",
    head: marker(props["draw:marker-start"], props["draw:marker-start-width"], width, ctx),
    tail: marker(props["draw:marker-end"], props["draw:marker-end-width"], width, ctx),
    compound: "sng",
  };
}

/** A line end as the nearest of OOXML's five, by its name and its size
 *  against the line's width (OOXML's `sm`/`med`/`lg` are 2, 3 and 5 widths). */
function marker(name: string | undefined, widthAttr: string | undefined, lineWidth: number, ctx: PaintContext): LineEnd | null {
  if (!name) return null;
  const def = ctx.pkg.sheet.definition("draw:marker", name);
  const label = `${name} ${attr(def, "draw:display-name") ?? ""}`.toLowerCase().replace(/_20_/g, " ");
  const type: LineEnd["type"] = /stealth|concave/.test(label)
    ? "stealth"
    : /diamond|square 45/.test(label)
      ? "diamond"
      : /oval|circle/.test(label)
        ? "oval"
        : /open|line arrow|line short|unfilled|arrowheads/.test(label)
          ? "arrow"
          : "triangle";
  if (!/arrow|triangle|stealth|diamond|square|oval|circle/.test(label)) miss(ctx.misses, "line:marker");
  const ratio = lengthOr(widthAttr, 0.2 * 360000) / lineWidth;
  const vb = (attr(def, "svg:viewBox") ?? "0 0 20 30").split(/\s+/).map(Number);
  const aspect = vb[2] && vb[3] ? vb[3] / vb[2] : 1;
  const size = (r: number): LineEnd["w"] => (r < 2.5 ? "sm" : r < 4 ? "med" : "lg");
  return { type, w: size(ratio), len: size(ratio * aspect) };
}

/** Shadow, glow and soft edge from graphic properties. */
export function readEffects(props: Props): Effects {
  const out: Effects = { ...NO_EFFECTS };
  if (props["draw:shadow"] === "visible") {
    const dx = lengthOr(props["draw:shadow-offset-x"], 0.2 * 360000);
    const dy = lengthOr(props["draw:shadow-offset-y"], 0.2 * 360000);
    const alpha = percent(props["draw:shadow-opacity"]) ?? (percent(props["draw:shadow-transparency"]) !== null ? 1 - percent(props["draw:shadow-transparency"])! : 1);
    const c = color(props["draw:shadow-color"] ?? "#808080", alpha);
    if (c) {
      out.shadow = {
        color: c,
        blur: lengthOr(props["loext:shadow-blur"], 0),
        dist: Math.hypot(dx, dy),
        dir: ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360,
        inner: false,
        sx: 1,
        sy: 1,
      };
    }
  }
  const glow = lengthOr(props["loext:glow-radius"], 0);
  if (glow > 0) {
    const c = color(props["loext:glow-color"] ?? "#000000", 1 - (percent(props["loext:glow-transparency"]) ?? 0));
    if (c) out.glow = { color: c, radius: glow };
  }
  const soft = lengthOr(props["loext:softedge-radius"], 0);
  if (soft > 0) out.softEdge = soft;
  return out;
}
