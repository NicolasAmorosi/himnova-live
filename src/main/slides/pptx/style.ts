import type { Effects, Fill, GradientStop, ImageEffect, ImageRef, Insets, Line, LineEnd } from "@shared/types/slide-model";
import { readZipEntries } from "../zip-reader";
import { colorIn, css, resolveColor, type ColorContext, type Rgba } from "./color";
import { imageNaturalSize } from "./image-size";
import type { PptxPackage } from "./package";
import { attr, boolAttr, child, children, descendants, numAttr, type XmlElement } from "./xml";

/**
 * Everything a part's drawing properties are resolved against: the colours in
 * scope, the theme's style matrix (what a `p:style` reference points at), and
 * the part whose relationships name its pictures.
 */
export type StyleContext = {
  pkg: PptxPackage;
  colors: ColorContext;
  /** The relationships of the part whose XML is being read. */
  part: string;
  theme: ThemeStyles;
  /** Constructs met and not drawn, counted per slide (the compatibility check). */
  unsupported: Map<string, number>;
  /** `a:grpFill`: the fill of the group a shape is in. */
  groupFill?: Fill | null;
};

export type ThemeStyles = {
  fills: XmlElement[];
  bgFills: XmlElement[];
  lines: XmlElement[];
  effects: XmlElement[];
  part: string;
};

export function miss(ctx: { unsupported: Map<string, number> }, what: string): void {
  ctx.unsupported.set(what, (ctx.unsupported.get(what) ?? 0) + 1);
}

const FILLS = new Set(["a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill"]);

/** The fill among `el`'s children. `undefined` when it names none (inherit),
 *  `null` for an explicit `a:noFill`. */
export function fillIn(el: XmlElement | null | undefined, ctx: StyleContext): Fill | null | undefined {
  if (!el) return undefined;
  for (const c of el.children) if (FILLS.has(c.name)) return readFill(c, ctx);
  return undefined;
}

export function readFill(el: XmlElement, ctx: StyleContext): Fill | null {
  switch (el.name) {
    case "a:noFill":
      return null;
    case "a:solidFill": {
      const c = colorIn(el, ctx.colors);
      return c ? { kind: "solid", color: css(c) } : null;
    }
    case "a:gradFill":
      return readGradient(el, ctx);
    case "a:blipFill": {
      const image = readImage(el, ctx);
      if (!image) return null;
      const tile = child(el, "a:tile");
      if (tile) {
        const size = tileImageSize(ctx.pkg, image.part);
        if (!size) {
          miss(ctx, "fill:tile-size");
          return { kind: "image", image, mode: "stretch" };
        }
        return {
          kind: "image",
          image,
          mode: "tile",
          tile: {
            size,
            sx: numAttr(tile, "sx", 100000) / 100000,
            sy: numAttr(tile, "sy", 100000) / 100000,
            tx: numAttr(tile, "tx", 0),
            ty: numAttr(tile, "ty", 0),
            align: attr(tile, "algn") ?? "tl",
            flip: attr(tile, "flip") ?? "none",
          },
        };
      }
      return { kind: "image", image, mode: "stretch" };
    }
    case "a:pattFill": {
      const fg = colorIn(child(el, "a:fgClr"), ctx.colors) ?? { r: 0, g: 0, b: 0, a: 1 };
      const bg = colorIn(child(el, "a:bgClr"), ctx.colors) ?? { r: 1, g: 1, b: 1, a: 1 };
      return { kind: "pattern", preset: attr(el, "prst") ?? "pct5", fg: css(fg), bg: css(bg) };
    }
    case "a:grpFill":
      return ctx.groupFill ?? null;
    default:
      return null;
  }
}

/** A tiled picture's natural size, read once per deck: a template's tiled background is on every slide, and reading
 *  the zip and the whole picture again for each cost 6 s on 300 slides of a 4 MB picture (2026-11-15 audit, R19). */
const tileSizes = new WeakMap<PptxPackage, Map<string, { w: number; h: number } | null>>();
function tileImageSize(pkg: PptxPackage, part: string): { w: number; h: number } | null {
  let sizes = tileSizes.get(pkg);
  if (!sizes) tileSizes.set(pkg, (sizes = new Map<string, { w: number; h: number } | null>()));
  if (!sizes.has(part)) {
    const bytes = readZipEntries(pkg.file, (n) => n === part)[part];
    sizes.set(part, bytes ? imageNaturalSize(bytes) : null);
  }
  return sizes.get(part) ?? null;
}

function readGradient(el: XmlElement, ctx: StyleContext): Fill | null {
  const stops: GradientStop[] = children(child(el, "a:gsLst"), "a:gs")
    .map((gs) => {
      const c = colorIn(gs, ctx.colors);
      return c ? { pos: numAttr(gs, "pos", 0) / 100000, color: css(c) } : null;
    })
    .filter((s): s is GradientStop => s !== null)
    .sort((a, b) => a.pos - b.pos);
  if (stops.length === 0) return null;
  const pathEl = child(el, "a:path");
  if (pathEl) {
    const r = child(pathEl, "a:fillToRect");
    const shape = attr(pathEl, "path");
    return {
      kind: "path",
      shape: shape === "rect" || shape === "shape" ? shape : "circle",
      focus: insets(r),
      stops,
    };
  }
  const lin = child(el, "a:lin");
  return { kind: "linear", angle: numAttr(lin, "ang", 0) / 60000, scaled: boolAttr(lin, "scaled", false), stops };
}

