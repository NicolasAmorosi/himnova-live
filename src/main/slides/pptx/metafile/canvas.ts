import { metricTwin } from "@shared/font-twins";
import { crop, pngHref, type Picture, type Raster } from "./dib";

/**
 * The GDI device context both metafile players drive, writing SVG as it goes.
 *
 * GDI draws through two mappings: world space → page space (the world transform, EMF only) and page
 * space → device space (window/viewport origins and extents, under a mapping mode). Everything here
 * is emitted in DEVICE space — the space the SVG's `viewBox` is in — so that a clip region (which
 * GDI keeps in device units), a path built across several transforms, and a cosmetic pen (one device
 * pixel, whatever the mapping) all land in one coordinate system. Geometry is transformed point by
 * point (exact for an affine map: an ellipse goes out as Béziers); only text and bitmaps keep a
 * `transform`, because their glyphs and pixels cannot be transformed point by point.
 *
 * Names and constants follow [MS-WMF]/[MS-EMF]; the players own the record layouts.
 */

/** (x, y) → (a·x + c·y + e, b·x + d·y + f), as SVG's `matrix()` writes it. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` after `n`: a point goes through `n` first. */
export function compose(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export type Pen = {
  style: number;
  /** Logical units; 0 = one device pixel. */
  width: number;
  color: number;
  /** A cosmetic pen is one device pixel wide, whatever `width` says. */
  cosmetic: boolean;
  cap: "round" | "square" | "butt";
  join: "round" | "bevel" | "miter";
  /** `PS_USERSTYLE` dash lengths. */
  user: readonly number[];
};

export type Brush = { style: number; color: number; hatch: number; pattern: Raster | null };

export type Font = {
  height: number;
  width: number;
  escapement: number;
  weight: number;
  italic: boolean;
  underline: boolean;
  strikeOut: boolean;
  charset: number;
  pitchAndFamily: number;
  face: string;
};

export type GdiObject =
  | { kind: "pen"; pen: Pen }
  | { kind: "brush"; brush: Brush }
  | { kind: "font"; font: Font }
  | { kind: "palette"; colors: number[] }
  | { kind: "region"; rects: number[] }
  | { kind: "other" };

export const PS_SOLID = 0;
export const PS_NULL = 5;
const PS_USERSTYLE = 7;

export const BS_SOLID = 0;
export const BS_NULL = 1;
export const BS_HATCHED = 2;
export const BS_PATTERN = 3;

const OPAQUE = 2;
const ALTERNATE = 1;
const R2_BLACK = 1;
const R2_NOTCOPYPEN = 4;
const R2_NOP = 11;
const R2_WHITE = 16;

const TA_UPDATECP = 1;
const TA_RIGHT = 2;
const TA_CENTER = 6;
const TA_BOTTOM = 8;
const TA_BASELINE = 24;

export const ETO_OPAQUE = 0x2;
export const ETO_CLIPPED = 0x4;

/** Ternary raster operations ([MS-WMF] 2.1.1.31) the blits here tell apart. */
const SRCAND = 0x008800c6;
const SRCPAINT = 0x00ee0086;
const SRCINVERT = 0x00660046;
const NOTSRCCOPY = 0x00330008;
const PATCOPY = 0x00f00021;
const BLACKNESS = 0x00000042;
const WHITENESS = 0x00ff0062;

const SYMBOL_CHARSET = 2;

/** HS_HORIZONTAL … HS_DIAGCROSS on an 8 × 8 tile (diagonals wrap across its edges). */
const HATCHES = ["M0 4.5H8", "M4.5 0V8", "M0 0L8 8M-1 7L1 9M7 -1L9 1", "M0 8L8 0M-1 1L1 -1M7 9L9 7", "M0 4.5H8M4.5 0V8", "M0 0L8 8M0 8L8 0"];

/** Dash patterns of the PS_* styles: a cosmetic pen's in pixels, a geometric pen's in pen widths. */
const COSMETIC_DASHES: Record<number, readonly number[]> = { 1: [18, 6], 2: [3, 3], 3: [9, 6, 3, 6], 4: [9, 3, 3, 3, 3, 3], 8: [1, 1] };
const GEOMETRIC_DASHES: Record<number, readonly number[]> = { 1: [3, 1], 2: [1, 1], 3: [3, 1, 1, 1], 4: [3, 1, 1, 1, 1, 1] };

const MM_TEXT = 1;
const MM_ISOTROPIC = 7;
export const MM_ANISOTROPIC = 8;

/** Millimetres per logical unit of the fixed mapping modes 2–6 (LOMETRIC … TWIPS). */
const FIXED_MM: Record<number, number> = { 2: 0.1, 3: 0.01, 4: 0.254, 5: 0.0254, 6: 25.4 / 1440 };

const RGN_AND = 1;
const RGN_OR = 2;
const RGN_XOR = 3;
const RGN_DIFF = 4;
export const RGN_COPY = 5;

type Point = { x: number; y: number };

/** A clip region as a chain of intersections, each a `<clipPath>` in device space. `null` is no
 *  clip at all. Immutable, so a saved DC shares it safely. */
type Clip = { id: string; parent: Clip | null; d: string; rule: "nonzero" | "evenodd" };

type Dc = {
  pen: Pen;
  brush: Brush;
  font: Font;
  palette: number[] | null;
  textColor: number;
  bkColor: number;
  bkMode: number;
  textAlign: number;
  polyFill: number;
  rop2: number;
  clockwise: boolean;
  miterLimit: number;
  mapMode: number;
  winOrg: Point;
  winExt: Point;
  vpOrg: Point;
  vpExt: Point;
  world: Matrix;
  clip: Clip | null;
  meta: Clip | null;
  /** Current position, logical. */
  at: Point;
};

const BLACK_PEN: Pen = {
  style: PS_SOLID,
  width: 0,
  color: 0,
  cosmetic: true,
  cap: "round",
  join: "round",
  user: [],
};
const WHITE_BRUSH: Brush = { style: BS_SOLID, color: 0xffffff, hatch: 0, pattern: null };
const DEFAULT_FONT: Font = {
  height: 0,
  width: 0,
  escapement: 0,
  weight: 400,
  italic: false,
  underline: false,
  strikeOut: false,
  charset: 0,
  pitchAndFamily: 0,
  face: "",
};

/** A DIB pattern brush. One stored as JPEG/PNG (never seen) or unreadable paints a neutral grey. */
export function patternBrush(source: Raster | { encoded: Picture } | null): Brush {
  return !source || "encoded" in source
    ? { style: BS_SOLID, color: 0x808080, hatch: 0, pattern: null }
    : { style: BS_PATTERN, color: 0, hatch: 0, pattern: source };
}

/** [MS-WMF] 2.1.1.11 / [MS-EMF] 2.1.31 stock objects, by their index without the high bit. */
export function stockObject(index: number): GdiObject | null {
  const brush = (color: number, style = BS_SOLID): GdiObject => ({
    kind: "brush",
    brush: { style, color, hatch: 0, pattern: null },
  });
  const pen = (color: number, style = PS_SOLID): GdiObject => ({ kind: "pen", pen: { ...BLACK_PEN, color, style } });
  const font = (face: string, height: number): GdiObject => ({ kind: "font", font: { ...DEFAULT_FONT, face, height } });
  switch (index) {
    case 0:
    case 18: // DC_BRUSH, white unless SetDCBrushColor (which EMF does not record)
      return brush(0xffffff);
    case 1:
      return brush(0xc0c0c0);
    case 2:
      return brush(0x808080);
    case 3:
      return brush(0x404040);
    case 4:
      return brush(0);
    case 5:
      return brush(0, BS_NULL);
    case 6:
      return pen(0xffffff);
    case 7:
    case 19:
      return pen(0);
    case 8:
      return pen(0, PS_NULL);
    case 10:
    case 11:
    case 16:
      return font("Courier New", -13);
    case 12:
    case 13:
    case 14:
      return font("System", -16);
    case 17:
      return font("Tahoma", -11);
    default:
      return null;
  }
}

/** Ascent and descent over the em (OS/2 winAscent/winDescent ÷ unitsPerEm) of the faces metafiles
 *  name most, read from the fonts themselves. GDI aligns text to them (TA_TOP/TA_BOTTOM) and a
 *  positive `lfHeight` is their sum, not the em — so they decide where a line of text lands even
 *  when the face itself is missing and another one draws it. Anything else gets Arial's. */
const METRICS: Record<string, readonly [number, number]> = {
  arial: [0.905, 0.212],
  helvetica: [0.905, 0.212],
  "liberation sans": [0.905, 0.212],
  "times new roman": [0.891, 0.216],
  "liberation serif": [0.891, 0.216],
  calibri: [0.952, 0.269],
  "calibri light": [0.952, 0.269],
  "segoe ui": [1.079, 0.251],
  tahoma: [1.0, 0.207],
  verdana: [1.005, 0.21],
  "courier new": [0.833, 0.3],
  "microsoft sans serif": [0.922, 0.21],
  "ms sans serif": [0.922, 0.21],
  symbol: [1.005, 0.22],
  wingdings: [0.899, 0.211],
  webdings: [0.8, 0.2],
  georgia: [0.917, 0.219],
  "trebuchet ms": [0.939, 0.222],
  "century gothic": [0.971, 0.22],
};

/** A CSS generic family for when the face is not on this machine, from `lfPitchAndFamily`. */
function genericFamily(font: Font): string {
  switch (font.pitchAndFamily & 0xf0) {
    case 0x10:
      return "serif";
    case 0x30:
      return "monospace";
    case 0x40:
      return "cursive";
    default:
      return /times|roman|serif|garamond|georgia|cambria|book|palatino/i.test(font.face) && !/sans/i.test(font.face)
        ? "serif"
        : "sans-serif";
  }
}

/** Numbers as SVG wants them: three decimals at most, no `-0`, no exponent. */
function num(value: number): string {
  const r = Math.round(value * 1000) / 1000;
  return Object.is(r, -0) || r === 0 ? "0" : String(r);
}

function hex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** COLORREF ([MS-WMF] 2.2.2.8): 0x00BBGGRR → 0xRRGGBB. */
export function colorRef(value: number): number {
  return ((value & 0xff) << 16) | (value & 0xff00) | ((value >> 16) & 0xff);
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

/** Characters XML refuses (and that would make the whole SVG unreadable) become spaces — never
 *  dropped, because each one still owns an entry of the text's advance array. */
function xmlSafe(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      out += text.slice(i, i + 2);
      i += 1;
    } else {
      out += c < 0x20 || c === 0xfffe || c === 0xffff || (c >= 0xd800 && c <= 0xdfff) ? " " : text[i]!;
    }
  }
  return out;
}

