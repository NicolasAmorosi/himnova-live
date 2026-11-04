import type { Bullet, Effects, Paragraph, TextBody, TextRun } from "@shared/types/slide-model";
import { fontList, SYMBOL_BULLETS } from "../pptx/text";
import { childrenOf, type Rec } from "../ppt-binary";
import { cssColor, EMU_PER_MASTER, flag, NO_EFFECTS, P, type Props, type Rgb, type Scheme } from "./escher";

/**
 * The text of a legacy `.ppt` (MS-PPT 2.9): the characters, then runs of
 * paragraph and character properties over them, each property either set on
 * the run or inherited from the master's text style for that kind of text and
 * indent level. Read the way LibreOffice reads it (`svdfppt.cxx`), which is
 * where the quirks of PowerPoint 97's own writer are documented by code.
 */

export const RT = {
  textHeader: 0x0f9f,
  textChars: 0x0fa0,
  styleTextProp: 0x0fa1,
  masterTextProp: 0x0fa2,
  textMasterStyle: 0x0fa3,
  textRuler: 0x0fa6,
  textBytes: 0x0fa8,
  slideNumberMC: 0x0fd8,
  dateTimeMC: 0x0ff7,
  genericDateMC: 0x0ff8,
  headerMC: 0x0ff9,
  footerMC: 0x0ffa,
  outlineTextRef: 0x0f9e,
} as const;

/** `TextTypeEnum`, which is also the style sheet a text takes its defaults from. */
export const TEXT = { title: 0, body: 1, notes: 2, other: 4, centerBody: 5, centerTitle: 6, halfBody: 7, quarterBody: 8 } as const;

export type Font = { name: string; charset: number };

// -- properties ---------------------------------------------------------------

/** Paragraph properties; `undefined` = not set here. */
export type PF = {
  bulletFlags?: number;
  bulletFlagsMask?: number;
  bulletChar?: number;
  bulletFont?: number;
  bulletSize?: number;
  bulletColor?: number;
  align?: number;
  lineSpacing?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  leftMargin?: number;
  indent?: number;
  defaultTab?: number;
  tabs?: { pos: number; type: number }[];
};

/** Character properties; `undefined` = not set here. */
export type CF = {
  styleBits?: number;
  styleMask?: number;
  font?: number;
  eaFont?: number;
  symbolFont?: number;
  size?: number;
  color?: number;
  position?: number;
};

type Reader = { buf: Buffer; at: number; end: number };
const u16 = (r: Reader): number => {
  if (r.at + 2 > r.end) throw new RangeError("past the record");
  const v = r.buf.readUInt16LE(r.at);
  r.at += 2;
  return v;
};
const i16 = (r: Reader): number => (u16(r) << 16) >> 16;
const u32 = (r: Reader): number => {
  if (r.at + 4 > r.end) throw new RangeError("past the record");
  const v = r.buf.readUInt32LE(r.at);
  r.at += 4;
  return v;
};

function tabStops(r: Reader): { pos: number; type: number }[] {
  const count = u16(r);
  const out: { pos: number; type: number }[] = [];
  for (let i = 0; i < count; i++) out.push({ pos: u16(r), type: u16(r) });
  return out;
}

/** `TextPFException` as `StyleTextPropAtom` and the master's levels past the
 *  first store it (MS-PPT 2.9.18). */
function readPF(r: Reader): PF {
  const mask = u32(r);
  const pf: PF = {};
  if (mask & 0x0f) {
    pf.bulletFlagsMask = mask & 0x0f;
    pf.bulletFlags = u16(r);
  }
  if (mask & 0x0080) pf.bulletChar = u16(r);
  if (mask & 0x0010) pf.bulletFont = u16(r);
  if (mask & 0x0040) pf.bulletSize = i16(r);
  if (mask & 0x0020) pf.bulletColor = u32(r);
  if (mask & 0x0800) pf.align = u16(r) & 7;
  if (mask & 0x1000) pf.lineSpacing = i16(r);
  if (mask & 0x2000) pf.spaceBefore = i16(r);
  if (mask & 0x4000) pf.spaceAfter = i16(r);
  if (mask & 0x0100) pf.leftMargin = u16(r);
  if (mask & 0x0400) pf.indent = u16(r);
  if (mask & 0x8000) pf.defaultTab = u16(r);
  if (mask & 0x100000) pf.tabs = tabStops(r);
  if (mask & 0x10000) u16(r); // font alignment
  if (mask & 0xe0000) u16(r); // wrap flags
  if (mask & 0x200000) u16(r); // text direction
  return pf;
}