function insets(el: XmlElement | null): Insets {
  return {
    l: numAttr(el, "l", 0) / 100000,
    t: numAttr(el, "t", 0) / 100000,
    r: numAttr(el, "r", 0) / 100000,
    b: numAttr(el, "b", 0) / 100000,
  };
}

/** A `blipFill`'s picture: its part, crop, stretch rectangle and colour effects. */
export function readImage(blipFill: XmlElement, ctx: StyleContext): ImageRef | null {
  const blip = child(blipFill, "a:blip");
  if (!blip) return null;
  const embed = attr(blip, "r:embed");
  const link = attr(blip, "r:link");
  const rel = embed ? ctx.pkg.rels(ctx.part).get(embed) : link ? ctx.pkg.rels(ctx.part).get(link) : undefined;
  if (!rel || rel.external) {
    if (link || rel?.external) miss(ctx, "image:linked");
    return null;
  }
  let alpha = 1;
  const effects: ImageEffect[] = [];
  for (const e of blip.children) {
    switch (e.name) {
      case "a:alphaModFix":
        alpha *= numAttr(e, "amt", 100000) / 100000;
        break;
      case "a:grayscl":
        effects.push({ kind: "grayscale" });
        break;
      case "a:duotone": {
        const colors = e.children.map((c) => resolveColor(c, ctx.colors)).filter((c): c is Rgba => c !== null);
        if (colors.length === 2) effects.push({ kind: "duotone", dark: css(colors[0]!), light: css(colors[1]!) });
        break;
      }
      case "a:lum":
        effects.push({ kind: "lum", bright: numAttr(e, "bright", 0) / 100000, contrast: numAttr(e, "contrast", 0) / 100000 });
        break;
      case "a:biLevel":
        effects.push({ kind: "biLevel", threshold: numAttr(e, "thresh", 50000) / 100000 });
        break;
      case "a:clrChange": {
        const from = colorIn(child(e, "a:clrFrom"), ctx.colors);
        const to = colorIn(child(e, "a:clrTo"), ctx.colors);
        if (from && to) effects.push({ kind: "clrChange", from: css(from), to: css(to) });
        break;
      }
      case "a:extLst":
        // Office 2010+ picture corrections and artistic effects; the bitmap
        // in the package is the one WITHOUT them.
        if (descendants(e, "a14:imgEffect").length > 0) miss(ctx, "image:artistic-effect");
        break;
      default:
        miss(ctx, `image:${e.name}`);
    }
  }
  const ext = rel.target.slice(rel.target.lastIndexOf(".") + 1).toLowerCase();
  if (UNDRAWABLE.has(ext)) miss(ctx, `image:${ext}`);
  const src = child(blipFill, "a:srcRect");
  const stretch = child(child(blipFill, "a:stretch"), "a:fillRect");
  return {
    part: rel.target,
    crop: src ? insets(src) : null,
    fill: stretch ? insets(stretch) : null,
    alpha,
    effects,
  };
}

/** Picture formats Chromium can't decode: counted, so a slide that shows one
 *  is never drawn wrong in silence. (EMF/WMF and their gzipped .emz/.wmz are
 *  served as SVG: see `metafile.ts`.) */
const UNDRAWABLE = new Set(["tif", "tiff", "wdp", "jxr", "pict", "pct"]);

const DASHES: Record<string, number[]> = {
  dash: [4, 3],
  dashDot: [4, 3, 1, 3],
  dot: [1, 3],
  lgDash: [8, 3],
  lgDashDot: [8, 3, 1, 3],
  lgDashDotDot: [8, 3, 1, 3, 1, 3],
  sysDash: [3, 1],
  sysDashDot: [3, 1, 1, 1],
  sysDashDotDot: [3, 1, 1, 1, 1, 1],
  sysDot: [1, 1],
};

/**
 * `a:ln` over the inherited line (a style reference's, a placeholder's): each
 * attribute and child that is present wins, the rest is kept. `undefined`
 * input means "nothing said here".
 */