/** Code pages of the `lfCharSet` values ([MS-WMF] 2.1.1.5) whose 8-bit text is not Windows-1252. */
const CODE_PAGES: Record<number, string> = {
  77: "macintosh",
  128: "shift_jis",
  129: "euc-kr",
  134: "gbk",
  136: "big5",
  161: "windows-1253",
  162: "windows-1254",
  163: "windows-1258",
  177: "windows-1255",
  178: "windows-1256",
  186: "windows-1257",
  204: "windows-1251",
  222: "windows-874",
  238: "windows-1250",
};

/** 8-bit text (WMF, ExtTextOutA) in the code page of the font's charset. A symbol charset's bytes
 *  are the font's own glyph codes and stay as they are (see `symbolText`). */
export function decodeAnsi(bytes: Uint8Array, font: Font): string {
  const latin1 = (): string => Buffer.from(bytes).toString("latin1");
  if (font.charset === SYMBOL_CHARSET) return latin1();
  try {
    return new TextDecoder(CODE_PAGES[font.charset] ?? "windows-1252").decode(bytes);
  } catch {
    return latin1();
  }
}

/** The Symbol font's encoding, 0x20–0x7E then 0xA0–0xFE, in Unicode: MathType equations and Greek
 *  in old clip art write "a" meaning α. */