/** The master style's own layout, which is not quite the record's: LibreOffice
 *  reads the first level of instances 0–4 with every mask bit shifted, and the
 *  later levels with the default tab before the margins (`PPTParaSheet::Read`). */
function readMasterPF(r: Reader, first: boolean): PF {
  const mask = u32(r);
  const pf: PF = {};
  if (mask & 0x0f) {
    pf.bulletFlagsMask = mask & 0x0f;
    pf.bulletFlags = u16(r);
  }
  if (mask & 0x0080) pf.bulletChar = u16(r);
  if (mask & 0x0010) pf.bulletFont = u16(r);
  if (mask & 0x0040) pf.bulletSize = i16(r);
  if (mask & 0x0020) pf.bulletColor = u32(r);
  if (first) {
    if (mask & 0x0f00) pf.align = u16(r) & 3;
    if (mask & 0x1000) pf.lineSpacing = i16(r);
    if (mask & 0x2000) pf.spaceBefore = i16(r);
    if (mask & 0x4000) pf.spaceAfter = i16(r);
    if (mask & 0x8000) pf.leftMargin = u16(r);
    if (mask & 0x10000) pf.indent = u16(r);
    if (mask & 0x20000) pf.defaultTab = u16(r);
    if (mask & 0x200000) {
      const count = u16(r);
      for (let i = 0; i < count; i++) u32(r);
    }
    if (mask & 0x40000) u16(r);
    if (mask & 0x80000) u16(r);
    if (mask & 0x100000) u16(r);
  } else {
    if (mask & 0x0800) pf.align = u16(r) & 3;
    if (mask & 0x1000) pf.lineSpacing = i16(r);
    if (mask & 0x2000) pf.spaceBefore = i16(r);
    if (mask & 0x4000) pf.spaceAfter = i16(r);
    if (mask & 0x8000) pf.defaultTab = u16(r);
    if (mask & 0x0100) pf.leftMargin = u16(r);
    if (mask & 0x0200) u16(r);
    if (mask & 0x0400) pf.indent = u16(r);
    if (mask & 0x10000) u16(r);
    if (mask & 0xe0000) u16(r);
    if (mask & 0x100000) {
      const count = u16(r);
      for (let i = 0; i < count; i++) u32(r);
    }
    if (mask & 0x200000) u16(r);
  }
  for (let rest = mask >>> 22; rest; rest >>>= 1) if (rest & 1) u16(r);
  return pf;
}

/** `TextCFException` (MS-PPT 2.9.21). */
function readCF(r: Reader): CF {
  const mask = u32(r);
  const cf: CF = {};
  if (mask & 0xffff) {
    cf.styleMask = mask & 0xffff;
    cf.styleBits = u16(r);
  }
  if (mask & 0x10000) cf.font = u16(r);
  if (mask & 0x200000) cf.eaFont = u16(r);
  if (mask & 0x400000) u16(r); // ANSI typeface
  if (mask & 0x800000) cf.symbolFont = u16(r);
  if (mask & 0x20000) cf.size = u16(r);
  if (mask & 0x40000) cf.color = u32(r);
  if (mask & 0x80000) cf.position = i16(r);
  if (mask & 0x100000) u32(r); // pp10 run id
  if (mask & 0x1000000) u16(r); // new East Asian typeface
  if (mask & 0x2000000) u16(r); // complex script typeface
  if (mask & 0x4000000) u32(r); // pp11 extension
  return cf;
}