export function readLine(el: XmlElement | null | undefined, ctx: StyleContext, base: Line | null): Line | null {
  if (!el) return base;
  const fill = fillIn(el, ctx);
  const resolvedFill = fill === undefined ? (base?.fill ?? null) : fill;
  const prstDash = attr(child(el, "a:prstDash"), "val");
  const custDash = child(el, "a:custDash");
  const dash =
    prstDash !== null
      ? prstDash === "solid"
        ? null
        : (DASHES[prstDash] ?? null)
      : custDash
        ? children(custDash, "a:ds").flatMap((ds) => [numAttr(ds, "d", 100000) / 100000, numAttr(ds, "sp", 100000) / 100000])
        : (base?.dash ?? null);
  const cap = attr(el, "cap");
  const join = child(el, "a:round") ? "round" : child(el, "a:bevel") ? "bevel" : child(el, "a:miter") ? "miter" : (base?.join ?? "round");
  const cmpd = attr(el, "cmpd");
  return {
    fill: resolvedFill,
    width: numAttr(el, "w", base?.width ?? 9525),
    dash,
    cap: cap === "rnd" ? "round" : cap === "sq" ? "square" : cap === "flat" ? "flat" : (base?.cap ?? "flat"),
    join,
    head: lineEnd(child(el, "a:headEnd"), base?.head ?? null),
    tail: lineEnd(child(el, "a:tailEnd"), base?.tail ?? null),
    compound: cmpd === "dbl" || cmpd === "thickThin" || cmpd === "thinThick" || cmpd === "tri" ? cmpd : (base?.compound ?? "sng"),
  };
}

function lineEnd(el: XmlElement | null, base: LineEnd | null): LineEnd | null {
  if (!el) return base;
  const type = attr(el, "type") ?? "none";
  if (type === "none") return null;
  const size = (v: string | null): "sm" | "med" | "lg" => (v === "sm" || v === "lg" ? v : "med");
  return {
    type: type === "stealth" || type === "diamond" || type === "oval" || type === "arrow" ? type : "triangle",
    w: size(attr(el, "w")),
    len: size(attr(el, "len")),
  };
}

export const NO_EFFECTS: Effects = { shadow: null, glow: null, softEdge: null, reflection: null, overlay: null };

/** `a:effectLst` — or the base when the element names none. An empty
 *  `<a:effectLst/>` clears an inherited one. */
export function readEffects(el: XmlElement | null | undefined, ctx: StyleContext, base: Effects): Effects {
  const list = child(el, "a:effectLst");
  if (!list) {
    if (child(el, "a:effectDag")) miss(ctx, "effect:dag");
    return base;
  }
  const out: Effects = { ...NO_EFFECTS };
  for (const e of list.children) {
    switch (e.name) {
      case "a:outerShdw":
      case "a:innerShdw":
      case "a:prstShdw": {
        const color = colorIn(e, ctx.colors);
        if (!color) break;
        if (e.name === "a:prstShdw") miss(ctx, "effect:preset-shadow");
        out.shadow = {
          color: css(color),
          blur: numAttr(e, "blurRad", 0),
          dist: numAttr(e, "dist", 0),
          dir: numAttr(e, "dir", 0) / 60000,
          inner: e.name === "a:innerShdw",
          sx: numAttr(e, "sx", 100000) / 100000,
          sy: numAttr(e, "sy", 100000) / 100000,
        };
        break;
      }
      case "a:glow": {
        const color = colorIn(e, ctx.colors);
        if (color) out.glow = { color: css(color), radius: numAttr(e, "rad", 0) };
        break;
      }
      case "a:softEdge":
        out.softEdge = numAttr(e, "rad", 0);
        break;
      case "a:reflection":
        out.reflection = {
          blur: numAttr(e, "blurRad", 0),
          startAlpha: numAttr(e, "stA", 100000) / 100000,
          endAlpha: numAttr(e, "endA", 0) / 100000,
          endPos: numAttr(e, "endPos", 100000) / 100000,
          dist: numAttr(e, "dist", 0),
        };
        break;
      case "a:fillOverlay": {
        const fill = e.children[0] ? readFill(e.children[0], ctx) : null;
        const blend = attr(e, "blend");
        if (fill) out.overlay = { fill, blend: blend === "mult" || blend === "screen" || blend === "darken" || blend === "lighten" ? blend : "over" };
        break;
      }
      default:
        miss(ctx, `effect:${e.name}`);
    }
  }
  return out;
}

/** One entry of the theme's style matrix (`fillRef`/`lnRef`/`effectRef`),
 *  resolved with the colour the reference supplies as `phClr`. */
export function themeStyle(
  ref: XmlElement | null,
  kind: "fill" | "line" | "effect",
  ctx: StyleContext,
): { fill?: Fill | null; line?: Line | null; effects?: Effects } {
  if (!ref) return {};
  const idx = numAttr(ref, "idx", 0);
  if (idx === 0) return kind === "fill" ? { fill: null } : kind === "line" ? { line: null } : { effects: NO_EFFECTS };
  const placeholder = colorIn(ref, ctx.colors);
  const themed: StyleContext = { ...ctx, part: ctx.theme.part, colors: { ...ctx.colors, placeholder } };
  if (kind === "fill") {
    const list = idx >= 1001 ? ctx.theme.bgFills : ctx.theme.fills;
    const entry = list[(idx >= 1001 ? idx - 1001 : idx - 1)];
    return { fill: entry ? readFill(entry, themed) : null };
  }
  if (kind === "line") {
    const entry = ctx.theme.lines[idx - 1];
    return { line: entry ? readLine(entry, themed, null) : null };
  }
  const entry = ctx.theme.effects[idx - 1];
  return { effects: entry ? readEffects(entry, themed, NO_EFFECTS) : NO_EFFECTS };
}