const SYMBOL_LOW = " !∀#∃%&∋()∗+,−./0123456789:;<=>?≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼";
const SYMBOL_HIGH = "€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓" + "◊〈®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪ 〉∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭";

/** Text in a symbol font as the characters it shows. Symbol itself has a Unicode equivalent for
 *  every glyph; any other symbol-charset face (Wingdings, Webdings) is addressed in the U+F0xx
 *  range its own cmap maps, where GDI puts an 8-bit code too. */
function symbolText(text: string, font: Font): string {
  if (/^symbol$/i.test(font.face)) {
    return text.replace(/[\u0020-\u00ff\uf020-\uf0ff]/g, (c) => {
      const code = c.charCodeAt(0) & 0xff;
      return (code < 0x7f ? SYMBOL_LOW[code - 0x20] : code >= 0xa0 ? SYMBOL_HIGH[code - 0xa0] : undefined) ?? c;
    });
  }
  if (font.charset !== SYMBOL_CHARSET) return text;
  return text.replace(/[\u0020-\u00ff]/g, (c) => String.fromCharCode(0xf000 + c.charCodeAt(0)));
}

export class Canvas {
  dc: Dc;
  private readonly saved: Dc[] = [];
  private readonly defs: string[] = [];
  private readonly body: string[] = [];
  private readonly patterns = new Map<string, string>();
  private open: Clip[] = [];
  private ids = 0;
  /** The path being built (BeginPath … EndPath) or waiting to be used, in device space. */
  private path: string[] | null = null;
  private inPath = false;
  /** Whether the next segment of a path continues a figure or has to start one at `at`. */
  private figureOpen = false;

  /**
   * `view` is the device-space rectangle the SVG shows (what the picture frame maps onto); `size`
   * its natural size in CSS pixels; `pxPerMm` the reference device's resolution, which fixes the
   * scale of the metric mapping modes.
   */
  constructor(
    private readonly view: { x: number; y: number; w: number; h: number },
    private readonly size: { w: number; h: number },
    private readonly pxPerMm: Point,
  ) {
    this.dc = {
      pen: BLACK_PEN,
      brush: WHITE_BRUSH,
      font: DEFAULT_FONT,
      palette: null,
      textColor: 0,
      bkColor: 0xffffff,
      bkMode: OPAQUE,
      textAlign: 0,
      polyFill: ALTERNATE,
      rop2: 13,
      clockwise: false,
      miterLimit: 10,
      mapMode: MM_TEXT,
      winOrg: { x: 0, y: 0 },
      winExt: { x: 1, y: 1 },
      vpOrg: { x: 0, y: 0 },
      vpExt: { x: 1, y: 1 },
      world: IDENTITY,
      clip: null,
      meta: null,
      at: { x: 0, y: 0 },
    };
  }

  // -- state ----------------------------------------------------------------------------------------

  save(): void {
    this.saved.push({ ...this.dc });
  }

  /** `n` < 0 is relative (-1 = the last save), > 0 the n-th save counting from 1. */
  restore(n: number): void {
    const index = n < 0 ? this.saved.length + n : n - 1;
    if (index < 0 || index >= this.saved.length) return;
    this.dc = this.saved[index]!;
    this.saved.length = index;
  }

  select(object: GdiObject | null | undefined): void {
    if (!object) return;
    if (object.kind === "pen") this.dc.pen = object.pen;
    else if (object.kind === "brush") this.dc.brush = object.brush;
    else if (object.kind === "font") this.dc.font = object.font;
    else if (object.kind === "palette") this.dc.palette = object.colors;
  }

  /** Logical → device. */
  matrix(): Matrix {
    const dc = this.dc;
    let sx: number;
    let sy: number;
    const fixed = FIXED_MM[dc.mapMode];
    if (fixed !== undefined) {
      sx = fixed * this.pxPerMm.x;
      sy = -fixed * this.pxPerMm.y;
    } else if (dc.mapMode === MM_ANISOTROPIC || dc.mapMode === MM_ISOTROPIC) {
      sx = dc.vpExt.x / dc.winExt.x;
      sy = dc.vpExt.y / dc.winExt.y;
      if (dc.mapMode === MM_ISOTROPIC) {
        const s = Math.min(Math.abs(sx), Math.abs(sy));
        sx = Math.sign(sx) * s;
        sy = Math.sign(sy) * s;
      }
    } else {
      sx = 1;
      sy = 1;
    }
    if (!Number.isFinite(sx) || sx === 0) sx = 1;
    if (!Number.isFinite(sy) || sy === 0) sy = 1;
    const page: Matrix = [sx, 0, 0, sy, dc.vpOrg.x - dc.winOrg.x * sx, dc.vpOrg.y - dc.winOrg.y * sy];
    return dc.world === IDENTITY ? page : compose(page, dc.world);
  }

  // -- clipping -------------------------------------------------------------------------------------

  private clipNode(parent: Clip | null, d: string, rule: Clip["rule"]): Clip {
    const id = `c${(this.ids += 1)}`;
    this.defs.push(`<clipPath id="${id}"><path d="${d}" clip-rule="${rule}"/></clipPath>`);
    return { id, parent, d, rule };
  }

  /** Combines the clip with a device-space region given as path data. */
  clipWith(d: string, rule: Clip["rule"], mode: number): void {
    const dc = this.dc;
    switch (mode) {
      case RGN_COPY:
        dc.clip = this.clipNode(dc.meta, d, rule);
        break;
      case RGN_DIFF: {
        // Everything but the region: the region inside a rectangle far larger than the picture.
        const { x, y, w, h } = this.view;
        const big = `M${num(x - 10 * w)} ${num(y - 10 * h)}h${num(21 * w)}v${num(21 * h)}h${num(-21 * w)}Z`;
        dc.clip = this.clipNode(dc.clip, `${big}${d}`, "evenodd");
        break;
      }
      case RGN_OR:
      case RGN_XOR:
        // A union only stays a union when the clip is one region over the meta region; anything
        // deeper keeps what it has, which errs on showing too much rather than too little.
        if (dc.clip !== dc.meta && dc.clip?.parent === dc.meta) {
          dc.clip = this.clipNode(dc.meta, `${dc.clip.d}${d}`, "nonzero");
        }
        break;
      default:
        dc.clip = this.clipNode(dc.clip, d, rule);
    }
  }