const overPF = (own: PF, base: PF): PF => {
  const out: PF = { ...base };
  for (const [k, v] of Object.entries(own) as [keyof PF, never][]) if (v !== undefined) out[k] = v;
  if (own.bulletFlagsMask !== undefined) {
    const mask = own.bulletFlagsMask;
    out.bulletFlags = ((base.bulletFlags ?? 0) & ~mask) | ((own.bulletFlags ?? 0) & mask);
    out.bulletFlagsMask = (base.bulletFlagsMask ?? 0) | mask;
  }
  return out;
};

const overCF = (own: CF, base: CF): CF => {
  const out: CF = { ...base };
  for (const [k, v] of Object.entries(own) as [keyof CF, never][]) if (v !== undefined) out[k] = v;
  if (own.styleMask !== undefined) {
    const mask = own.styleMask;
    out.styleBits = ((base.styleBits ?? 0) & ~mask) | ((own.styleBits ?? 0) & mask);
    out.styleMask = (base.styleMask ?? 0) | mask;
  }
  return out;
};

// -- master styles ------------------------------------------------------------

export type Level = { pf: PF; cf: CF };
/** Five levels per style sheet, by `TextTypeEnum`. */
export type StyleSheets = Map<number, Level[]>;

/** PowerPoint's own defaults, before any master says anything
 *  (`PPTCharSheet`/`PPTParaSheet` constructors). Colours are scheme indices. */
function defaultLevel(type: number): Level {
  const title = type === TEXT.title || type === TEXT.centerTitle;
  const body = type === TEXT.body || type === TEXT.centerBody || type === TEXT.halfBody || type === TEXT.quarterBody;
  const size = title ? 44 : body ? 32 : type === TEXT.notes ? 12 : 24;
  return {
    pf: {
      bulletFlags: body ? 1 : 0,
      bulletChar: 0x2022,
      bulletFont: 0,
      bulletSize: 100,
      bulletColor: title ? 0x03000000 : 0x01000000,
      align: 0,
      lineSpacing: 100,
      spaceBefore: body ? 20 : type === TEXT.notes ? 30 : 0,
      spaceAfter: 0,
      leftMargin: 0,
      indent: 0,
      defaultTab: 0x240,
    },
    cf: { styleBits: 0, font: 0, size, color: title ? 0x03000000 : 0x01000000, position: 0 },
  };
}

/** The style sheets of a main master, with the document's own «other text»
 *  sheet (from the environment), which LibreOffice found to win over the
 *  master's. */
export function readStyleSheets(buf: Buffer, master: { body: number; len: number }, environment: { body: number; len: number } | null): StyleSheets {
  const sheets: StyleSheets = new Map();
  for (const type of [TEXT.title, TEXT.body, TEXT.notes, 3, TEXT.other]) sheets.set(type, Array.from({ length: 5 }, () => defaultLevel(type)));
  const read = (rec: Rec): void => {
    const type = rec.recInstance;
    if (type > 8) return;
    if (type > TEXT.other) {
      const base = type === TEXT.centerTitle ? TEXT.title : TEXT.body;
      sheets.set(type, (sheets.get(base) ?? []).map((l) => ({ pf: { ...l.pf }, cf: { ...l.cf } })));
    }
    const levels = sheets.get(type) ?? Array.from({ length: 5 }, () => defaultLevel(type));
    sheets.set(type, levels);
    const r: Reader = { buf, at: rec.body, end: rec.body + rec.len };
    try {
      const count = Math.min(5, u16(r));
      for (let n = 0; n < count; n++) {
        if (n > 0 && type <= TEXT.other) levels[n] = { pf: { ...levels[n - 1]!.pf }, cf: { ...levels[n - 1]!.cf } };
        let first = n === 0;
        if (type > TEXT.other) {
          first = false;
          u16(r); // the level this entry is for
        }
        const pf = readMasterPF(r, first);
        const cf = readCF(r);
        levels[n] = { pf: overPF(pf, levels[n]!.pf), cf: overCF(cf, levels[n]!.cf) };
      }
    } catch {
      // A truncated style keeps what it got.
    }
  };
  let otherFromEnvironment = false;
  if (environment) {
    const atom = childrenOf(buf, environment).find((c) => c.recType === RT.textMasterStyle);
    if (atom) {
      read({ ...atom, recInstance: TEXT.other });
      otherFromEnvironment = true;
    }
  }
  for (const c of childrenOf(buf, master)) {
    if (c.recType !== RT.textMasterStyle) continue;
    if (c.recInstance === TEXT.other && otherFromEnvironment) continue;
    read(c);
  }
  return sheets;
}

// -- a text's runs --------------------------------------------------------------

type Field = "slideNumber" | "date" | "footer" | "header";

export type TextData = {
  type: number;
  text: string;
  paragraphs: { count: number; level: number; pf: PF }[];
  chars: { count: number; cf: CF }[];
  ruler: Ruler | null;
  /** Field placeholders by character position. */
  fields: Map<number, Field>;
  /** The PowerPoint 2000 paragraph extension (`StyleTextProp9Atom`), which a
   *  character run names by index — autonumbered bullets live here. */
  ext9?: Ext9[];
};

/** What the PowerPoint 2000 extension adds to a paragraph (LibreOffice
 *  `StyleTextProp9`): whether its bullet is a number, and in which scheme. */
export type Ext9 = { mask: number; hasNumber?: number; scheme?: number };

function readExt9Level(r: Reader, withSpecialInfo: boolean): Ext9 {
  const mask = u32(r);
  const ext: Ext9 = { mask };
  if (mask & 0x800000) u16(r); // picture bullet
  if (mask & 0x2000000) ext.hasNumber = u16(r);
  if (mask & 0x1000000) ext.scheme = u32(r);
  if (mask & 0x4000000) u32(r);
  if (u32(r) & 0x100000) u32(r); // character extension
  if (withSpecialInfo) {
    const si = u32(r);
    if (si & 0x20) u32(r);
    if (si & 0x40) u16(r);
  }
  return ext;
}

/** An `ExtendedParagraphAtom` (0x0FAC): one entry per index the runs use. */
export function readExt9(buf: Buffer, rec: Rec): Ext9[] {
  const r: Reader = { buf, at: rec.body, end: rec.body + rec.len };
  const out: Ext9[] = [];
  try {
    while (r.at < r.end) out.push(readExt9Level(r, true));
  } catch {
    // A short entry ends the list.
  }
  return out;
}

/** An `ExtendedParagraphMasterAtom` (0x0FAD): the master's levels for one kind of text. */
export function readExt9Master(buf: Buffer, rec: Rec): Ext9[] {
  const r: Reader = { buf, at: rec.body, end: rec.body + rec.len };
  const out: Ext9[] = [];
  try {
    const count = Math.min(5, u16(r));
    for (let i = 0; i < count; i++) out.push(readExt9Level(r, false));
  } catch {
    // What was read stands.
  }
  return out;
}

export type Ruler = { defaultTab?: number; tabs?: { pos: number; type: number }[]; leftMargin: (number | undefined)[]; indent: (number | undefined)[] };

export function readRuler(buf: Buffer, rec: Rec): Ruler | null {
  const r: Reader = { buf, at: rec.body, end: rec.body + rec.len };
  try {
    const mask = u32(r);
    const ruler: Ruler = { leftMargin: [], indent: [] };
    if (mask & 0x2) u16(r); // cLevels
    if (mask & 0x1) ruler.defaultTab = u16(r);
    if (mask & 0x4) ruler.tabs = tabStops(r);
    for (let n = 0; n < 5; n++) {
      if (mask & (0x8 << n)) ruler.leftMargin[n] = u16(r);
      if (mask & (0x100 << n)) ruler.indent[n] = u16(r);
    }
    return ruler;
  } catch {
    return null;
  }
}

/** Reads one text from the records that make it up: a `TextHeaderAtom` and
 *  what follows it, up to the next header (a placeholder's text in the slide
 *  list) or the end of a shape's client textbox. */