  /** `IntersectClipRect`/`ExcludeClipRect`: a logical rectangle. */
  clipRect(l: number, t: number, r: number, b: number, exclude: boolean): void {
    this.clipWith(this.rectPath(l, t, r, b, this.matrix()), "nonzero", exclude ? RGN_DIFF : RGN_AND);
  }

  /** A region as device-space rectangles (l, t, r, b, …); none = the whole surface. */
  clipRegion(rects: readonly number[], mode: number): void {
    if (rects.length < 4) {
      if (mode === RGN_COPY) this.dc.clip = this.dc.meta;
      return;
    }
    this.clipWith(rectsPath(rects), "nonzero", mode);
  }

  /** `SelectClipPath`: the current path becomes (or combines with) the clip. */
  clipToPath(mode: number): void {
    if (this.path) this.clipWith(this.path.join(""), this.fillRule(), mode);
    this.path = null;
  }

  setMetaRegion(): void {
    this.dc.meta = this.dc.clip;
  }

  // -- paths ----------------------------------------------------------------------------------------

  beginPath(): void {
    this.path = [];
    this.inPath = true;
    this.figureOpen = false;
  }

  endPath(): void {
    this.inPath = false;
  }

  abortPath(): void {
    this.path = null;
    this.inPath = false;
  }

  closeFigure(): void {
    if (this.inPath && this.path && this.figureOpen) this.path.push("Z");
    this.figureOpen = false;
  }

  /** FillPath / StrokePath / StrokeAndFillPath: the path is used once, then gone. */
  usePath(fill: boolean, stroke: boolean): void {
    const d = this.path?.join("");
    this.path = null;
    this.inPath = false;
    if (d) this.shape(d, fill, stroke);
  }

  moveTo(x: number, y: number): void {
    this.dc.at = { x, y };
    this.figureOpen = false;
  }

  // -- geometry, logical in, device path data out ----------------------------------------------------

  private pt(m: Matrix, x: number, y: number): string {
    return `${num(m[0] * x + m[2] * y + m[4])} ${num(m[1] * x + m[3] * y + m[5])}`;
  }

  /** Points as M/L path data; `close` ends the figure. */
  private polyPath(m: Matrix, points: ArrayLike<number>, close: boolean): string {
    if (points.length < 2) return "";
    let d = `M${this.pt(m, points[0]!, points[1]!)}`;
    for (let i = 2; i + 1 < points.length; i += 2) d += `L${this.pt(m, points[i]!, points[i + 1]!)}`;
    return close ? `${d}Z` : d;
  }

  /** Cubic Bézier segments (three points each) as C path data, no leading M. */
  private bezierSegments(m: Matrix, points: ArrayLike<number>, from: number): string {
    let d = "";
    for (let i = from; i + 5 < points.length; i += 6) {
      d +=
        `C${this.pt(m, points[i]!, points[i + 1]!)} ${this.pt(m, points[i + 2]!, points[i + 3]!)} ` +
        this.pt(m, points[i + 4]!, points[i + 5]!);
    }
    return d;
  }

  /** GDI walks a rectangle (and an ellipse) counter-clockwise by default, which decides how
   *  overlapping figures of a winding-filled path combine. */
  private rectPath(l: number, t: number, r: number, b: number, m: Matrix): string {
    const points = this.dc.clockwise ? [l, t, r, t, r, b, l, b] : [l, t, l, b, r, b, r, t];
    return this.polyPath(m, points, true);
  }

  /** An elliptical arc from angle `a0` sweeping `sweep` radians (y down: positive is clockwise
   *  on screen), as Bézier segments of at most 90°, no leading M. */
  private arcSegments(m: Matrix, cx: number, cy: number, rx: number, ry: number, a0: number, sweep: number): string {
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const step = sweep / steps;
    const k = (4 / 3) * Math.tan(step / 4);
    let d = "";
    for (let i = 0; i < steps; i += 1) {
      const t0 = a0 + i * step;
      const t1 = t0 + step;
      const [c0, s0, c1, s1] = [Math.cos(t0), Math.sin(t0), Math.cos(t1), Math.sin(t1)];
      d +=
        `C${this.pt(m, cx + rx * (c0 - k * s0), cy + ry * (s0 + k * c0))} ` +
        `${this.pt(m, cx + rx * (c1 + k * s1), cy + ry * (s1 - k * c1))} ${this.pt(m, cx + rx * c1, cy + ry * s1)}`;
    }
    return d;
  }

  private ellipseD(m: Matrix, l: number, t: number, r: number, b: number): string {
    const [cx, cy, rx, ry] = [(l + r) / 2, (t + b) / 2, Math.abs(r - l) / 2, Math.abs(b - t) / 2];
    const sweep = this.dc.clockwise ? 2 * Math.PI : -2 * Math.PI;
    return `M${this.pt(m, cx + rx, cy)}${this.arcSegments(m, cx, cy, rx, ry, 0, sweep)}Z`;
  }

  private roundRectD(m: Matrix, l: number, t: number, r: number, b: number, w: number, h: number): string {
    if (l > r) [l, r] = [r, l];
    if (t > b) [t, b] = [b, t];
    const rx = Math.min(Math.abs(w) / 2, (r - l) / 2);
    const ry = Math.min(Math.abs(h) / 2, (b - t) / 2);
    if (rx <= 0 || ry <= 0) return this.rectPath(l, t, r, b, m);
    const q = Math.PI / 2;
    // Counter-clockwise on screen from the top edge's left end, as GDI goes by default.
    return (
      `M${this.pt(m, l + rx, t)}${this.arcSegments(m, l + rx, t + ry, rx, ry, -q, -q)}` +
      `L${this.pt(m, l, b - ry)}${this.arcSegments(m, l + rx, b - ry, rx, ry, Math.PI, -q)}` +
      `L${this.pt(m, r - rx, b)}${this.arcSegments(m, r - rx, b - ry, rx, ry, q, -q)}` +
      `L${this.pt(m, r, t + ry)}${this.arcSegments(m, r - rx, t + ry, rx, ry, 0, -q)}Z`
    );
  }