export function readTextRecords(buf: Buffer, records: Rec[]): TextData | null {
  const header = records.find((r) => r.recType === RT.textHeader);
  let text: string | null = null;
  const fields = new Map<number, Field>();
  let style: Rec | undefined;
  let ruler: Ruler | null = null;
  for (const r of records) {
    if (r.recType === RT.textChars) text = buf.toString("utf16le", r.body, r.body + (r.len & ~1));
    else if (r.recType === RT.textBytes) text = buf.toString("latin1", r.body, r.body + r.len);
    else if (r.recType === RT.styleTextProp) style = r;
    else if (r.recType === RT.textRuler) ruler = readRuler(buf, r);
    else if (r.len >= 4 && (r.recType === RT.slideNumberMC || r.recType === RT.dateTimeMC || r.recType === RT.genericDateMC)) {
      fields.set(buf.readInt32LE(r.body), r.recType === RT.slideNumberMC ? "slideNumber" : "date");
    } else if (r.len >= 4 && r.recType === RT.footerMC) fields.set(buf.readInt32LE(r.body), "footer");
    else if (r.len >= 4 && r.recType === RT.headerMC) fields.set(buf.readInt32LE(r.body), "header");
  }
  if (text === null) return null;
  const type = header && header.len >= 4 ? buf.readUInt32LE(header.body) : TEXT.other;
  const paragraphs: TextData["paragraphs"] = [];
  const chars: TextData["chars"] = [];
  if (style) {
    const r: Reader = { buf, at: style.body, end: style.body + style.len };
    const total = text.length + 1;
    try {
      for (let seen = 0; seen < total && r.at < r.end; ) {
        const count = u32(r);
        const level = u16(r);
        const pf = readPF(r);
        paragraphs.push({ count, level: Math.min(4, level), pf });
        seen += Math.max(1, count);
      }
      for (let seen = 0; seen < total && r.at < r.end; ) {
        const count = u32(r);
        chars.push({ count, cf: readCF(r) });
        seen += Math.max(1, count);
      }
    } catch {
      // Runs past the record: what was read stands.
    }
  }
  return { type, text, paragraphs, chars, ruler, fields };
}

// -- into the model ---------------------------------------------------------------

export type TextContext = {
  sheets: StyleSheets;
  fonts: Font[];
  scheme: Scheme;
  /** The slide's number, footer and date, for fields. */
  slideNumber: number;
  footer: string | null;
  date: string | null;
  /** The master's PowerPoint 2000 levels, by kind of text. */
  ext9Master?: Map<number, Ext9[]>;
  miss: (what: string) => void;
};

/** A `ColorIndexStruct`: an RGB, or one of the scheme's colours. */
function textColor(value: number | undefined, scheme: Scheme): Rgb | null {
  if (value === undefined) return null;
  const index = value >>> 24;
  if (index === 0xfe) return { r: value & 0xff, g: (value >>> 8) & 0xff, b: (value >>> 16) & 0xff };
  if (index < 8) return scheme[index] ?? null;
  return null;
}

/** Master units → EMU. */
const mu = (v: number): number => v * EMU_PER_MASTER;

/** Negative spacing is absolute, in master units (8 per point). */
const spacing = (v: number | undefined, fallback: number): { pct: number } | { pts: number } => {
  const n = v ?? fallback;
  return n < 0 ? { pts: -n / 8 } : { pct: n / 100 };
};

const ALIGN: Paragraph["align"][] = ["l", "ctr", "r", "just", "dist", "dist", "just"];

/** The text body a shape draws, its frame properties from the shape's own. */
export function textBody(data: TextData, props: Props, ctx: TextContext, extra: { shadowOverride?: Effects } = {}): TextBody {
  const sheet = ctx.sheets.get(data.type) ?? ctx.sheets.get(TEXT.other) ?? Array.from({ length: 5 }, () => defaultLevel(data.type));
  // Characters with their fields filled in, then split into paragraphs.
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < data.text.length; i++) {
    const field = data.fields.get(i);
    const value =
      field === "slideNumber"
        ? String(ctx.slideNumber)
        : field === "footer"
          ? (ctx.footer ?? "")
          : field === "date"
            ? (ctx.date ?? "")
            : field === "header"
              ? ""
              : data.text[i]!;
    for (let k = 0; k < value.length; k++) map.push(i);
    text += value;
  }
  map.push(data.text.length);

  // Property runs are counted on the original characters.
  const pfAt = (index: number): { level: number; pf: PF } => {
    let pos = 0;
    for (const p of data.paragraphs) {
      if (index < pos + p.count) return p;
      pos += p.count;
    }
    return data.paragraphs[data.paragraphs.length - 1] ?? { level: 0, pf: {} };
  };
  const cfAt = (index: number): CF => {
    let pos = 0;
    for (const c of data.chars) {
      if (index < pos + c.count) return c.cf;
      pos += c.count;
    }
    return data.chars[data.chars.length - 1]?.cf ?? {};
  };

  const paragraphs: Paragraph[] = [];
  let start = 0;
  const lines = text.split("\r");
  const counters: number[] = [];
  for (const line of lines) {
    const origStart = map[start] ?? data.text.length;
    const { level, pf: ownPF } = pfAt(origStart);
    const base = sheet[level] ?? sheet[0]!;
    const pf = overPF(ownPF, withRuler(base.pf, data.ruler, level));
    const runs: TextRun[] = [];
    let endSize = base.cf.size ?? 18;
    let current: { cf: CF; text: string } | null = null;
    const flush = (): void => {
      if (current && current.text) runs.push(...textRuns(current.text, overCF(current.cf, base.cf), ctx, extra));
      current = null;
    };
    for (let i = 0; i < line.length; i++) {
      const cf = cfAt(map[start + i] ?? 0);
      const ch = line[i]!;
      if (ch === "\u000b") {
        flush();
        runs.push({ kind: "break", size: overCF(cf, base.cf).size ?? 18 });
        continue;
      }
      if (!current || current.cf !== cf) {
        flush();
        current = { cf, text: "" };
      }
      current.text += ch;
    }
    flush();
    const endCf = overCF(cfAt(map[start + line.length] ?? data.text.length), base.cf);
    endSize = endCf.size ?? endSize;
    paragraphs.push({
      align: ALIGN[pf.align ?? 0] ?? "l",
      marginLeft: mu(pf.leftMargin ?? 0),
      indent: mu((pf.indent ?? 0) - (pf.leftMargin ?? 0)),
      lineSpacing: spacing(pf.lineSpacing, 100),
      spaceBefore: spacing(pf.spaceBefore, 0),
      spaceAfter: spacing(pf.spaceAfter, 0),
      rtl: false,
      bullet: line.length > 0 ? numbered(bullet(pf, runs, ctx), numberOf(data, ctx, cfAt(origStart), level, (pf.bulletFlags ?? 0) & 1, counters)) : null,
      runs,
      endSize,
      tabs: (pf.tabs ?? []).map((t) => ({ pos: mu(t.pos), align: t.type === 1 ? "ctr" : t.type === 2 ? "r" : t.type === 3 ? "dec" : "l" })),
      defaultTab: mu(pf.defaultTab ?? 0x240),
    });
    start += line.length + 1;
  }

  const v = (id: number, fallback: number): number => props.simple.get(id) ?? fallback;
  const anchorText = v(P.anchorText, 0);
  const flow = v(P.txflTextFlow, 0);
  return {
    insets: { l: v(P.dxTextLeft, 91440) | 0, t: v(P.dyTextTop, 45720) | 0, r: v(P.dxTextRight, 91440) | 0, b: v(P.dyTextBottom, 45720) | 0 },
    anchor: [1, 4].includes(anchorText) ? "ctr" : [2, 5, 7, 9].includes(anchorText) ? "b" : "t",
    anchorCenter: anchorText >= 3 && anchorText <= 5,
    wrap: v(P.wrapText, 0) !== 2,
    vertical: flow === 1 || flow === 3 || flow === 5 ? "vert" : flow === 2 ? "vert270" : "horz",
    autofit: flag(props, P.textBooleans, 0x02) ? { kind: "shape" } : { kind: "none" },
    columns: { count: 1, spacing: 0 },
    rotation: 0,
    upright: false,
    paragraphs,
  };
}