  /** Arc/Chord/Pie geometry: the ellipse in the box, from where the radial through `start` meets
   *  it to where the one through `end` does, counter-clockwise on screen unless SetArcDirection
   *  said otherwise. Returns the start point and the segments. */
  private arcGeometry(
    m: Matrix,
    box: readonly number[],
    start: Point,
    end: Point,
  ): { from: string; arc: string; center: string; endPt: Point } {
    const [l = 0, t = 0, r = 0, b = 0] = box;
    const [cx, cy, rx, ry] = [(l + r) / 2, (t + b) / 2, Math.abs(r - l) / 2, Math.abs(b - t) / 2];
    const angle = (p: Point): number => Math.atan2((p.y - cy) / (ry || 1), (p.x - cx) / (rx || 1));
    const a0 = angle(start);
    let a1 = angle(end);
    if (this.dc.clockwise) {
      while (a1 <= a0) a1 += 2 * Math.PI;
    } else {
      while (a1 >= a0) a1 -= 2 * Math.PI;
    }
    return {
      from: this.pt(m, cx + rx * Math.cos(a0), cy + ry * Math.sin(a0)),
      arc: this.arcSegments(m, cx, cy, rx, ry, a0, a1 - a0),
      center: this.pt(m, cx, cy),
      endPt: { x: cx + rx * Math.cos(a1), y: cy + ry * Math.sin(a1) },
    };
  }

  // -- drawing ------------------------------------------------------------------------------------

  /** A closed or open figure: into the path inside a bracket, drawn otherwise. */
  private figure(d: string, fill: boolean): void {
    if (!d) return;
    if (this.inPath) {
      this.path?.push(d);
      this.figureOpen = false;
    } else {
      this.shape(d, fill, true);
    }
  }

  polygon(points: ArrayLike<number>): void {
    this.figure(this.polyPath(this.matrix(), points, true), true);
  }

  polyPolygon(polygons: readonly ArrayLike<number>[]): void {
    const m = this.matrix();
    this.figure(polygons.map((p) => this.polyPath(m, p, true)).join(""), true);
  }

  polyline(points: ArrayLike<number>): void {
    this.figure(this.polyPath(this.matrix(), points, false), false);
  }

  polyBezier(points: ArrayLike<number>): void {
    if (points.length < 2) return;
    const m = this.matrix();
    this.figure(`M${this.pt(m, points[0]!, points[1]!)}${this.bezierSegments(m, points, 2)}`, false);
  }

  rectangle(l: number, t: number, r: number, b: number): void {
    this.figure(this.rectPath(l, t, r, b, this.matrix()), true);
  }

  ellipse(l: number, t: number, r: number, b: number): void {
    this.figure(this.ellipseD(this.matrix(), l, t, r, b), true);
  }

  roundRect(l: number, t: number, r: number, b: number, w: number, h: number): void {
    this.figure(this.roundRectD(this.matrix(), l, t, r, b, w, h), true);
  }

  arc(kind: "arc" | "chord" | "pie", box: readonly number[], start: Point, end: Point): void {
    const g = this.arcGeometry(this.matrix(), box, start, end);
    const d = kind === "arc" ? `M${g.from}${g.arc}` : kind === "chord" ? `M${g.from}${g.arc}Z` : `M${g.center}L${g.from}${g.arc}Z`;
    this.figure(d, kind !== "arc");
  }

  /** The segments of a *To record (LineTo, PolylineTo, PolyBezierTo, ArcTo, AngleArc), which start
   *  at the current position: they extend the open figure of a path, or draw a line. */
  private toSegments(d: string, end: Point): void {
    const m = this.matrix();
    if (this.inPath) {
      if (!this.figureOpen) this.path?.push(`M${this.pt(m, this.dc.at.x, this.dc.at.y)}`);
      this.path?.push(d);
      this.figureOpen = true;
    } else {
      this.shape(`M${this.pt(m, this.dc.at.x, this.dc.at.y)}${d}`, false, true);
    }
    this.dc.at = end;
  }

  lineTo(x: number, y: number): void {
    this.toSegments(`L${this.pt(this.matrix(), x, y)}`, { x, y });
  }

  polylineTo(points: ArrayLike<number>): void {
    if (points.length < 2) return;
    const m = this.matrix();
    let d = "";
    for (let i = 0; i + 1 < points.length; i += 2) d += `L${this.pt(m, points[i]!, points[i + 1]!)}`;
    this.toSegments(d, { x: points[points.length - 2]!, y: points[points.length - 1]! });
  }

  polyBezierTo(points: ArrayLike<number>): void {
    if (points.length < 6) return;
    const usable = points.length - (points.length % 6);
    this.toSegments(this.bezierSegments(this.matrix(), points, 0), { x: points[usable - 2]!, y: points[usable - 1]! });
  }

  arcTo(box: readonly number[], start: Point, end: Point): void {
    const g = this.arcGeometry(this.matrix(), box, start, end);
    this.toSegments(`L${g.from}${g.arc}`, g.endPt);
  }

  /** AngleArc: degrees, counter-clockwise on screen, whatever the arc direction. */
  angleArc(cx: number, cy: number, radius: number, startDeg: number, sweepDeg: number): void {
    const m = this.matrix();
    const a0 = (-startDeg * Math.PI) / 180;
    const sweep = (-sweepDeg * Math.PI) / 180;
    const end = { x: cx + radius * Math.cos(a0 + sweep), y: cy + radius * Math.sin(a0 + sweep) };
    const from = this.pt(m, cx + radius * Math.cos(a0), cy + radius * Math.sin(a0));
    this.toSegments(`L${from}${this.arcSegments(m, cx, cy, radius, radius, a0, sweep)}`, end);
  }

  /** PolyDraw: points tagged PT_MOVETO (6), PT_LINETO (2), PT_BEZIERTO (4), | PT_CLOSEFIGURE (1). */
  polyDraw(points: ArrayLike<number>, types: ArrayLike<number>): void {
    const m = this.matrix();
    let d = "";
    let start = this.dc.at;
    let at = this.dc.at;
    let open = false;
    const begin = (): void => {
      if (!open) d += `M${this.pt(m, at.x, at.y)}`;
      open = true;
    };
    for (let i = 0; i < types.length; i += 1) {
      const type = types[i]!;
      const p = { x: points[i * 2]!, y: points[i * 2 + 1]! };
      if ((type & 6) === 6) {
        d += `M${this.pt(m, p.x, p.y)}`;
        open = true;
        start = p;
      } else if ((type & 6) === 4 && i + 2 < types.length) {
        begin();
        d +=
          `C${this.pt(m, p.x, p.y)} ${this.pt(m, points[i * 2 + 2]!, points[i * 2 + 3]!)} ` +
          this.pt(m, points[i * 2 + 4]!, points[i * 2 + 5]!);
        i += 2;
        p.x = points[i * 2]!;
        p.y = points[i * 2 + 1]!;
      } else {
        begin();
        d += `L${this.pt(m, p.x, p.y)}`;
      }
      at = p;
      if (types[i]! & 1) {
        d += "Z";
        at = start;
      }
    }
    this.dc.at = at;
    if (this.inPath) {
      this.path?.push(d);
      this.figureOpen = true;
    } else if (d) {
      this.shape(d, false, true);
    }
  }

  setPixel(x: number, y: number, color: number): void {
    const m = this.matrix();
    const dx = m[0] * x + m[2] * y + m[4];
    const dy = m[1] * x + m[3] * y + m[5];
    this.emit(`<rect x="${num(dx)}" y="${num(dy)}" width="1" height="1" fill="${hex(color)}"/>`);
  }

  /** A logical rectangle filled with a colour, no pen (ETO_OPAQUE, PATCOPY, BLACKNESS …). */
  fillRect(l: number, t: number, r: number, b: number, fill: string): void {
    this.emit(`<path d="${this.polyPath(this.matrix(), [l, t, r, t, r, b, l, b], true)}" fill="${fill}"/>`);
  }

  /** PatBlt/BitBlt without a source: the rectangle in the current brush. */
  fillRectWithBrush(l: number, t: number, r: number, b: number): void {
    const fill = this.fillPaint();
    if (fill) this.fillRect(l, t, r, b, fill);
  }

  regionShape(rects: readonly number[], fill: boolean, stroke: boolean): void {
    // Regions of FillRgn/PaintRgn are logical rectangles.
    const m = this.matrix();
    let d = "";
    for (let i = 0; i + 3 < rects.length; i += 4) {
      d += this.rectPath(rects[i]!, rects[i + 1]!, rects[i + 2]!, rects[i + 3]!, m);
    }
    if (d) this.shape(d, fill, stroke);
  }

  // -- paint ----------------------------------------------------------------------------------------

  /** What a pen or brush colour becomes under the binary raster operation. `null`: draws nothing. */
  private ink(color: number): number | null {
    switch (this.dc.rop2) {
      case R2_NOP:
        return null;
      case R2_BLACK:
        return 0;
      case R2_WHITE:
        return 0xffffff;
      case R2_NOTCOPYPEN:
        return ~color & 0xffffff;
      default:
        return color;
    }
  }

  private fillRule(): Clip["rule"] {
    return this.dc.polyFill === ALTERNATE ? "evenodd" : "nonzero";
  }

  private fillPaint(): string | null {
    const brush = this.dc.brush;
    if (brush.style === BS_NULL) return null;
    if (brush.style === BS_HATCHED) return this.dc.rop2 === R2_NOP ? null : `url(#${this.hatch(brush)})`;
    if (brush.pattern) return this.dc.rop2 === R2_NOP ? null : `url(#${this.patternOf(brush.pattern)})`;
    const color = this.ink(brush.color);
    return color === null ? null : hex(color);
  }

  /** HS_* hatches are 8×8 device pixels, in the brush colour over the background colour when the
   *  background mode is OPAQUE. */
  private hatch(brush: Brush): string {
    const bk = this.dc.bkMode === OPAQUE ? this.dc.bkColor : -1;
    const key = `h${brush.hatch}:${brush.color}:${bk}`;
    let id = this.patterns.get(key);
    if (id) return id;
    id = `p${(this.ids += 1)}`;
    const d = HATCHES[brush.hatch] ?? HATCHES[0]!;
    const back = bk >= 0 ? `<rect width="8" height="8" fill="${hex(bk)}"/>` : "";
    this.defs.push(
      `<pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse">${back}` +
        `<path d="${d}" stroke="${hex(brush.color)}" fill="none"/></pattern>`,
    );
    this.patterns.set(key, id);
    return id;
  }

  /** A bitmap brush tiles in device pixels. */
  private patternOf(raster: Raster): string {
    const key = `b${raster.width}x${raster.height}:${Buffer.from(raster.rgba).toString("base64")}`;
    let id = this.patterns.get(key);
    if (id) return id;
    id = `p${(this.ids += 1)}`;
    this.defs.push(
      `<pattern id="${id}" width="${raster.width}" height="${raster.height}" patternUnits="userSpaceOnUse">` +
        `<image width="${raster.width}" height="${raster.height}" href="${pngHref(raster)}"/></pattern>`,
    );
    this.patterns.set(key, id);
    return id;
  }