/** A ruler's per-level margins sit between the master style and the run. */
function withRuler(pf: PF, ruler: Ruler | null, level: number): PF {
  if (!ruler) return pf;
  const out = { ...pf };
  if (ruler.leftMargin[level] !== undefined) out.leftMargin = ruler.leftMargin[level];
  if (ruler.indent[level] !== undefined) out.indent = ruler.indent[level];
  if (ruler.defaultTab !== undefined) out.defaultTab = ruler.defaultTab;
  if (ruler.tabs) out.tabs = ruler.tabs;
  return out;
}

function fontName(ctx: TextContext, index: number | undefined): Font | null {
  return index === undefined ? null : (ctx.fonts[index] ?? null);
}

const SYMBOL_CHARSET = 2;

function textRuns(text: string, cf: CF, ctx: TextContext, extra: { shadowOverride?: Effects }): TextRun[] {
  const bits = cf.styleBits ?? 0;
  const face = fontName(ctx, cf.font);
  const ea = fontName(ctx, cf.eaFont);
  const c = textColor(cf.color, ctx.scheme) ?? ctx.scheme[1] ?? { r: 0, g: 0, b: 0 };
  const size = cf.size ?? 18;
  let effects = NO_EFFECTS;
  if (extra.shadowOverride) effects = extra.shadowOverride;
  else if (bits & 0x10 || bits & 0x200) {
    // PowerPoint 97's text shadow, as PowerPoint itself carries it into a
    // .pptx: the scheme's shadow colour, 3 pt down-right at 45°, 3 pt blur.
    const shadow = ctx.scheme[2] ?? { r: 128, g: 128, b: 128 };
    effects = { ...NO_EFFECTS, shadow: { color: cssColor(shadow), blur: 38100, dist: 38100, dir: 45, inner: false, sx: 1, sy: 1 } };
  }
  const out: TextRun[] = [];
  for (const [i, piece] of text.split("\t").entries()) {
    if (i > 0) out.push(run("\t"));
    if (piece) out.push(run(piece));
  }
  return out;

  function run(t: string): TextRun {
    return {
      kind: "text",
      text: face?.charset === SYMBOL_CHARSET ? [...t].map((ch) => SYMBOL_BULLETS[ch] ?? ch).join("") : t,
      font: fontList(face?.name || "Arial", ea?.name ?? null),
      size,
      bold: (bits & 0x01) !== 0,
      italic: (bits & 0x02) !== 0,
      underline: (bits & 0x04) !== 0,
      strike: false,
      caps: "none",
      baseline: cf.position ?? 0,
      spacing: 0,
      fill: { kind: "solid", color: cssColor(c) },
      outline: null,
      highlight: null,
      effects,
    };
  }
}

function bullet(pf: PF, runs: TextRun[], ctx: TextContext): Bullet | null {
  const flags = pf.bulletFlags ?? 0;
  if (!(flags & 1)) return null;
  const face = flags & 2 ? fontName(ctx, pf.bulletFont) : null;
  let char = String.fromCharCode(pf.bulletChar ?? 0x2022);
  if (face?.charset === SYMBOL_CHARSET || (face && /wingdings|symbol/i.test(face.name))) char = SYMBOL_BULLETS[String.fromCharCode((pf.bulletChar ?? 0) & 0xff)] ?? SYMBOL_BULLETS[char] ?? "•";
  const firstColor = runs.find((r) => r.kind === "text");
  const c = flags & 4 ? textColor(pf.bulletColor, ctx.scheme) : null;
  const size = flags & 8 && pf.bulletSize !== undefined ? (pf.bulletSize < 0 ? { pts: -pf.bulletSize } : { pct: pf.bulletSize / 100 }) : { pct: 1 };
  return {
    kind: "char",
    char,
    font: face && face.charset !== SYMBOL_CHARSET ? fontList(face.name, null) : null,
    color: c ? cssColor(c) : firstColor && firstColor.kind === "text" && firstColor.fill?.kind === "solid" ? firstColor.fill.color : null,
    size,
  };
}