  /** Stroke attributes for the current pen at transform `m`, or `null` for no stroke. */
  private strokeAttrs(m: Matrix): string | null {
    const pen = this.dc.pen;
    if (pen.style === PS_NULL) return null;
    const color = this.ink(pen.color);
    if (color === null) return null;
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const device = pen.width * scale;
    // A cosmetic pen is one device pixel; so, at least, is any pen GDI draws. A hairline in
    // screen pixels is what PowerPoint draws for it.
    const hairline = pen.cosmetic || device < 1;
    let attrs = ` stroke="${hex(color)}"`;
    attrs += hairline ? ` stroke-width="1" vector-effect="non-scaling-stroke"` : ` stroke-width="${num(device)}"`;
    if (pen.cap !== "butt") attrs += ` stroke-linecap="${pen.cap}"`;
    if (pen.join !== "miter") attrs += ` stroke-linejoin="${pen.join}"`;
    else if (this.dc.miterLimit !== 4) attrs += ` stroke-miterlimit="${num(Math.max(1, this.dc.miterLimit))}"`;
    // Cosmetic styles are fixed lengths in pixels; geometric ones are multiples of the pen's width.
    const unit = hairline ? 1 : device;
    const style = pen.style & 0xf;
    const dashes =
      style === PS_USERSTYLE
        ? pen.user.map((v) => (hairline ? v : v * scale))
        : ((hairline ? COSMETIC_DASHES : GEOMETRIC_DASHES)[style] ?? []).map((v) => v * unit);
    if (dashes.length > 0) attrs += ` stroke-dasharray="${dashes.map((v) => num(Math.max(0, v))).join(" ")}"`;
    return attrs;
  }

  /** Device-space path data filled and/or stroked with the current brush and pen. */
  private shape(d: string, fill: boolean, stroke: boolean): void {
    const paint = fill ? this.fillPaint() : null;
    const line = stroke ? this.strokeAttrs(this.matrix()) : null;
    if (!paint && !line) return;
    let attrs = ` fill="${paint ?? "none"}"`;
    if (paint && this.dc.polyFill === ALTERNATE) attrs += ` fill-rule="evenodd"`;
    this.emit(`<path d="${d}"${attrs}${line ?? ""}/>`);
  }

  // -- text -----------------------------------------------------------------------------------------

  /**
   * ExtTextOut/TextOut. `advances` is the dx array (logical units, one per UTF-16 unit); without
   * one, Chromium lays the run out with whatever face draws it.
   *
   * GM_COMPATIBLE text (`advanced` false — all of WMF) is never transformed by the mapping: its
   * glyphs stay upright at their natural proportions and only their height scales. GM_ADVANCED text
   * follows the full transform, except that a y-axis pointing up does not turn the glyphs upside
   * down.
   */
  text(run: {
    x: number;
    y: number;
    text: string;
    advances: readonly number[] | null;
    options: number;
    rect: readonly number[] | null;
    advanced: boolean;
  }): void {
    const dc = this.dc;
    const font = dc.font;
    const updateCp = (dc.textAlign & TA_UPDATECP) !== 0;
    const horizontal = dc.textAlign & TA_CENTER;
    const ref = updateCp ? dc.at : { x: run.x, y: run.y };
    const [l = 0, t = 0, r = 0, b = 0] = run.rect ?? [];
    if (run.rect && run.options & ETO_OPAQUE) this.fillRect(l, t, r, b, hex(dc.bkColor));
    const m = this.matrix();
    const [ascent, descent] = METRICS[font.face.toLowerCase()] ?? METRICS.arial!;
    let em = font.height < 0 ? -font.height : font.height > 0 ? font.height / (ascent + descent) : 0;
    let ratio = 1;
    let glyphs: Matrix;
    const angle = (-font.escapement / 10) * (Math.PI / 180);
    const rotate: Matrix = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
    if (run.advanced) {
      const flip = m[0] * m[3] - m[1] * m[2] < 0 ? -1 : 1;
      glyphs = compose(compose(m, [1, 0, 0, flip, ref.x, ref.y]), rotate);
    } else {
      const sy = Math.hypot(m[2], m[3]);
      ratio = Math.hypot(m[0], m[1]) / sy;
      const dx = m[0] * ref.x + m[2] * ref.y + m[4];
      const dy = m[1] * ref.x + m[3] * ref.y + m[5];
      glyphs = compose([sy, 0, 0, sy, dx, dy], rotate);
    }
    if (em === 0) em = 12 / Math.hypot(glyphs[2], glyphs[3]); // the default font: ~12 device px
    const chars = xmlSafe(symbolText(run.text, font));
    let width: number | null = null;
    let xs = "";
    if (run.advances && run.advances.length >= chars.length) {
      let at = 0;
      const positions: number[] = [];
      for (let i = 0; i < chars.length; i += 1) {
        positions.push(at);
        at += run.advances[i]! * ratio;
      }
      width = at;
      const shift = horizontal === TA_CENTER ? -width / 2 : horizontal === TA_RIGHT ? -width : 0;
      xs = positions.map((p) => num(p + shift)).join(" ");
    }
    const vertical = dc.textAlign & TA_BASELINE;
    const baseline = vertical === TA_BASELINE ? 0 : vertical === TA_BOTTOM ? -descent * em : ascent * em;
    if (updateCp) {
      // The current position moves along the baseline by the run's advance.
      const advance = (width ?? chars.length * 0.5 * em) / ratio;
      const sign = horizontal === TA_RIGHT ? -1 : horizontal === TA_CENTER ? 0 : 1;
      dc.at = { x: ref.x + sign * advance * Math.cos(angle), y: ref.y + sign * advance * Math.sin(angle) };
    }
    if (!chars.trim()) return;
    let clip: Clip | null | undefined;
    if (run.rect && run.options & ETO_CLIPPED) {
      clip = dc.clip;
      this.clipRect(l, t, r, b, false);
    }
    let body = "";
    if (dc.bkMode === OPAQUE && !(run.options & ETO_OPAQUE)) {
      const w = width ?? chars.length * 0.5 * em;
      const x0 = xs ? Number(xs.split(" ")[0]) : 0;
      body +=
        `<rect x="${num(x0)}" y="${num(baseline - ascent * em)}" width="${num(w)}" ` +
        `height="${num((ascent + descent) * em)}" fill="${hex(dc.bkColor)}"/>`;
    }
    const anchor = xs ? "" : horizontal === TA_CENTER ? ` text-anchor="middle"` : horizontal === TA_RIGHT ? ` text-anchor="end"` : "";
    // An SVG drawn as an image sees only the system's fonts, never the ones a page registers: the twin is the one
    // Linux distributions install.
    const families = [font.face, metricTwin(font.face) ?? ""].filter((f) => f).map((f) => `'${f.replace(/["'<>&]/g, "")}', `);
    let style = ` font-family="${families.join("")}${genericFamily(font)}" font-size="${num(em)}"`;
    if (font.weight >= 600) style += ` font-weight="${font.weight >= 800 ? 900 : 700}"`;
    if (font.italic) style += ` font-style="italic"`;
    if (font.underline || font.strikeOut) {
      style += ` text-decoration="${[font.underline ? "underline" : "", font.strikeOut ? "line-through" : ""].join(" ").trim()}"`;
    }
    body +=
      `<text x="${xs || "0"}" y="${num(baseline)}"${style}${anchor} fill="${hex(dc.textColor)}" xml:space="preserve">` +
      `${escapeXml(chars)}</text>`;
    this.emit(`<g transform="matrix(${glyphs.map(num).join(" ")})">${body}</g>`);
    if (clip !== undefined) dc.clip = clip;
  }