/** The document's fonts (`FontCollection`), by index. */
export function readFonts(buf: Buffer, environment: { body: number; len: number } | null): Font[] {
  if (!environment) return [];
  const collection = childrenOf(buf, environment).find((c) => c.recType === 0x07d5);
  if (!collection) return [];
  const fonts: Font[] = [];
  for (const entity of childrenOf(buf, collection)) {
    if (entity.recType !== 0x0fb7 || entity.len < 68) continue;
    const name = buf.toString("utf16le", entity.body, entity.body + 64).replace(/\0.*$/s, "");
    fonts[entity.recInstance] = { name, charset: buf[entity.body + 64]! };
  }
  return fonts;
}

/** The paragraph's number when its bullet is an autonumber (the PowerPoint
 *  2000 extension, over the master's level), counted along consecutive
 *  numbered paragraphs of its level; `null` for a plain bullet. */
function numberOf(data: TextData, ctx: TextContext, cf: CF, level: number, bulletOn: number, counters: number[]): string | null {
  const index = cf.styleMask !== undefined && cf.styleMask & 0x3c00 ? ((cf.styleBits ?? 0) & 0x3c00) >> 10 : 0;
  const own = data.ext9?.[index];
  const master = ctx.ext9Master?.get(data.type)?.[level];
  let hasNumber = own?.mask !== undefined && own.mask & 0x2000000 ? own.hasNumber : undefined;
  let scheme = own?.mask !== undefined && own.mask & 0x1000000 ? own.scheme : undefined;
  if (master && ((own?.mask ?? 0) & 0x03800000) !== 0x03800000) {
    if (hasNumber === undefined && master.mask & 0x2000000) hasNumber = master.hasNumber;
    if (scheme === undefined && master.mask & 0x1000000) scheme = master.scheme;
  }
  counters.length = Math.min(counters.length, level + 1);
  if (!bulletOn || !hasNumber) {
    counters.length = level;
    return null;
  }
  const s = scheme ?? 0xffff0003;
  const start = s >>> 16 > 0 && s >>> 16 < 0x8000 ? s >>> 16 : 1;
  const n = counters[level] === undefined ? start : counters[level] + 1;
  counters[level] = n;
  return formatNumber(n, s & 0xffff);
}

const roman = (n: number): string => {
  const table: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [v, s] of table) for (; n >= v; n -= v) out += s;
  return out;
};
const alpha = (n: number): string => {
  let out = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(97 + ((n - 1) % 26)) + out;
  return out;
};

/** `TextAutoNumberSchemeEnum` (MS-PPT), the Latin ones; others count in Arabic. */
function formatNumber(n: number, scheme: number): string {
  const forms: Record<number, [(n: number) => string, string, string]> = {
    0: [alpha, "", "."], 1: [(x) => alpha(x).toUpperCase(), "", "."], 2: [String, "", ")"], 3: [String, "", "."],
    4: [roman, "(", ")"], 5: [roman, "", ")"], 6: [roman, "", "."], 7: [(x) => roman(x).toUpperCase(), "", "."],
    8: [alpha, "(", ")"], 9: [alpha, "", ")"], 10: [(x) => alpha(x).toUpperCase(), "(", ")"], 11: [(x) => alpha(x).toUpperCase(), "", ")"],
    12: [String, "(", ")"], 13: [String, "", ""], 14: [(x) => roman(x).toUpperCase(), "(", ")"], 15: [(x) => roman(x).toUpperCase(), "", ")"],
  };
  const [f, before, after] = forms[scheme] ?? forms[3]!;
  return `${before}${f(n)}${after}`;
}

function numbered(b: Bullet | null, number: string | null): Bullet | null {
  if (!b || number === null || b.kind !== "char") return b;
  // The number is set in the text's face, not the bullet font.
  return { ...b, char: number, font: null };
}