  // -- bitmaps --------------------------------------------------------------------------------------

  /**
   * BitBlt/StretchBlt/StretchDIBits and their WMF twins: `source` cropped to `src` (pixels, top
   * row first) stretched over the logical rectangle `dest`, under the ternary raster operation.
   *
   * Only SRCCOPY is a plain draw. The others combine with what is already there, which an SVG
   * image cannot; what metafiles use them for is transparency — a mask ANDed in, then the picture
   * ORed or XORed over it (how Windows draws an icon). So each is turned into the alpha that
   * reproduces it over that mask: an AND leaves the destination wherever the source is white, an
   * OR or XOR wherever it is black. Exact for the mask idiom, an approximation anywhere else.
   */
  blit(
    source: Raster | { encoded: Picture } | null,
    dest: readonly [number, number, number, number],
    src: readonly [number, number, number, number] | null,
    rop: number,
    opacity = 1,
  ): void {
    const [x, y, w, h] = dest;
    if (!source) {
      if (rop === PATCOPY) this.fillRectWithBrush(x, y, x + w, y + h);
      else if (rop === BLACKNESS) this.fillRect(x, y, x + w, y + h, "#000000");
      else if (rop === WHITENESS) this.fillRect(x, y, x + w, y + h, "#ffffff");
      return;
    }
    if ("encoded" in source) {
      this.image(source.encoded, x, y, w, h, opacity);
      return;
    }
    const raster = src ? crop(source, ...src) : source;
    if (!raster) return;
    const key = rop === SRCAND ? 0xffffff : rop === SRCPAINT || rop === SRCINVERT ? 0 : -1;
    const invert = rop === NOTSRCCOPY;
    if (key >= 0 || invert) {
      const rgba = raster.rgba;
      for (let i = 0; i < rgba.length; i += 4) {
        if (invert) {
          rgba[i] = 255 - rgba[i]!;
          rgba[i + 1] = 255 - rgba[i + 1]!;
          rgba[i + 2] = 255 - rgba[i + 2]!;
        } else if (((rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!) === key) {
          rgba[i + 3] = 0;
        }
      }
    }
    this.image({ width: raster.width, height: raster.height, href: pngHref(raster) }, x, y, w, h, opacity);
  }

  /** A picture stretched over the logical rectangle (x, y, w, h); `opacity` for AlphaBlend. */
  image(picture: Picture, x: number, y: number, w: number, h: number, opacity = 1): void {
    if (picture.width <= 0 || picture.height <= 0) return;
    this.picture(picture, compose(this.matrix(), [w / picture.width, 0, 0, h / picture.height, x, y]), opacity);
  }

  /** A picture placed by `place`, which takes its pixels to device space. */
  picture(picture: Picture, place: Matrix, opacity = 1): void {
    const alpha = opacity < 1 ? ` opacity="${num(opacity)}"` : "";
    this.emit(
      `<image width="${picture.width}" height="${picture.height}" preserveAspectRatio="none"${alpha} ` +
        `transform="matrix(${place.map(num).join(" ")})" href="${picture.href}"/>`,
    );
  }

  // -- output ---------------------------------------------------------------------------------------

  /** Appends an element inside the `<g clip-path>` groups of the current clip, opening and closing
   *  them as the clip changes between elements. */
  private emit(element: string): void {
    const want: Clip[] = [];
    for (let c = this.dc.clip; c; c = c.parent) want.unshift(c);
    let common = 0;
    while (common < this.open.length && common < want.length && this.open[common] === want[common]) common += 1;
    for (let i = this.open.length; i > common; i -= 1) this.body.push("</g>");
    for (let i = common; i < want.length; i += 1) this.body.push(`<g clip-path="url(#${want[i]!.id})">`);
    this.open = want;
    this.body.push(element);
  }

  svg(): string {
    const { x, y, w, h } = this.view;
    const close = "</g>".repeat(this.open.length);
    const defs = this.defs.length > 0 ? `<defs>${this.defs.join("")}</defs>` : "";
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${num(this.size.w)}" height="${num(this.size.h)}" ` +
      `viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}" preserveAspectRatio="none">` +
      `${defs}${this.body.join("")}${close}</svg>`
    );
  }
}

/** Device-space rectangles (l, t, r, b, …) as path data, all wound the same way so that a
 *  nonzero fill of several of them is their union. */
function rectsPath(rects: readonly number[]): string {
  let d = "";
  for (let i = 0; i + 3 < rects.length; i += 4) {
    const [l, t, r, b] = [rects[i]!, rects[i + 1]!, rects[i + 2]!, rects[i + 3]!];
    d += `M${num(l)} ${num(t)}H${num(r)}V${num(b)}H${num(l)}Z`;
  }
  return d;
}
