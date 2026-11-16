import { metricTwin } from "@shared/font-twins";
import type {
  Chart3D,
  ChartAxis,
  ChartBox,
  ChartDataLabel,
  ChartFont,
  ChartLayout,
  ChartMarker,
  ChartModel,
  ChartPlot,
  ChartSeries,
  ChartText,
  ChartTitle,
} from "@shared/types/slide-chart";
import type { Effects, Fill, Line, SlideTextSettings } from "@shared/types/slide-model";
import { useContext, useId, type ReactNode } from "react";
import { SlideTextContext, strokeProps, svgPaint, type PaintContext, type ResolvePart } from "./slide-paint";

type Chart = Extract<ChartModel, { kind: "chart" }>;
type Rect = { x: number; y: number; w: number; h: number };

const PT = 12700;

/**
 * A chart in its box (`w × h`, EMU of the slide), laid out the way Office
 * lays it out — title, legend, axis labels and plot area sized from the text
 * they hold — and drawn as one SVG in EMU. Text is measured with the advance
 * widths of the faces charts are written in (Calibri and Arial, through their
 * metric twins), so the layout needs no fonts loaded and no second pass.
 * Picture fills are drawn when `resolve` is given (parts → URLs), else left out.
 */
export function SlideChart({
  chart,
  w,
  h,
  resolve,
}: {
  chart: ChartModel;
  w: number;
  h: number;
  slideWidth: number;
  resolve?: ResolvePart;
}): ReactNode {
  slideText = useContext(SlideTextContext);
  const id = useId().replace(/:/g, "");
  if (chart.kind === "unsupported" || w <= 0 || h <= 0) return null;
  const layout = layoutChart(chart, w, h);
  const out: ReactNode[] = [];
  const defs: ReactNode[] = [];
  let n = 0;
  const key = (): string => `${id}-${n++}`;
  const paint = paintWith(defs, key, resolve ?? null);

  out.push(paint.box(chart.space, { x: 0, y: 0, w, h }));
  const plotRect = layout.plot?.inner ?? layout.plotRect;
  if (plotRect) out.push(paint.box(chart.plotArea, plotRect));
  if (layout.plot) out.push(...drawAxesBehind(layout.plot, key));
  if (layout.plot?.second) out.push(...drawAxesBehind({ ...layout.plot.second, cat: null }, key));
  if (layout.radar) out.push(...drawRadarBehind(chart, layout.radar, key));
  if (layout.box3d) out.push(...draw3DBehind(layout.box3d, paint, key));
  chart.plots.forEach((p, i) => out.push(drawPlot(p, chart, onAxes(chart, layout, i), paint)));
  if (layout.plot) out.push(...drawAxesFront(layout.plot, key));
  if (layout.plot?.second) out.push(...drawAxesFront({ ...layout.plot.second, cat: null }, key));
  if (layout.radar) out.push(...drawRadarFront(chart, layout.radar, key));
  if (layout.box3d) out.push(...draw3DFront(layout.box3d, key));
  out.push(...drawDataLabels(chart, layout, paint, key));
  if (layout.legend) out.push(drawLegend(chart, layout.legend, paint, key));
  if (layout.title) out.push(drawText(layout.title.block, layout.title, 0, key()));
  for (const t of layout.axisTitles) out.push(drawText(t.title.text, t.rect, t.rotation, key()));

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
      <defs>{defs}</defs>
      {out}
    </svg>
  );
}

/** The layout plot `i` is drawn in: a combo's second scale for its plots there. */
function onAxes(chart: Chart, layout: Layout, i: number): Layout {
  const second = layout.plot?.second;
  return second && chart.secondary?.plots.includes(i) ? { ...layout, plot: second } : layout;
}

// ── Text ────────────────────────────────────────────────────────────────────

/** Advance widths (‰ of the em) of U+0020..U+007E: Carlito and Liberation
 *  Sans, metric twins of Calibri and Arial. */
const WIDTHS: Record<"calibri" | "calibriBold" | "arial" | "arialBold", number[]> = {
  calibri: [226,326,401,498,507,715,682,221,303,303,498,498,250,306,252,386,507,507,507,507,507,507,507,507,507,507,268,268,498,498,498,463,894,579,544,533,615,488,459,631,623,252,319,520,420,855,646,662,517,673,543,459,487,642,567,890,519,487,468,307,386,307,498,498,291,479,525,423,525,498,305,471,525,229,239,455,229,799,525,527,525,525,349,391,335,525,452,715,433,453,395,314,460,314,498],
  calibriBold: [226,326,438,498,507,729,705,233,312,312,498,498,258,306,267,430,507,507,507,507,507,507,507,507,507,507,276,276,498,498,498,463,898,606,561,529,630,488,459,637,631,267,331,547,423,874,659,676,532,686,563,473,495,653,591,906,551,520,478,325,430,325,498,498,300,494,537,418,537,503,316,474,537,246,255,480,246,813,537,538,537,537,355,399,347,537,473,745,459,474,397,344,475,344,498],
  arial: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
  arialBold: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584],
};

/** Calibri-like faces measure as Calibri; everything else as Arial. */
const isCalibri = (face: string): boolean => /calibri|carlito|candara|corbel|segoe/i.test(face);

/** Ascent and descent (em) of the face's line. */
const metrics = (font: ChartFont): [number, number] => (isCalibri(font.face) ? [0.952, 0.269] : [0.905, 0.212]);

/** Faces measured from tables: Calibri and Arial and their metric twins
 *  (loaded as web fonts, so not measurable until they load). */
const tabled = (face: string): boolean => isCalibri(face) || /^(arial|liberation sans|arimo|helvetica)$/i.test(face);

let canvas: CanvasRenderingContext2D | null | undefined;
const measures = new Map<string, number | null>();

/** Any other face is a system font, there at once: the browser measures it.
 *  `null` when it isn't installed (it measures as the fallback). */
function measureFace(text: string, font: ChartFont): number | null {
  const key = `${font.face}|${font.bold}|${font.italic}|${text}`;
  const known = measures.get(key);
  if (known !== undefined) return known;
  if (canvas === undefined) canvas = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  let out: number | null = null;
  if (canvas) {
    const style = `${font.italic ? "italic " : ""}${font.bold ? 700 : 400} 100px`;
    canvas.font = `${style} "${font.face.replace(/"/g, "")}", monospace`;
    const own = canvas.measureText(text).width;
    canvas.font = `${style} monospace`;
    if (own !== canvas.measureText(text).width) out = own / 100;
  }
  if (measures.size > 5000) measures.clear();
  measures.set(key, out);
  return out;
}

function textWidth(text: string, font: ChartFont): number {
  const measured = tabled(font.face) ? null : measureFace(text, font);
  if (measured !== null) return measured * font.size * PT;
  const table = WIDTHS[`${isCalibri(font.face) ? "calibri" : "arial"}${font.bold ? "Bold" : ""}`];
  let units = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 32;
    units += c >= 32 && c < 127 ? (table[c - 32] ?? 500) : c >= 0x2e80 ? 1000 : 520;
  }
  return (units / 1000) * font.size * PT;
}

const lineHeight = (font: ChartFont): number => (metrics(font)[0] + metrics(font)[1]) * font.size * PT;

function cssFamily(face: string): string {
  const twin = metricTwin(face);
  const last = isCalibri(face) ? "Carlito" : (slideText.fallbackFont ?? "Liberation Sans");
  return [face, ...(twin ? [twin] : []), last].map((f) => `"${f.replace(/"/g, "")}"`).join(", ") + ", sans-serif";
}

/**
 * The window's `SlideTextContext`, set by `SlideChart` as it renders, for the
 * formatters and font lists deep in this file.
 * ponytail: module state instead of a parameter through every formatter — a
 * window has one value (its interface's), so two charts never disagree. Pass
 * it down if a window ever draws slides in two languages at once.
 */
let slideText: SlideTextSettings = { fallbackFont: null, locale: "" };

/** A block of text: lines (paragraphs, or a label broken to fit), each a
 *  list of runs. */
type Block = { lines: { align: "l" | "ctr" | "r"; runs: { text: string; font: ChartFont }[] }[]; w: number; h: number };

/** Rich text as lines, each paragraph broken at spaces to `maxWidth`. */
function block(text: ChartText, maxWidth = Infinity): Block {
  const lines: Block["lines"] = [];
  for (const p of text) {
    let line: Block["lines"][number]["runs"] = [];
    let width = 0;
    for (const r of p.runs) {
      for (const word of r.text.split(/(?<= )/)) {
        const w = textWidth(word, r.font);
        if (line.length && width + textWidth(word.trimEnd(), r.font) > maxWidth) {
          lines.push({ align: p.align, runs: trimLine(line) });
          line = [];
          width = 0;
        }
        const last = line[line.length - 1];
        if (last && last.font === r.font) last.text += word;
        else line.push({ text: word, font: r.font });
        width += w;
      }
    }
    lines.push({ align: p.align, runs: line.length ? trimLine(line) : p.runs });
  }
  return measured(lines);
}

function trimLine(runs: Block["lines"][number]["runs"]): Block["lines"][number]["runs"] {
  const last = runs[runs.length - 1];
  return last ? [...runs.slice(0, -1), { ...last, text: last.text.trimEnd() }] : runs;
}

/** Office breaks a title to 80% of the chart's width. */
const TITLE_WIDTH = 0.8;

function measured(lines: Block["lines"]): Block {
  let w = 0;
  let h = 0;
  for (const l of lines) {
    w = Math.max(w, l.runs.reduce((s, r) => s + textWidth(r.text, r.font), 0));
    h += Math.max(...l.runs.map((r) => lineHeight(r.font)), 0);
  }
  return { lines, w, h };
}

function plainBlock(text: string, font: ChartFont, maxWidth = Infinity, align: "l" | "ctr" | "r" = "ctr"): Block {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (textWidth(para, font) <= maxWidth) {
      out.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, font) > maxWidth) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return measured(out.map((t) => ({ align, runs: [{ text: t, font }] })));
}

/** A block drawn in `rect`, rotated about its centre by `rotation` degrees. */
function drawText(text: ChartText | Block, rect: Rect, rotation: number, k: string): ReactNode {
  const b = Array.isArray(text) ? block(text) : text;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let y = cy - b.h / 2;
  return (
    <g key={k} transform={rotation ? `rotate(${rotation} ${cx} ${cy})` : undefined}>
      {b.lines.map((l, i) => {
        const font = l.runs[0]?.font;
        if (!font) return null;
        const lh = Math.max(...l.runs.map((r) => lineHeight(r.font)));
        const base = y + metrics(font)[0] * Math.max(...l.runs.map((r) => r.font.size)) * PT;
        y += lh;
        const lw = l.runs.reduce((s, r) => s + textWidth(r.text, r.font), 0);
        const x = l.align === "l" ? cx - b.w / 2 : l.align === "r" ? cx + b.w / 2 - lw : cx - lw / 2;
        return svgText(l.runs, x, base, "start", null, String(i));
      })}
    </g>
  );
}

/**
 * Text at a baseline point (EMU). Drawn in POINTS inside a `scale(PT)`:
 * Chromium clamps a font size of a few hundred thousand user units, so EMU
 * sizes come out a pixel tall.
 */
function svgText(
  runs: { text: string; font: ChartFont }[],
  x: number,
  y: number,
  anchor: "start" | "middle" | "end",
  rotate: [number, number, number] | null,
  k: string,
): ReactNode {
  const transform = `${rotate ? `rotate(${rotate[0]} ${rotate[1]} ${rotate[2]}) ` : ""}scale(${PT})`;
  return (
    <text key={k} x={x / PT} y={y / PT} textAnchor={anchor} transform={transform} style={{ whiteSpace: "pre" }}>
      {runs.map((r, j) => (
        <tspan key={j} {...fontProps(r.font)}>
          {r.text}
        </tspan>
      ))}
    </text>
  );
}

function fontProps(font: ChartFont): Record<string, string | number> {
  return {
    fontFamily: cssFamily(font.face),
    fontSize: font.size,
    fontWeight: font.bold ? 700 : 400,
    fontStyle: font.italic ? "italic" : "normal",
    textDecoration: font.underline ? "underline" : "none",
    fill: font.color,
  };
}

/** One line of plain text with its baseline placed for a box whose top is `top`. */
function label(text: string, font: ChartFont, x: number, top: number, anchor: "start" | "middle" | "end", k: string): ReactNode {
  return svgText([{ text, font }], x, top + metrics(font)[0] * font.size * PT, anchor, null, k);
}

// ── Number formats ──────────────────────────────────────────────────────────

/** The separators of the interface's language. PowerPoint writes numbers with
 *  the system region's, whatever language the file was made in; the owner
 *  chose the interface's (2026-10-28), which a new install takes from the
 *  system anyway. */
const separatorsByLocale = new Map<string, { decimal: string; group: string }>();
function separators(): { decimal: string; group: string } {
  let found = separatorsByLocale.get(slideText.locale);
  if (!found) {
    const parts = new Intl.NumberFormat(slideText.locale || undefined).formatToParts(12345.6);
    found = { decimal: parts.find((p) => p.type === "decimal")?.value ?? ".", group: parts.find((p) => p.type === "group")?.value ?? "," };
    separatorsByLocale.set(slideText.locale, found);
  }
  return found;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A cached value through an Excel number format: the common subset —
 *  General, digits, grouping, decimals, percent, scaling commas, literals,
 *  sections, and dates. */
function formatValue(value: number | string | null, code: string, date1904 = false): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  const sections = splitSections(code);
  let section = sections[0] ?? "General";
  let v = value;
  if (v < 0 && sections.length > 1) {
    section = sections[1]!;
    v = -v;
  } else if (v === 0 && sections.length > 2) section = sections[2]!;
  // Colours, conditions and locale tags; a currency tag keeps its symbol.
  section = section.replace(/\[\$([^\]-]*)(-[^\]]*)?\]/g, (_m, sym: string) => (sym ? `"${sym}"` : "")).replace(/\[[^\]]*\]/g, "");
  if (/^\s*general\s*$/i.test(section) || section.trim() === "") return (v < 0 ? "-" : "") + general(Math.abs(v));
  const bare = section.replace(/"[^"]*"|\\.|_.|\*./g, "");
  if (/^m\/d\/yy(yy)?$/i.test(section.trim())) return shortDate(v, date1904);
  if (/[dmyhs]/i.test(bare.replace(/E[+-]/gi, ""))) return formatDate(v, section, date1904);
  return formatNumber(v, section, sections.length > 1 && value < 0);
}

function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"') quoted = !quoted;
    if (c === "\\" && !quoted) {
      cur += c + (code[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === ";" && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function general(v: number): string {
  if (v === 0) return "0";
  if (v >= 1e11 || v < 1e-9) return v.toExponential(5).replace(/\.?0+e/, "E").replace(".", separators().decimal);
  const digits = Math.max(0, 10 - Math.max(0, Math.floor(Math.log10(v)) + 1));
  const s = v.toFixed(Math.min(digits, 10)).replace(/\.?0+$/, "");
  return s.replace(".", separators().decimal);
}

function formatNumber(value: number, section: string, signDone: boolean): string {
  // Literal pieces vs the number's own placeholders.
  let num = "";
  let numDone = false;
  const pieces: ({ lit: string } | { num: true })[] = [];
  let lit = "";
  const flushLit = (): void => {
    if (lit) pieces.push({ lit });
    lit = "";
  };
  for (let i = 0; i < section.length; i++) {
    const c = section[i]!;
    if (c === '"') {
      const end = section.indexOf('"', i + 1);
      lit += section.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? section.length : end;
    } else if (c === "\\") {
      lit += section[i + 1] ?? "";
      i++;
    } else if (c === "_") {
      lit += " ";
      i++;
    } else if (c === "*") i++;
    else if (!numDone && /[0#?.,]/.test(c) && (/[0#?]/.test(c) || num !== "" || /[0#?]/.test(section[i + 1] ?? ""))) {
      if (num === "") {
        flushLit();
        pieces.push({ num: true });
      }
      num += c;
      if (/[eE]/.test(section[i + 1] ?? "")) numDone = true;
    } else if ((c === "E" || c === "e") && num !== "" && /[+-]/.test(section[i + 1] ?? "")) {
      num += section.slice(i, i + 2);
      i++;
      while (/[0#?]/.test(section[i + 1] ?? "")) num += section[++i];
      numDone = true;
    } else {
      if (num !== "") numDone = true;
      lit += c;
    }
  }
  flushLit();

  let v = value;
  const percents = (section.replace(/"[^"]*"|\\./g, "").match(/%/g) ?? []).length;
  v *= Math.pow(100, percents);
  const exp = num.match(/[eE][+-]([0#?]+)$/);
  const mantissa = exp ? num.slice(0, exp.index) : num;
  const trailing = mantissa.match(/,+$/)?.[0].length ?? 0;
  const body = mantissa.slice(0, mantissa.length - trailing);
  v /= Math.pow(1000, trailing);
  const [intPart = "", fracPart = ""] = body.split(".");
  const decimals = (fracPart.match(/[0#?]/g) ?? []).length;
  const minDecimals = (fracPart.match(/0/g) ?? []).length;
  const minInt = (intPart.match(/0/g) ?? []).length;
  const grouped = /[0#?],[0#?]/.test(intPart);

  const neg = v < 0 && !signDone;
  let a = Math.abs(v);
  let expText = "";
  if (exp) {
    const e = a === 0 ? 0 : Math.floor(Math.log10(a));
    a /= Math.pow(10, e);
    expText = `E${e < 0 ? "-" : num.includes("E+") || num.includes("e+") ? "+" : ""}${String(Math.abs(e)).padStart(exp[1]!.length, "0")}`;
  }
  let [i = "0", f = ""] = a.toFixed(decimals).split(".");
  while (f.length > minDecimals && f.endsWith("0")) f = f.slice(0, -1);
  if (i === "0" && minInt === 0) i = "";
  i = i.padStart(minInt, "0");
  if (grouped) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, separators().group);
  const text = (f ? `${i}${separators().decimal}${f}` : i) + expText;
  return (neg ? "-" : "") + pieces.map((p) => ("lit" in p ? p.lit : text)).join("");
}

function serialDate(serial: number, date1904: boolean): Date {
  const ms = date1904 ? Date.UTC(1904, 0, 1) + serial * 86400000 : Date.UTC(1899, 11, 30) + serial * 86400000;
  return new Date(Math.round(ms / 1000) * 1000);
}

/** `m/d/yy` is Excel's built-in short date (format 14): Office writes it in
 *  the system's short date, not as spelled (`05/01/2002` in en-GB). */
const shortDates = new Map<string, Intl.DateTimeFormat>();
function shortDate(serial: number, date1904: boolean): string {
  let format = shortDates.get(slideText.locale);
  if (!format) {
    format = new Intl.DateTimeFormat(slideText.locale || undefined, { day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC" });
    shortDates.set(slideText.locale, format);
  }
  return format.format(serialDate(serial, date1904));
}

function formatDate(serial: number, section: string, date1904: boolean): string {
  const d = serialDate(serial, date1904);
  const ampm = /AM\/PM|A\/P/i.test(section);
  let out = "";
  let lastWasHour = false;
  for (let i = 0; i < section.length; ) {
    const rest = section.slice(i);
    const c = section[i]!;
    if (c === '"') {
      const end = section.indexOf('"', i + 1);
      out += section.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? section.length : end + 1;
      continue;
    }
    if (c === "\\") {
      out += section[i + 1] ?? "";
      i += 2;
      continue;
    }
    const run = rest.match(/^(y+|m+|d+|h+|s+|AM\/PM|A\/P)/i)?.[0];
    if (!run) {
      out += c === "_" || c === "*" ? "" : c;
      i += c === "_" || c === "*" ? 2 : 1;
      continue;
    }
    const t = run.toLowerCase();
    // `m`/`mm` are minutes right after an hour or right before seconds.
    const minuteContext = lastWasHour || /^m{1,2}[^a-z]*s/i.test(rest);
    if (t[0] === "y") out += t.length <= 2 ? String(d.getUTCFullYear()).slice(-2) : String(d.getUTCFullYear());
    else if (t[0] === "m" && minuteContext && t.length <= 2) out += String(d.getUTCMinutes()).padStart(t.length, "0");
    else if (t[0] === "m") {
      const m = d.getUTCMonth();
      out += t.length === 1 ? String(m + 1) : t.length === 2 ? String(m + 1).padStart(2, "0") : t.length === 3 ? MONTHS[m]!.slice(0, 3) : t.length === 5 ? MONTHS[m]![0]! : MONTHS[m]!;
    } else if (t[0] === "d") {
      out += t.length === 1 ? String(d.getUTCDate()) : t.length === 2 ? String(d.getUTCDate()).padStart(2, "0") : t.length === 3 ? DAYS[d.getUTCDay()]!.slice(0, 3) : DAYS[d.getUTCDay()]!;
    } else if (t[0] === "h") {
      const hr = ampm ? d.getUTCHours() % 12 || 12 : d.getUTCHours();
      out += String(hr).padStart(t.length, "0");
    } else if (t[0] === "s") out += String(d.getUTCSeconds()).padStart(t.length, "0");
    else out += d.getUTCHours() < 12 ? (t.length > 3 ? "AM" : "A") : t.length > 3 ? "PM" : "P";
    lastWasHour = t[0] === "h";
    i += run.length;
  }
  return out;
}

// ── Scales ──────────────────────────────────────────────────────────────────

type Scale = { min: number; max: number; major: number; minor: number };

/**
 * Office's automatic value scale (Microsoft's KB 214075, and measured): zero
 * is the floor unless the data sit in the top sixth of their range; the top
 * gets 5% of the range as headroom; both ends round to the major unit, the
 * finest 1-2-5 step whose labels fit the axis `length` at `room` each, and
 * that makes at most ten majors. A percent stack runs 0..100%.
 */
function valueScale(lo: number, hi: number, axis: ChartAxis, length: number, room: number, percent: boolean, headroom = 0.05): Scale {
  let dmin = Math.min(lo, hi);
  let dmax = Math.max(lo, hi);
  if (!Number.isFinite(dmin) || !Number.isFinite(dmax)) [dmin, dmax] = [0, 1];
  if (percent) [dmin, dmax] = [dmin < 0 ? -1 : 0, dmax > 0 ? 1 : 0];
  if (axis.min !== null) dmin = axis.min;
  if (axis.max !== null) dmax = axis.max;
  if (dmin > dmax) [dmin, dmax] = [dmax, dmin];
  if (dmin === dmax) {
    if (dmax > 0) dmin = 0;
    else if (dmax < 0) dmax = 0;
    else dmax = 1;
  }
  // Which ends float: a fixed bound, a percent stack, or a zero floor stay put.
  const zeroMin = axis.min === null && dmin >= 0 && (dmin === 0 || (dmax - dmin) / dmax > 1 / 6);
  const zeroMax = axis.max === null && dmax <= 0 && (dmax === 0 || (dmax - dmin) / -dmin > 1 / 6);
  const lowEnd = zeroMin ? 0 : dmin;
  const highEnd = zeroMax ? 0 : dmax;
  const range = highEnd - lowEnd || Math.abs(highEnd) || 1;
  const pick = (unit: number): Scale => {
    const min =
      axis.min ?? (percent || zeroMin ? lowEnd : Math.floor((dmin >= 0 ? dmin - (dmax - dmin) / 2 : dmin - headroom * range) / unit + 1e-9) * unit);
    const max =
      axis.max ?? (percent || zeroMax ? highEnd : Math.ceil((dmax <= 0 ? dmax + (dmax - dmin) / 2 : dmax + headroom * range) / unit - 1e-9) * unit);
    const lo2 = dmin >= 0 && !zeroMin && axis.min === null ? Math.max(0, min) : min;
    return { min: lo2, max: max > lo2 ? max : lo2 + unit, major: unit, minor: axis.minorUnit ?? unit / 5 };
  };
  if (axis.majorUnit) return pick(axis.majorUnit);
  let p = Math.pow(10, Math.floor(Math.log10(range)) - 3);
  for (let k = 0; k < 60; k++, p *= 10) {
    for (const step of [1, 2, 5]) {
      const sc = pick(step * p);
      const intervals = Math.round((sc.max - sc.min) / (step * p));
      if (intervals <= MAX_INTERVALS && (intervals + 1) * room <= length * (1 + 1e-9)) return sc;
    }
  }
  return pick(range);
}

function ticks(s: Scale, step: number): number[] {
  const out: number[] = [];
  if (step <= 0) return out;
  const first = Math.ceil(s.min / step - 1e-9) * step;
  for (let v = first; v <= s.max + step * 1e-9 && out.length < 1000; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

// ── Layout ──────────────────────────────────────────────────────────────────

/**
 * Office's spacing, measured on its own rendering (`shp-access-chart`,
 * `pie-chart`, `tdf112089`: 12 and 18 pt text, 2007 and 2013 styles). None of
 * it scales with the text but the legend's.
 */
const PAD = 5.5 * PT; // chart area to anything in it
const TITLE_TOP = 3 * PT; // the margin to the title's text
const TITLE_GAP = 2 * PT; // title text to what is under it
const PLOT_TOP = 10 * PT; // top of the space to the plot's inside, under a value axis's top label
const PLOT_TOP_BARE = 5 * PT; // … with no label reaching up
const PLOT_RIGHT = 6.5 * PT; // the plot's inside to the right end of its space
const VALUE_RIGHT = 14.9 * PT; // … at least, beside a horizontal value axis
const OVERHANG_GAP = 4.4 * PT; // a horizontal value axis's last label to that end
/** An axis whose labels are turned off still keeps this much room: under the
 *  plot (or over it), and beside it. */
const NO_LABELS = { across: 12.1 * PT, beside: 9.9 * PT };
const PIE_BOTTOM = 6 * PT;
/** Tick marks are as long as the axis's text is big: 5.6 pt at 18 pt, about
 *  2.5 pt at 8 pt (`shp-access-chart`, an AASCU deck). */
const tickLength = (axis: ChartAxis): number => 0.31 * axis.font.size * PT;
/** Tick labels from the tick's end: value labels sit farther out. */
const valueGap = (tick: number): number => tick + 11 * PT;
const categoryGap = (tick: number, offset: number): number => (Math.max(8 * PT, tick + 6.1 * PT) * offset) / 100;
const LEGEND_GAP = 10.5 * PT; // legend to the plot's space
const LEGEND_PAD_X = 1.4 * PT;
const LEGEND_PAD_Y = 4.9 * PT;

type AxisLayout = {
  axis: ChartAxis;
  horizontal: boolean;
  /** Value axes: the scale. Category axes: none. */
  scale: Scale | null;
  /** Category count, for category axes. */
  count: number;
  /** Category axes: categories on ticks (`midCat`) instead of between. */
  onTicks: boolean;
  /** `at`: the value (value axes) or category index; `t`: where along the
   *  axis, 0..1 from its start. */
  labels: { text: string; at: number; t: number }[];
  /** Where the ticks are, 0..1. */
  tickTs: number[];
  /** Where category `i` (or, on a value axis, value `i`) sits, 0..1. */
  slot: (i: number) => number;
  /** Length of one category's band (EMU): what bars divide. */
  band: number;
  /** How tick labels are drawn. */
  rotation: number;
  wrap: number;
  /** Space the labels and ticks take outside the plot (EMU). */
  depth: number;
  /** Multi-level categories: the depth of the labels' own row, and the
   *  groups drawn in rows under it. */
  leafDepth: number;
  groups: { text: string; start: number }[][];
};

type PlotLayout = {
  inner: Rect;
  /** A combo's second value scale: the same plot, valued along it. */
  second: PlotLayout | null;
  /** A bubble chart's biggest bubble at `bubbleScale` 100 (EMU). */
  bubbleBase: number;
  cat: AxisLayout | null;
  val: AxisLayout | null;
  /** Map a category index (or scatter X) / a value to a coordinate along its axis. */
  catPos: (i: number) => number;
  /** A point 0..1 along the category axis, as a coordinate. */
  catAt: (t: number) => number;
  valPos: (v: number) => number;
  horizontal: boolean;
};

type Layout = {
  title: (Rect & { block: Block }) | null;
  legend: { rect: Rect; entries: LegendEntry[]; columns: number; rowH: number; colW: number; single: boolean } | null;
  plot: PlotLayout | null;
  pie: PieLayout | null;
  radar: RadarLayout | null;
  box3d: Box3D | null;
  /** The plot area of a pie, radar or 3-D chart: where its fill goes. */
  plotRect: Rect | null;
  axisTitles: { title: ChartTitle; rect: Rect; rotation: number }[];
  chartW: number;
  chartH: number;
};

type LegendEntry = { text: string; series: ChartSeries; point: number | null; kind: "box" | "line" | "bubble"; plot: ChartPlot };

function legendEntries(chart: Chart, side: boolean): LegendEntry[] {
  const out: LegendEntry[] = [];
  const pie = chart.plots.length === 1 && chart.plots[0]!.kind === "pie";
  const firstSeries = chart.plots[0]?.series[0];
  if (firstSeries && (pie || (chart.plots.length === 1 && chart.plots[0]!.series.length === 1 && firstSeries.points && varied(firstSeries)))) {
    const count = Math.max(firstSeries.values.values.length, chart.categories.values.length);
    for (let i = 0; i < count; i++) {
      out.push({ text: formatValue(chart.categories.values[i] ?? i + 1, chart.categories.format, chart.date1904), series: firstSeries, point: i, kind: "box", plot: chart.plots[0]! });
    }
    return out;
  }
  for (const p of chart.plots) {
    const kind = p.kind === "line" || p.kind === "scatter" || (p.kind === "radar" && !p.filled) ? "line" : p.kind === "bubble" ? "bubble" : "box";
    // ponytail: a surface lists its series, not its value bands.
    const list: LegendEntry[] = p.series.map((s) => ({ text: s.name, series: s, point: null, kind, plot: p }));
    // A side legend lists horizontal bars and stacks bottom-up, like they are drawn.
    if (side && ((p.kind === "bar" && p.horizontal) || ((p.kind === "bar" || p.kind === "area") && p.grouping.endsWith("tacked")))) list.reverse();
    out.push(...list);
  }
  return out;
}

/** A series whose points are painted differently (varyColors). */
function varied(s: ChartSeries): boolean {
  const pts = s.points;
  if (!pts || pts.length < 2) return false;
  return pts.some((p) => JSON.stringify(p.fill) !== JSON.stringify(pts[0]!.fill));
}

function layoutChart(chart: Chart, W: number, H: number): Layout {
  const out: Layout = { title: null, legend: null, plot: null, pie: null, radar: null, box3d: null, plotRect: null, axisTitles: [], chartW: W, chartH: H };
  let area: Rect = { x: PAD, y: PAD, w: W - 2 * PAD, h: H - 2 * PAD };

  if (chart.title) {
    const b = block(chart.title.text, W * TITLE_WIDTH);
    const lay = chart.title.layout;
    const rect = {
      x: lay?.x !== null && lay?.x !== undefined ? lay.x * W : (W - b.w) / 2,
      y: lay?.y !== null && lay?.y !== undefined ? lay.y * H : PAD + TITLE_TOP,
      w: b.w,
      h: b.h,
    };
    out.title = { ...rect, block: b };
    if (!chart.title.overlay && !lay) {
      const bottom = rect.y + rect.h + TITLE_GAP;
      area = { ...area, y: bottom, h: area.y + area.h - bottom };
    }
  }

  if (chart.legend) {
    const lg = chart.legend;
    const side = lg.pos === "r" || lg.pos === "l" || lg.pos === "tr";
    let entries = legendEntries(chart, side).filter((_, i) => !lg.hidden.includes(i));
    const font = lg.font;
    const em = font.size * PT;
    const rowH = lineHeight(font) + LEGEND_ROW_GAP * em;
    // A side legend shows the entries that fit the chart's height, no more.
    if (side && !lg.layout) entries = entries.slice(0, Math.max(1, Math.floor((area.h - 2 * LEGEND_PAD_Y) / rowH)));
    if (entries.length) {
      const texts = entries.map((e) => textWidth(e.text, font));
      const keyW = keyWidth(entries, font) + keyGap(entries) * em;
      // Side legends stack their entries; top and bottom ones flow them in
      // rows, as many to a row as fit, every column as wide as the widest.
      let columns = 1;
      let colW = keyW + Math.max(...texts);
      if (!side) {
        const each = texts.map((t) => keyW + t + LEGEND_ENTRY_GAP * em);
        const total = each.reduce((x, y) => x + y, 0) - LEGEND_ENTRY_GAP * em;
        if (total <= area.w - 2 * LEGEND_PAD_X) columns = entries.length;
        else {
          colW = Math.max(...each);
          columns = Math.max(1, Math.floor((area.w - 2 * LEGEND_PAD_X + LEGEND_ENTRY_GAP * em) / colW));
        }
      }
      const rows = Math.ceil(entries.length / columns);
      const single = !side && columns === entries.length;
      const contentW = single ? texts.reduce((x, t) => x + keyW + t + LEGEND_ENTRY_GAP * em, 0) - LEGEND_ENTRY_GAP * em : columns * colW;
      let lw = contentW + 2 * LEGEND_PAD_X;
      let lh = rows * (side ? rowH : lineHeight(font)) + 2 * LEGEND_PAD_Y;
      let rect: Rect;
      const lay = lg.layout;
      if (lay && lay.x !== null && lay.y !== null) {
        if (lay.w !== null) lw = lay.w * W;
        if (lay.h !== null) lh = lay.h * H;
        rect = { x: lay.x * W, y: lay.y * H, w: lw, h: lh };
      } else {
        const right = area.x + area.w;
        const bottom = area.y + area.h;
        switch (lg.pos) {
          case "l":
            rect = { x: area.x, y: area.y + (area.h - lh) / 2, w: lw, h: lh };
            if (!lg.overlay) area = { ...area, x: area.x + lw + LEGEND_GAP, w: area.w - lw - LEGEND_GAP };
            break;
          case "t":
            rect = { x: (W - lw) / 2, y: area.y, w: lw, h: lh };
            if (!lg.overlay) area = { ...area, y: area.y + lh, h: area.h - lh };
            break;
          case "b":
            rect = { x: (W - lw) / 2, y: bottom - lh, w: lw, h: lh };
            if (!lg.overlay) area = { ...area, h: area.h - lh };
            break;
          case "tr":
            rect = { x: right - lw, y: area.y, w: lw, h: lh };
            if (!lg.overlay) area = { ...area, w: area.w - lw - LEGEND_GAP };
            break;
          default:
            rect = { x: right - lw, y: area.y + (area.h - lh) / 2, w: lw, h: lh };
            if (!lg.overlay) area = { ...area, w: area.w - lw - LEGEND_GAP };
        }
      }
      out.legend = { rect, entries, columns: single ? entries.length : columns, rowH: side ? rowH : lineHeight(font), colW, single };
    }
  }

  const manual = chart.plotArea.layout;
  const manualRect = manual && manual.x !== null && manual.y !== null && manual.w !== null && manual.h !== null
    ? { x: manual.x * W, y: manual.y * H, w: manual.w * W, h: manual.h * H }
    : null;
  if (chart.plots.every((p) => p.kind === "pie")) {
    const r: Rect = manualRect ?? { x: area.x, y: area.y + PLOT_TOP, w: area.w, h: area.h - PLOT_TOP - PIE_BOTTOM };
    const plot = chart.plots[0];
    const explode = plot ? Math.max(0, ...plot.series.flatMap((s) => [s.explosion, ...(s.points ?? []).map((p) => p.explosion)])) : 0;
    // Labels shrink the pie, room for them outside (measured on a doughnut:
    // 305 px against 352 px without labels, 18 pt text).
    const label = plot?.series.flatMap((s) => s.labels).find((l) => l !== null);
    const room = label && !manual ? 0.8 * lineHeight(label.font) : 0;
    // A 3-D pie is an ellipse `tilt` as tall as wide over a rim `thick` radii deep.
    const v = chart.view3D;
    const rotX = (Math.min(90, Math.max(0, v?.rotX ?? 90)) * Math.PI) / 180;
    const tilt = v ? Math.sin(rotX) : 1;
    const thick = v ? (PIE_DEPTH * v.depth * Math.cos(rotX)) / 100 : 0;
    // Perspective widens a 3-D pie's near side: Office fits the picture, so
    // the pie itself comes out smaller (178 px where a flat one is 194, the
    // dark deck's, field of view 15°).
    const near = v ? 1 + (Math.cos(rotX) * Math.tan((v.fov * Math.PI) / 360)) / 1.43 : 1;
    const radius = Math.min(r.w / 2 - room, (r.h - 2 * room) / (2 * tilt + thick)) / (1 + explode / 100) / near;
    const rr = Math.max(0, radius);
    out.pie = { cx: r.x + r.w / 2, cy: r.y + r.h / 2 - (thick * rr) / 2, r: rr, tilt, thick: thick * rr, first: v ? v.rotY : null };
    if (v) out.plotRect = { x: out.pie.cx - rr, y: out.pie.cy - rr * tilt, w: 2 * rr, h: 2 * rr * tilt + thick * rr };
    return out;
  }
  if (chart.plots.some((p) => p.kind === "radar")) {
    out.radar = layoutRadar(chart, manualRect ?? area, W);
    out.plotRect = manualRect;
    return out;
  }
  if (chart.view3D) {
    out.box3d = layout3D(chart, chart.view3D, manualRect ?? area, manual?.inner === true && manualRect !== null);
    return out;
  }

  out.plot = layoutPlot(chart, area, manual, W, H, out);
  return out;
}

/** Legend geometry, in ems of the legend's text. */
const LEGEND_ROW_GAP = 0.33;
const LEGEND_ENTRY_GAP = 0.77;
const keySize = (font: ChartFont): number => 0.55 * font.size * PT;
/** With a line among the entries every key is a short stretch of line (a box
 *  as long as it), nearly touching its text. */
const hasLineKey = (entries: LegendEntry[]): boolean => entries.some((e) => e.kind === "line");
const keyWidth = (entries: LegendEntry[], font: ChartFont): number => (hasLineKey(entries) ? 1.1 : 0.55) * font.size * PT;
const keyGap = (entries: LegendEntry[]): number => (hasLineKey(entries) ? 0.12 : 0.39);
/** Legend markers are drawn no bigger than this (points). */
const LEGEND_MARKER = 7;

function layoutPlot(chart: Chart, area: Rect, manual: ChartLayout | null, W: number, H: number, out: Layout): PlotLayout {
  const plots = chart.plots;
  const bar = plots.find((p) => p.kind === "bar");
  const horizontal = bar?.kind === "bar" && bar.horizontal;
  const scatter = plots.some((p) => p.kind === "scatter" || p.kind === "bubble");
  const catAxis = chart.categoryAxis;
  const valAxis = chart.valueAxis;

  // A combo's plots on the second scale, and the rest.
  const sec = chart.secondary;
  const onSecond = (i: number): boolean => !!sec && sec.plots.includes(i);
  const secPlots = plots.filter((_, i) => onSecond(i));
  const mainPlots = plots.filter((_, i) => !onSecond(i));
  const percentOf = (ps: ChartPlot[]): boolean => ps.some((p) => "grouping" in p && p.grouping === "percentStacked");
  const [lo2, hi2] = valueRange(secPlots);

  // Values the value axis must hold; bubbles reach out by their radius,
  // measured against the previous pass's scales.
  let [lo, hi] = valueRange(mainPlots);
  let xr = scatter ? xRange(chart) : null;
  const [lo0, hi0] = [lo, hi];
  const xr0 = xr;
  let bubbleBase = 0;
  const count = Math.max(chart.categories.values.length, ...plots.flatMap((p) => p.series.map((s) => s.values.values.length)), 1);
  const percent = percentOf(mainPlots);
  const onTicks = !scatter && valAxis ? !valAxis.between : false;

  // Axis titles take a band on their side.
  const titleBand = (axis: ChartAxis | null): number => (axis?.title && !axis.deleted ? block(axis.title.text).h + TITLE_GAP : 0);

  let outer: Rect = area;
  if (manual && manual.x !== null && manual.y !== null && manual.w !== null && manual.h !== null) {
    outer = { x: manual.x * W, y: manual.y * H, w: manual.w * W, h: manual.h * H };
  }
  const innerGiven = manual?.inner === true && manual.x !== null && manual.w !== null && manual.y !== null && manual.h !== null;

  const catHorizontal = !horizontal;
  let inner: Rect = { ...outer };
  let cat: AxisLayout | null = null;
  let val: AxisLayout | null = null;
  let val2: AxisLayout | null = null;
  for (let pass = 0; pass < 3; pass++) {
    if (pass > 0 && xr0 && cat?.scale && val?.scale && bubbleBase) {
      const reach = bubbleReach(chart, bubbleBase, cat.scale, val.scale, inner, [lo0, hi0], xr0);
      [lo, hi] = reach.y;
      xr = reach.x;
    }
    cat = catAxis
      ? scatter && xr
        ? valueAxisLayout(catAxis, xr[0], xr[1], catHorizontal ? inner.w : inner.h, catHorizontal, false, firstFormat(chart, true), chart)
        : categoryAxisLayout(catAxis, chart, count, onTicks, catHorizontal ? inner.w : inner.h, catHorizontal)
      : null;
    val = valAxis ? valueAxisLayout(valAxis, lo, hi, catHorizontal ? inner.h : inner.w, !catHorizontal, percent, firstFormat(chart, false), chart) : null;
    const secFormat = secPlots[0]?.series[0]?.values.format ?? "General";
    val2 = sec && secPlots.length ? valueAxisLayout(sec.axis, lo2, hi2, catHorizontal ? inner.h : inner.w, !catHorizontal, percentOf(secPlots), secFormat, chart) : null;
    if (innerGiven) break;
    const vertical = catHorizontal ? val : cat;
    const across = catHorizontal ? cat : val;
    const labelled = (a: AxisLayout | null): boolean => !!a && !a.axis.deleted && a.axis.labels !== "none";
    // Room for an axis's labels on the side they hang off, when outside.
    const room = (a: AxisLayout | null, isCat: boolean, free: number): { before: number; after: number } => {
      if (!a) return { before: 0, after: 0 };
      const other = isCat ? val : cat;
      const pl = isCat ? categoryPlacement(a, val) : valuePlacement(a, cat);
      const depth = a.axis.labels === "none" && !a.axis.deleted ? free : pl.outside ? a.depth : 0;
      const onAfter = after(pl.toward, isCat, catHorizontal, other?.axis.reversed ?? false);
      return onAfter ? { before: 0, after: depth } : { before: depth, after: 0 };
    };
    const v = room(vertical, vertical === cat, NO_LABELS.beside);
    const h = room(across, across === cat, NO_LABELS.across);
    // The second scale's labels, usually on the far side.
    const s2 = room(val2, false, catHorizontal ? NO_LABELS.beside : NO_LABELS.across);
    // The last label of a horizontal value axis hangs half out past its end.
    const overhang = across?.scale && labelled(across) ? textWidth(across.labels[across.labels.length - 1]?.text ?? "", across.axis.font) / 2 : 0;
    // A label slanting down to the left from the first category must fit.
    const first = across && !across.scale && across.rotation < 0 ? across.labels[0] : undefined;
    const slant = first && across
      ? textWidth(first.text, across.axis.font) * Math.cos((across.rotation * Math.PI) / 180) - first.t * inner.w
      : 0;
    const [sl, sr, st, sb] = catHorizontal ? [s2.before, s2.after, 0, 0] : [0, 0, s2.before, s2.after];
    const left = Math.max(v.before + sl + titleBand(vertical?.axis ?? null), slant);
    const right = v.after || sr || (overhang ? Math.max(VALUE_RIGHT, overhang + OVERHANG_GAP) : PLOT_RIGHT);
    const bottom = h.after + sb + titleBand(across?.axis ?? null);
    const top = h.before || st || (vertical?.scale && labelled(vertical) ? PLOT_TOP : PLOT_TOP_BARE);
    inner = { x: outer.x + left, y: outer.y + top, w: Math.max(1, outer.w - left - right), h: Math.max(1, outer.h - top - bottom) };
    bubbleBase = Math.min(inner.w + left, inner.h + h.after) / 4;
  }
  if (innerGiven) bubbleBase = Math.min(inner.w, inner.h) / 4;

  const valLength = catHorizontal ? inner.h : inner.w;
  const catLength = catHorizontal ? inner.w : inner.h;
  const catRev = catAxis?.reversed === true;
  const along = (a: AxisLayout | null) => {
    const sc = a?.scale ?? { min: 0, max: 1, major: 0.2, minor: 0.04 };
    const rev = a?.axis.reversed === true;
    return (v: number): number => {
      const t = (v - sc.min) / (sc.max - sc.min || 1);
      const tt = rev ? 1 - t : t;
      return catHorizontal ? inner.y + inner.h - tt * valLength : inner.x + tt * valLength;
    };
  };
  const valPos = along(val);
  // Category axes run left to right, and bottom to top on horizontal bars.
  const catAt = (t: number): number => {
    const tt = catRev ? 1 - t : t;
    return catHorizontal ? inner.x + tt * catLength : inner.y + inner.h - tt * catLength;
  };
  const fallbackSlot = (i: number): number => (onTicks ? (count > 1 ? i / (count - 1) : 0.5) : (i + 0.5) / count);
  const catPos = (i: number): number => catAt((cat?.slot ?? fallbackSlot)(i));

  // Axis titles.
  const addTitle = (axis: ChartAxis | null, side: "b" | "l"): void => {
    if (!axis?.title || axis.deleted) return;
    const b = block(axis.title.text);
    if (side === "b") out.axisTitles.push({ title: axis.title, rect: { x: inner.x + (inner.w - b.w) / 2, y: outer.y + outer.h - b.h, w: b.w, h: b.h }, rotation: 0 });
    else {
      const cy = inner.y + inner.h / 2;
      out.axisTitles.push({ title: axis.title, rect: { x: outer.x + b.h / 2 - b.w / 2, y: cy - b.h / 2, w: b.w, h: b.h }, rotation: axis.title.rotation ?? -90 });
    }
  };
  addTitle(catHorizontal ? catAxis : valAxis, "b");
  addTitle(catHorizontal ? valAxis : catAxis, "l");

  const base = { inner, bubbleBase, cat, catPos, catAt, horizontal: !!horizontal, second: null };
  return { ...base, val, valPos, second: val2 ? { ...base, val: val2, valPos: along(val2) } : null };
}

/** Data ranges grown by each bubble's radius, in the units of scales `xs`/`ys` over `inner`. */
function bubbleReach(chart: Chart, base: number, xs: Scale, ys: Scale, inner: Rect, y: [number, number], x: [number, number]): { x: [number, number]; y: [number, number] } {
  const out = { x: [...x] as [number, number], y: [...y] as [number, number] };
  for (const p of chart.plots) {
    if (p.kind !== "bubble") continue;
    const sizes = bubbleSizes(p, chart, base);
    p.series.forEach((s, k) => {
      const xv = xValuesOf(s);
      s.values.values.forEach((raw, i) => {
        const vy = num(raw);
        const vx = xv[i];
        const d = sizes[k]?.[i];
        if (vy === null || vx === null || vx === undefined || !d) return;
        const rx = ((d / 2) * (xs.max - xs.min)) / inner.w;
        const ry = ((d / 2) * (ys.max - ys.min)) / inner.h;
        out.x = [Math.min(out.x[0], vx - rx), Math.max(out.x[1], vx + rx)];
        out.y = [Math.min(out.y[0], vy - ry), Math.max(out.y[1], vy + ry)];
      });
    });
  }
  return out;
}

/**
 * Where an axis goes, in fractions along the OTHER axis (0 = its start): its
 * line crosses at `line`; its labels hang off `labels` towards `toward` (-1:
 * the start's side, +1: the end's), and are `outside` the plot when that is
 * one of its edges — only then does the plot make room for them. Labels sit
 * on the low side of the line, unless the line is the far edge.
 */
type Placement = { line: number; labels: number; toward: -1 | 1; outside: boolean };

function placement(cross: number, labels: ChartAxis["labels"]): Placement {
  const at = labels === "low" ? 0 : labels === "high" ? 1 : Math.min(1, Math.max(0, cross));
  return { line: Math.min(1, Math.max(0, cross)), labels: at, toward: at >= 1 - 1e-9 ? 1 : -1, outside: at <= 1e-9 || at >= 1 - 1e-9 };
}

/** The category axis crosses the values at zero (or the end the data are on). */
function categoryPlacement(cat: AxisLayout, val: AxisLayout | null): Placement {
  const sc = val?.scale;
  if (!sc) return placement(0, cat.axis.labels);
  const c = cat.axis.crosses;
  const v = typeof c === "number" ? c : c === "max" ? sc.max : c === "min" ? sc.min : sc.min > 0 ? sc.min : sc.max < 0 ? sc.max : 0;
  return placement((v - sc.min) / (sc.max - sc.min || 1), cat.axis.labels);
}

/** The value axis crosses the categories at their start (or end); on a
 *  scatter, at the X value. */
function valuePlacement(val: AxisLayout, cat: AxisLayout | null): Placement {
  const c = val.axis.crosses;
  if (cat?.scale) {
    const sc = cat.scale;
    const v = typeof c === "number" ? c : c === "max" ? sc.max : c === "min" ? sc.min : sc.min > 0 ? sc.min : sc.max < 0 ? sc.max : 0;
    return placement((v - sc.min) / (sc.max - sc.min || 1), val.axis.labels);
  }
  return placement(c === "max" ? 1 : 0, val.axis.labels);
}

/** Whether labels moving `toward` along an axis go right/down on screen. */
function after(toward: -1 | 1, alongValues: boolean, columns: boolean, reversed: boolean): boolean {
  // Values grow upwards on columns and rightwards on bars; categories grow
  // rightwards on columns and upwards on bars.
  const growsPositive = alongValues ? !columns : columns;
  return (toward > 0) === growsPositive !== reversed;
}

function valueRange(plots: ChartPlot[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of plots) {
    if (p.kind === "pie") continue;
    const grouping = "grouping" in p ? p.grouping : "standard";
    const stacked = grouping === "stacked" || grouping === "percentStacked";
    if (grouping === "percentStacked") {
      const neg = p.series.some((s) => s.values.values.some((v) => typeof v === "number" && v < 0));
      lo = Math.min(lo, neg ? -1 : 0);
      hi = Math.max(hi, 1);
      continue;
    }
    if (stacked) {
      const n = Math.max(...p.series.map((s) => s.values.values.length));
      for (let i = 0; i < n; i++) {
        let pos = 0;
        let neg = 0;
        for (const s of p.series) {
          const v = s.values.values[i];
          if (typeof v === "number") {
            if (v >= 0) pos += v;
            else neg += v;
          }
        }
        hi = Math.max(hi, pos);
        lo = Math.min(lo, neg);
      }
    } else {
      for (const s of p.series) for (const v of s.values.values) if (typeof v === "number") {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    if (p.kind === "bar" || p.kind === "area") {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
  }
  if (lo === Infinity) return [0, 1];
  return [lo, hi];
}

/** The first series' number format, of its values or (scatter) its X values:
 *  what a source-linked axis shows. */
function firstFormat(chart: Chart, x: boolean): string {
  const s = chart.plots[0]?.series[0];
  return (x ? s?.xValues?.format : s?.values.format) ?? "General";
}

function xValuesOf(s: ChartSeries): (number | null)[] {
  const xs = s.xValues?.values;
  const n = s.values.values.length;
  if (!xs || xs.some((v) => typeof v === "string")) return Array.from({ length: n }, (_, i) => i + 1);
  return Array.from({ length: n }, (_, i) => {
    const x = xs[i];
    return typeof x === "number" ? x : null;
  });
}

function xRange(chart: Chart): [number, number] {
  // Bubbles over text X values sit at 1..n on an axis from 0 to n + 1
  // (the dark deck's bubbles, 4 categories on 0..5).
  const texts = chart.plots.flatMap((p) => (p.kind === "bubble" ? p.series : [])).filter((s) => s.xValues?.values.some((v) => typeof v === "string"));
  if (texts.length) return [0, Math.max(...texts.map((s) => s.values.values.length)) + 1];
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of chart.plots) for (const s of p.series) for (const v of xValuesOf(s)) if (v !== null) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return lo === Infinity ? [0, 1] : [lo, hi];
}

/**
 * The room Office counts per tick label, in label line heights: an automatic
 * major unit is kept only if all its labels fit the axis at that much each,
 * and never more than ten majors. Fitted on fifteen automatic axes
 * (`cht-chart-type`, `cht-category-access`, `cht-datalabels`, `cht-axis-props`,
 * `cht-series`, `shp-access-chart`, `tdf112089`, `bar-chart`, two AASCU
 * decks; 10, 12 and 18 pt), which a spacing threshold can't explain: at 18 pt
 * 26.57 pt between majors is refused on one axis and 26.4 pt taken on
 * another — it's the label count that differs. Horizontal axes, dates
 * included, count about twice the room.
 */
const LABEL_ROOM = { vertical: 1.075, horizontal: 2.07 };
const MAX_INTERVALS = 10;

function valueAxisLayout(
  axis: ChartAxis,
  lo: number,
  hi: number,
  length: number,
  horizontal: boolean,
  percent: boolean,
  source: string,
  chart: Chart,
  headroom = 0.05,
): AxisLayout {
  const font = axis.font;
  const fmt = axis.format ?? (percent ? "0%" : source);
  const scale = valueScale(lo, hi, axis, length, (horizontal ? LABEL_ROOM.horizontal : LABEL_ROOM.vertical) * lineHeight(font), percent, headroom);
  const shown = !axis.deleted && axis.labels !== "none";
  const labels = shown ? ticks(scale, scale.major).map((v) => ({ text: formatValue(v, fmt, chart.date1904), at: v, t: 0 })) : [];
  const tickOut = !axis.deleted && (axis.majorTick === "out" || axis.majorTick === "cross") ? tickLength(axis) : 0;
  const depth = shown
    ? horizontal
      ? lineHeight(font) + categoryGap(tickOut, 100)
      : Math.max(0, ...labels.map((l) => textWidth(l.text, font))) + valueGap(tickOut)
    : tickOut;
  const span = scale.max - scale.min || 1;
  const slot = (v: number): number => (v - scale.min) / span;
  return {
    axis,
    horizontal,
    scale,
    count: 0,
    onTicks: false,
    labels: labels.map((l) => ({ ...l, t: slot(l.at) })),
    tickTs: ticks(scale, scale.major).map(slot),
    slot,
    band: (length * scale.major) / span,
    rotation: 0,
    wrap: 0,
    depth,
    leafDepth: depth,
    groups: [],
  };
}

/**
 * A date axis with daily (or weekly) data is a time scale: each date sits at
 * its own day, one day wide, and labels come every few days — the finest of
 * 1, 2, 3, 7 or 14 days whose labels fit like value labels do. Coarser data (months,
 * years) is laid out by index, which is what an even calendar step looks like.
 */
function dateScale(
  values: (number | string | null)[],
  count: number,
  onTicks: boolean,
  length: number,
  room: number,
): { min: number; span: number; unit: number; days: number[] } | null {
  const days = values.slice(0, count).map((v) => (typeof v === "number" ? Math.floor(v) : NaN));
  if (days.length < 2 || days.some((d) => !Number.isFinite(d))) return null;
  const sorted = [...days].sort((x, y) => x - y);
  const gap = Math.min(...sorted.slice(1).map((d, i) => d - sorted[i]!).filter((d) => d > 0));
  if (!Number.isFinite(gap) || gap >= 28) return null;
  const min = sorted[0]!;
  const span = sorted[sorted.length - 1]! - min + (onTicks ? 0 : 1) || 1;
  const last = sorted[sorted.length - 1]! - min;
  const unit = [1, 2, 3, 7, 14, 28].find((u) => (Math.floor(last / u) + 1) * room <= length) ?? 28;
  return { min, span, unit, days };
}

function categoryAxisLayout(axis: ChartAxis, chart: Chart, count: number, onTicks: boolean, length: number, horizontal: boolean): AxisLayout {
  const font = axis.font;
  const shown = !axis.deleted && axis.labels !== "none";
  const fmt = axis.format ?? chart.categories.format;
  const dates = axis.kind === "date" ? dateScale(chart.categories.values, count, onTicks, length, LABEL_ROOM.horizontal * lineHeight(font)) : null;
  let slot: (i: number) => number;
  let items: { text: string; at: number; t: number }[];
  let tickTs: number[];
  let band: number;
  let spacing: number;
  if (dates) {
    slot = (i) => ((dates.days[i] ?? dates.min) - dates.min + (onTicks ? 0 : 0.5)) / dates.span;
    band = length / dates.span;
    items = [];
    for (let d = dates.min; d - dates.min <= dates.span - (onTicks ? 0 : 1) + 1e-9; d += dates.unit) {
      items.push({ text: formatValue(d, fmt, chart.date1904), at: d, t: (d - dates.min) / dates.span });
    }
    tickTs = items.map((l) => l.t);
    spacing = band * dates.unit;
  } else {
    slot = (i) => (onTicks ? (count > 1 ? i / (count - 1) : 0.5) : (i + 0.5) / count);
    band = length / Math.max(1, onTicks ? count - 1 : count);
    items = Array.from({ length: count }, (_, i) => ({
      text: formatValue(chart.categories.values[i] ?? (chart.categories.values.length ? null : i + 1), fmt, chart.date1904),
      at: i,
      t: slot(i),
    }));
    const step = axis.tickSkip ?? 1;
    tickTs = [];
    if (onTicks) for (let i = 0; i < count; i += step) tickTs.push(slot(i));
    else for (let i = 0; i <= count; i += step) tickTs.push(i / count);
    spacing = band;
  }
  const texts = items.map((l) => l.text);
  const lh = lineHeight(font);
  let rotation = 0;
  let wrap = 0;
  let skip = axis.labelSkip ?? 1;
  let depthText = 0;
  if (shown && horizontal) {
    // A label gets its whole band: 78.8 pt of "Category 1" stays on one line
    // in a 79.3 pt band (`cht-axis-props`).
    const room = spacing * skip;
    const widest = Math.max(0, ...texts.map((t) => textWidth(t, font)));
    if (axis.rotation !== null && axis.rotation !== 0) {
      rotation = axis.rotation;
    } else if (widest > room) {
      // Broken at spaces when every word fits; slanted otherwise — upright
      // under groups of categories.
      const fits = texts.every((t) => plainBlock(t, font, room).w <= room);
      if (axis.rotation === 0 || fits) wrap = room;
      else rotation = chart.categoryGroups.length ? -90 : -45;
    }
    if (rotation && axis.labelSkip === null) {
      const need = Math.abs(lh / Math.sin((Math.abs(rotation) * Math.PI) / 180));
      skip = Math.max(1, Math.ceil(need / spacing - 1e-6));
    }
    if (rotation) {
      const a = (Math.abs(rotation) * Math.PI) / 180;
      depthText = Math.max(0, ...texts.map((t) => textWidth(t, font) * Math.sin(a) + lh * Math.cos(a)));
    } else if (wrap) depthText = Math.max(...texts.map((t) => plainBlock(t, font, wrap).h));
    else depthText = lh;
  } else if (shown) {
    if (axis.labelSkip === null) skip = Math.max(1, Math.ceil(lh / spacing - 1e-6));
    depthText = Math.max(0, ...texts.map((t) => textWidth(t, font)));
  }
  const tickOut = !axis.deleted && (axis.majorTick === "out" || axis.majorTick === "cross") ? tickLength(axis) : 0;
  const gap = horizontal ? categoryGap(tickOut, axis.labelOffset) : tickOut + (6.1 * PT * axis.labelOffset) / 100;
  return {
    axis,
    horizontal,
    scale: null,
    count,
    onTicks,
    labels: shown ? items.filter((_, i) => i % skip === 0) : [],
    tickTs,
    slot,
    band,
    rotation,
    wrap,
    // Each level of groups takes a row as deep as a label and its gap.
    depth: shown ? depthText + gap + (horizontal ? chart.categoryGroups.length * (gap + lh) : 0) : tickOut,
    leafDepth: shown ? depthText + gap : tickOut,
    groups: horizontal && shown ? chart.categoryGroups : [],
  };
}

// ── Painting ────────────────────────────────────────────────────────────────

type Paint = {
  box: (b: ChartBox, r: Rect) => ReactNode;
  /** Shapes cut to a rectangle. */
  clip: (r: Rect, shapes: ReactNode[]) => ReactNode;
  /** A rectangle, or a path in the coordinates of `box` (its gradient's box). */
  shape: (d: string | Rect, fill: Fill | null, line: Line | null, effects: Effects | null, box?: Rect) => ReactNode;
  /** Shapes under one shadow, the series' (a union, like Office's). */
  group: (shapes: ReactNode[], effects: Effects | null) => ReactNode;
};

function paintWith(defs: ReactNode[], key: () => string, resolve: ResolvePart | null): Paint {
  const ctx = (r: Rect): PaintContext => ({ resolve: resolve ?? ((p) => p), background: null, slide: { w: r.w, h: r.h }, at: { x: r.x, y: r.y } });
  // Without the package's parts a picture can't be drawn; a slide's
  // background behind a chart is what shows through it anyway.
  const drawable = (f: Fill | null | undefined): Fill | null => (!f || f.kind === "background" || (f.kind === "image" && !resolve) ? null : f);
  const shape = (d: string | Rect, fill: Fill | null, line: Line | null, effects: Effects | null, pathBox?: Rect): ReactNode => {
    const k = key();
    const r = typeof d === "string" ? (pathBox ?? null) : d;
    const f = drawable(fill);
    const lf = drawable(line?.fill);
    if (!f && !lf) return null;
    const boxOf = r ?? { x: 0, y: 0, w: 1, h: 1 };
    const fillPaint = svgPaint(f, `${k}f`, ctx(boxOf), { w: boxOf.w, h: boxOf.h });
    const linePaint = svgPaint(lf, `${k}l`, ctx(boxOf), { w: boxOf.w, h: boxOf.h });
    const stroke = line ? strokeProps(line, linePaint.paint) : { stroke: "none" };
    return (
      <g key={k} filter={shadow(effects, k)} transform={r ? `translate(${r.x} ${r.y})` : undefined}>
        {fillPaint.defs || linePaint.defs ? (
          <defs>
            {fillPaint.defs}
            {linePaint.defs}
          </defs>
        ) : null}
        {typeof d === "string" ? (
          <path d={d} fill={fillPaint.paint} {...stroke} />
        ) : (
          <rect width={Math.max(0, d.w)} height={Math.max(0, d.h)} fill={fillPaint.paint} {...stroke} />
        )}
      </g>
    );
  };
  /** An outer shadow as a filter in the shared defs; its `url()`. */
  const shadow = (effects: Effects | null, k: string): string | undefined => {
    const sh = effects?.shadow;
    if (!sh || sh.inner) return undefined;
    const a = (sh.dir * Math.PI) / 180;
    defs.push(
      <filter key={`${k}s`} id={`${k}s`} x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx={Math.cos(a) * sh.dist} dy={Math.sin(a) * sh.dist} stdDeviation={sh.blur / 2} floodColor={sh.color} />
      </filter>,
    );
    return `url(#${k}s)`;
  };
  const group = (shapes: ReactNode[], effects: Effects | null): ReactNode => {
    const k = key();
    return (
      <g key={k} filter={shadow(effects, k)}>
        {shapes}
      </g>
    );
  };
  const clip = (r: Rect, shapes: ReactNode[]): ReactNode => {
    const k = key();
    defs.push(
      <clipPath key={k} id={k}>
        <rect x={r.x} y={r.y} width={r.w} height={r.h} />
      </clipPath>,
    );
    return (
      <g key={`${k}g`} clipPath={`url(#${k})`}>
        {shapes}
      </g>
    );
  };
  return { shape, group, clip, box: (b, r) => shape(r, b.fill, b.line, b.effects) };
}

/** Gridlines go under the series. */
function drawAxesBehind(plot: PlotLayout, key: () => string): ReactNode[] {
  const out: ReactNode[] = [];
  const { inner } = plot;
  const catHorizontal = !plot.horizontal;
  const line = (x1: number, y1: number, x2: number, y2: number, l: Line): ReactNode => (
    <line key={key()} x1={x1} y1={y1} x2={x2} y2={y2} {...strokeProps(l, l.fill?.kind === "solid" ? l.fill.color : "none")} />
  );
  const val = plot.val;
  if (val?.scale) {
    for (const [grid, step] of [
      [val.axis.minorGrid, val.scale.minor],
      [val.axis.majorGrid, val.scale.major],
    ] as const) {
      if (!grid) continue;
      for (const v of ticks(val.scale, step)) {
        const p = plot.valPos(v);
        out.push(catHorizontal ? line(inner.x, p, inner.x + inner.w, p, grid) : line(p, inner.y, p, inner.y + inner.h, grid));
      }
    }
  }
  const cat = plot.cat;
  if (cat) {
    for (const grid of [cat.axis.minorGrid, cat.axis.majorGrid]) {
      if (!grid) continue;
      for (const p of categoryTicks(plot, cat)) out.push(catHorizontal ? line(p, inner.y, p, inner.y + inner.h, grid) : line(inner.x, p, inner.x + inner.w, p, grid));
    }
  }
  return out;
}

/** Where a category axis has its ticks. */
function categoryTicks(plot: PlotLayout, cat: AxisLayout): number[] {
  return cat.tickTs.map((t) => plot.catAt(t));
}

/** Axis lines, ticks and labels go over the series. */
function drawAxesFront(plot: PlotLayout, key: () => string): ReactNode[] {
  const out: ReactNode[] = [];
  const { inner } = plot;
  const columns = !plot.horizontal;
  const val = plot.val;
  const cat = plot.cat;
  const stroke = (l: Line | null): Record<string, string | number | undefined> => strokeProps(l, l?.fill?.kind === "solid" ? l.fill.color : "none");
  const sc = val?.scale ?? null;
  // Fractions along each axis, as coordinates.
  const alongValues = (t: number): number => (sc ? plot.valPos(sc.min + t * (sc.max - sc.min)) : columns ? inner.y + inner.h : inner.x);
  const alongCategories = (t: number): number => plot.catAt(t);

  if (cat && !cat.axis.deleted) {
    const pl = categoryPlacement(cat, val);
    const at = alongValues(pl.line);
    const dir = after(pl.toward, true, columns, val?.axis.reversed ?? false) ? 1 : -1;
    if (cat.axis.line?.fill) {
      out.push(
        columns ? (
          <line key={key()} x1={inner.x} y1={at} x2={inner.x + inner.w} y2={at} {...stroke(cat.axis.line)} />
        ) : (
          <line key={key()} x1={at} y1={inner.y} x2={at} y2={inner.y + inner.h} {...stroke(cat.axis.line)} />
        ),
      );
    }
    if (cat.groups.length) out.push(...categoryGroups(plot, cat, alongValues(pl.labels), dir, key));
    else out.push(...tickMarks(categoryTicks(plot, cat), at, cat.axis, columns, dir, key));
    out.push(...categoryLabels(plot, cat, alongValues(pl.labels), dir, columns, key));
  }
  if (val && !val.axis.deleted && sc) {
    const pl = valuePlacement(val, cat);
    const at = alongCategories(pl.line);
    const dir = after(pl.toward, false, columns, cat?.axis.reversed ?? false) ? 1 : -1;
    if (val.axis.line?.fill) {
      out.push(
        columns ? (
          <line key={key()} x1={at} y1={inner.y} x2={at} y2={inner.y + inner.h} {...stroke(val.axis.line)} />
        ) : (
          <line key={key()} x1={inner.x} y1={at} x2={inner.x + inner.w} y2={at} {...stroke(val.axis.line)} />
        ),
      );
    }
    out.push(...tickMarks(ticks(sc, sc.major).map((v) => plot.valPos(v)), at, val.axis, !columns, dir, key));
    const tickOut = val.axis.majorTick === "out" || val.axis.majorTick === "cross" ? tickLength(val.axis) : 0;
    const font = val.axis.font;
    const edge = alongCategories(pl.labels);
    for (const l of val.labels) {
      const p = plot.valPos(l.at);
      if (columns) {
        const x = edge + dir * valueGap(tickOut);
        out.push(label(l.text, font, x, p - lineHeight(font) / 2, dir < 0 ? "end" : "start", key()));
      } else {
        const gap = categoryGap(tickOut, 100);
        out.push(label(l.text, font, p, dir > 0 ? edge + gap : edge - gap - lineHeight(font), "middle", key()));
      }
    }
  }
  return out;
}

/** Tick marks across an axis at `at`; `dir` is the outside's direction. */
function tickMarks(pos: number[], at: number, axis: ChartAxis, horizontalAxis: boolean, dir: number, key: () => string): ReactNode[] {
  const kind = axis.majorTick;
  const line = axis.line;
  if (kind === "none" || !line?.fill) return [];
  const outward = kind === "in" ? 0 : tickLength(axis);
  const inward = kind === "out" ? 0 : tickLength(axis);
  const s = strokeProps(line, line.fill.kind === "solid" ? line.fill.color : "none");
  return pos.map((p) =>
    horizontalAxis ? (
      <line key={key()} x1={p} y1={at - inward * dir} x2={p} y2={at + outward * dir} {...s} />
    ) : (
      <line key={key()} x1={at - inward * dir} y1={p} x2={at + outward * dir} y2={p} {...s} />
    ),
  );
}

/**
 * Multi-level categories under a horizontal axis: a row per level, each as
 * deep as a label and its gap, the groups' labels centred over their
 * categories; lines between the categories run through the labels' row, and
 * between groups through every row down to theirs (`cht-category-access`).
 */
function categoryGroups(plot: PlotLayout, cat: AxisLayout, at: number, dir: number, key: () => string): ReactNode[] {
  const out: ReactNode[] = [];
  const line = cat.axis.line;
  const s = line?.fill ? strokeProps(line, line.fill.kind === "solid" ? line.fill.color : "none") : null;
  const font = cat.axis.font;
  const gap = categoryGap(cat.axis.majorTick === "out" || cat.axis.majorTick === "cross" ? tickLength(cat.axis) : 0, cat.axis.labelOffset);
  const row = gap + lineHeight(font);
  const rule = (t: number, depth: number): void => {
    const x = plot.catAt(t);
    if (s) out.push(<line key={key()} x1={x} y1={at} x2={x} y2={at + dir * depth} {...s} />);
  };
  const bottom = cat.leafDepth + cat.groups.length * row;
  for (const t of cat.tickTs) rule(t, t <= 1e-9 || t >= 1 - 1e-9 ? bottom : cat.leafDepth);
  cat.groups.forEach((level, k) => {
    const depth = cat.leafDepth + (k + 1) * row;
    const top = at + dir * (cat.leafDepth + k * row) + (dir > 0 ? gap : -gap - lineHeight(font));
    level.forEach((g, i) => {
      const end = level[i + 1]?.start ?? cat.count;
      if (g.start > 0) rule(g.start / cat.count, depth);
      out.push(label(g.text, font, plot.catAt((g.start + end) / 2 / cat.count), top, "middle", key()));
    });
  });
  return out;
}

function categoryLabels(plot: PlotLayout, cat: AxisLayout, at: number, dir: number, horizontal: boolean, key: () => string): ReactNode[] {
  const font = cat.axis.font;
  const tickOut = cat.axis.majorTick === "out" || cat.axis.majorTick === "cross" ? tickLength(cat.axis) : 0;
  const gap = horizontal ? categoryGap(tickOut, cat.axis.labelOffset) : tickOut + (6.1 * PT * cat.axis.labelOffset) / 100;
  const lh = lineHeight(font);
  const out: ReactNode[] = [];
  for (const l of cat.labels) {
    const p = plot.catAt(l.t);
    if (horizontal) {
      const top = dir > 0 ? at + gap : at - gap - (cat.wrap ? plainBlock(l.text, font, cat.wrap).h : lh);
      out.push(categoryLabel(cat, l.text, p, top, key));
    } else {
      out.push(label(l.text, font, at + dir * gap, p - lh / 2, dir < 0 ? "end" : "start", key()));
    }
  }
  return out;
}

/** A label of a horizontal category axis whose box's top is `top`, under category position `p`. */
function categoryLabel(cat: AxisLayout, text: string, p: number, top: number, key: () => string): ReactNode {
  const font = cat.axis.font;
  const lh = lineHeight(font);
  if (cat.rotation) {
    // A slanted label hangs from its category: at 45° the corner of its
    // box that ends up highest sits under the category's centre; at 90°
    // the box is centred on it (`cht-chart-props`, the AASCU combo).
    const a = (cat.rotation * Math.PI) / 180;
    const x = p - (lh / 2) * Math.SQRT2 * Math.sin(a) * Math.cos(a);
    const y = top + metrics(font)[0] * font.size * PT - lh / 2;
    return svgText([{ text, font }], x, y, cat.rotation < 0 ? "end" : "start", [cat.rotation, x, top], key());
  }
  if (cat.wrap) {
    const b = plainBlock(text, font, cat.wrap);
    return drawText(b, { x: p - b.w / 2, y: top, w: b.w, h: b.h }, 0, key());
  }
  return label(text, font, p, top, "middle", key());
}

// ── Plots ───────────────────────────────────────────────────────────────────

function pointStyle(s: ChartSeries, i: number): { fill: Fill | null; line: Line | null; effects: Effects | null; marker: ChartMarker | null } {
  const p = s.points?.[i];
  return p ? { fill: p.fill, line: p.line, effects: p.effects, marker: p.marker } : { fill: s.fill, line: s.line, effects: s.effects, marker: s.marker };
}

const num = (v: number | string | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function drawPlot(p: ChartPlot, chart: Chart, layout: Layout, paint: Paint): ReactNode {
  const plot = layout.plot;
  const out: ReactNode[] = [];
  if (p.kind === "pie") {
    if (!layout.pie) return null;
    return paint.group(chart.view3D ? drawPie3D(p, layout.pie, paint) : drawPie(p, layout.pie, paint), null);
  }
  if (p.kind === "radar") return layout.radar ? drawRadar(p, layout.radar, paint) : null;
  if (layout.box3d) return drawPlot3D(p, layout.box3d, paint);
  if (!plot || !plot.val?.scale) return null;
  if (p.kind === "bubble") return drawBubbles(p, chart, plot, paint);
  // ponytail: a 2-D surface (contour) is drawn from above as a 3-D one; nothing else lands here.
  if (p.kind === "surface") return null;
  const scale = plot.val.scale;
  const count = plot.cat?.count ?? 1;

  if (p.kind === "bar") {
    const n = p.grouping === "clustered" || p.grouping === "standard" ? p.series.length : 1;
    const catLen = plot.cat?.band ?? (plot.horizontal ? plot.inner.h : plot.inner.w) / count;
    const overlap = Math.max(-100, Math.min(100, p.grouping === "clustered" || p.grouping === "standard" ? p.overlap : 100)) / 100;
    // n bars, each overlapping the next by `overlap` of a bar, and a gap
    // between groups of `gapWidth` percent of a bar.
    const bw = catLen / (n - (n - 1) * overlap + p.gapWidth / 100);
    const stackPos: number[] = Array.from({ length: count }, () => 0);
    const stackNeg: number[] = Array.from({ length: count }, () => 0);
    const totals = Array.from({ length: count }, (_, i) => p.series.reduce((sum, s) => sum + Math.abs(num(s.values.values[i]) ?? 0), 0));
    p.series.forEach((s, k) => {
      const shapes: ReactNode[] = [];
      for (let i = 0; i < count; i++) {
        let v = num(s.values.values[i]);
        if (v === null) continue;
        if (p.grouping === "percentStacked") v = totals[i] ? v / totals[i]! : 0;
        let from = 0;
        let to = v;
        if (p.grouping === "stacked" || p.grouping === "percentStacked") {
          if (v >= 0) {
            from = stackPos[i]!;
            to = from + v;
            stackPos[i] = to;
          } else {
            from = stackNeg[i]!;
            to = from + v;
            stackNeg[i] = to;
          }
        }
        const clamp = (x: number): number => Math.min(scale.max, Math.max(scale.min, x));
        const a = plot.valPos(clamp(from === 0 ? Math.min(scale.max, Math.max(scale.min, 0)) : from));
        const b = plot.valPos(clamp(to));
        const center = plot.catPos(i);
        const slot = n === 1 ? 0 : k * bw * (1 - overlap) - ((n - 1) * bw * (1 - overlap)) / 2;
        // Bars go left to right in series order; on horizontal bars, bottom to top.
        const c = plot.horizontal ? center - slot : center + slot;
        const rect: Rect = plot.horizontal
          ? { x: Math.min(a, b), y: c - bw / 2, w: Math.abs(b - a), h: bw }
          : { x: c - bw / 2, y: Math.min(a, b), w: bw, h: Math.abs(b - a) };
        const st = pointStyle(s, i);
        shapes.push(paint.shape(rect, st.fill, st.line, null));
      }
      out.push(paint.group(shapes, s.effects));
    });
    return paint.group(out, null);
  }

  if (p.kind === "area" || p.kind === "line") {
    const stacked = p.grouping === "stacked" || p.grouping === "percentStacked";
    const acc = Array.from({ length: count }, () => 0);
    const totals = Array.from({ length: count }, (_, i) => p.series.reduce((sum, s) => sum + (num(s.values.values[i]) ?? 0), 0));
    const layers: { s: ChartSeries; pts: ([number, number] | null)[]; lower: [number, number][] }[] = [];
    for (const s of p.series) {
      const pts: ([number, number] | null)[] = [];
      const lower: [number, number][] = [];
      for (let i = 0; i < count; i++) {
        let v = num(s.values.values[i]);
        if (v !== null && p.grouping === "percentStacked") v = totals[i] ? v / totals[i]! : 0;
        const prev = acc[i]!;
        const top = stacked ? prev + (v ?? 0) : v;
        if (stacked) acc[i] = top ?? prev;
        const x = plot.catPos(i);
        lower.push(plot.horizontal ? [plot.valPos(stacked ? prev : 0), x] : [x, plot.valPos(stacked ? prev : Math.min(scale.max, Math.max(scale.min, 0)))]);
        if (top === null || (v === null && !stacked)) pts.push(null);
        else pts.push(plot.horizontal ? [plot.valPos(top), x] : [x, plot.valPos(top)]);
      }
      layers.push({ s, pts, lower });
    }
    if (p.kind === "area") {
      for (const { s, pts, lower } of layers) {
        const ring = [...pts.map((q, i) => q ?? lower[i]!), ...lower.slice().reverse()];
        const box = boundsOf(ring);
        const d = `M${ring.map((q) => `${q[0] - box.x} ${q[1] - box.y}`).join("L")}Z`;
        out.push(paint.group([paint.shape(d, s.fill, s.line, null, box)], s.effects));
      }
      return paint.group(out, null);
    }
    for (const { s, pts } of layers) out.push(drawLine(s, pts, paint));
    return paint.group(out, null);
  }

  // Scatter.
  for (const s of p.series) {
    const xs = xValuesOf(s);
    const pts = s.values.values.map((v, i) => {
      const y = num(v);
      const x = xs[i];
      return y === null || x === null || x === undefined ? null : ([plot.catPos(x), plot.valPos(y)] as [number, number]);
    });
    out.push(drawLine(s, pts, paint));
  }
  return paint.group(out, null);
}

function boundsOf(points: [number, number][]): Rect {
  const xs = points.map((q) => q[0]);
  const ys = points.map((q) => q[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x || 1, h: Math.max(...ys) - y || 1 };
}

/** A series' line (straight or smoothed, broken at gaps) and its markers. */
function drawLine(s: ChartSeries, pts: ([number, number] | null)[], paint: Paint, markers = pts.length): ReactNode {
  const out: ReactNode[] = [];
  if (s.line?.fill) {
    let d = "";
    let run: [number, number][] = [];
    const flush = (): void => {
      if (run.length > 1) d += s.smooth ? smoothPath(run) : `M${run.map((q) => `${q[0]} ${q[1]}`).join("L")}`;
      run = [];
    };
    for (const q of pts) {
      if (q) run.push(q);
      else flush();
    }
    flush();
    if (d) out.push(paint.shape(d, null, { ...s.line, join: "round" }, null));
  }
  pts.forEach((q, i) => {
    const m = pointStyle(s, i).marker;
    if (q && m && i < markers) out.push(drawMarker(m, q[0], q[1], paint));
  });
  return paint.group(out, s.effects);
}

function drawMarker(m: ChartMarker, x: number, y: number, paint: Paint, size = m.size): ReactNode {
  const r = (size * PT) / 2;
  const sized = { ...m, size };
  return paint.shape(markerPath(sized, r, r), m.fill, m.line, m.effects, { x: x - r, y: y - r, w: 2 * r, h: 2 * r });
}

/** Office smooths with a Catmull-Rom-like spline through the points. */
function smoothPath(p: [number, number][]): string {
  let d = `M${p[0]![0]} ${p[0]![1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i]!;
    const p1 = p[i]!;
    const p2 = p[i + 1]!;
    const p3 = p[i + 2] ?? p2;
    const t = 1 / 6;
    d += `C${p1[0] + (p2[0] - p0[0]) * t} ${p1[1] + (p2[1] - p0[1]) * t} ${p2[0] - (p3[0] - p1[0]) * t} ${p2[1] - (p3[1] - p1[1]) * t} ${p2[0]} ${p2[1]}`;
  }
  return d;
}

function markerPath(m: ChartMarker, x: number, y: number): string {
  const r = (m.size * PT) / 2;
  switch (m.symbol) {
    case "square":
      return `M${x - r} ${y - r}h${2 * r}v${2 * r}h${-2 * r}Z`;
    case "diamond":
      return `M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z`;
    case "triangle":
      return `M${x} ${y - r}L${x + r} ${y + r}L${x - r} ${y + r}Z`;
    case "x":
      return `M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}`;
    case "star":
      return `M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}M${x} ${y - r}V${y + r}`;
    case "plus":
      return `M${x - r} ${y}H${x + r}M${x} ${y - r}V${y + r}`;
    case "dash":
      return `M${x - r} ${y - r / 4}h${2 * r}v${r / 2}h${-2 * r}Z`;
    case "dot": {
      const q = r / 2;
      return `M${x - q} ${y}a${q} ${q} 0 1 0 ${2 * q} 0a${q} ${q} 0 1 0 ${-2 * q} 0Z`;
    }
    case "none":
      return "";
    default:
      return `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  }
}

type Slice = { s: ChartSeries; i: number; value: number; start: number; sweep: number; r0: number; r1: number; total: number };

/** A pie's slices — a doughnut's, ring by ring from the hole out: angles
 *  clockwise from twelve o'clock, radii. */
function slices(p: Extract<ChartPlot, { kind: "pie" }>, pie: { r: number; first: number | null }): Slice[][] {
  const rings = p.holeSize > 0 ? p.series : p.series.slice(0, 1);
  const hole = (pie.r * p.holeSize) / 100;
  const ringW = (pie.r - hole) / Math.max(1, rings.length);
  return rings.map((s, k) => {
    const values = s.values.values.map((v) => Math.max(0, num(v) ?? 0));
    const total = values.reduce((a, b) => a + b, 0);
    let angle = pie.first ?? p.firstSliceAngle;
    return values.map((value, i) => {
      const sweep = total ? (value / total) * 360 : 0;
      const slice = { s, i, value, start: angle, sweep, r0: p.holeSize > 0 ? hole + ringW * k : 0, r1: p.holeSize > 0 ? hole + ringW * (k + 1) : pie.r, total };
      angle += sweep;
      return slice;
    });
  });
}

function drawPie(p: Extract<ChartPlot, { kind: "pie" }>, pie: PieLayout, paint: Paint): ReactNode[] {
  const box = { x: pie.cx - pie.r, y: pie.cy - pie.r, w: 2 * pie.r, h: 2 * pie.r };
  return slices(p, pie).map((ring) => {
    const shapes = ring
      .filter((sl) => sl.value > 0)
      .map((sl) => {
        const st = pointStyle(sl.s, sl.i);
        const explosion = ((sl.s.points?.[sl.i]?.explosion ?? sl.s.explosion) / 100) * pie.r;
        const mid = ((sl.start + sl.sweep / 2 - 90) * Math.PI) / 180;
        const cx = pie.cx + Math.cos(mid) * explosion - box.x;
        const cy = pie.cy + Math.sin(mid) * explosion - box.y;
        return paint.shape(sector(cx, cy, sl.r0, sl.r1, sl.start, sl.sweep), st.fill, st.line, null, box);
      });
    return paint.group(shapes, ring[0]?.s.effects ?? null);
  });
}

/** A slice (or ring segment) from `start` clockwise by `sweep` degrees, 0 at
 *  twelve o'clock; `tilt` squashes it vertically (a 3-D pie's top). */
function sector(cx: number, cy: number, r0: number, r1: number, start: number, sweep: number, tilt = 1): string {
  const pt = (r: number, a: number): string => {
    const t = ((a - 90) * Math.PI) / 180;
    return `${cx + Math.cos(t) * r} ${cy + Math.sin(t) * r * tilt}`;
  };
  const arc = (r: number): string => `${r} ${r * tilt}`;
  if (sweep >= 359.999) {
    const ring = `M${pt(r1, 0)}A${arc(r1)} 0 1 1 ${pt(r1, 180)}A${arc(r1)} 0 1 1 ${pt(r1, 360)}Z`;
    return r0 > 0 ? `${ring}M${pt(r0, 0)}A${arc(r0)} 0 1 0 ${pt(r0, 180)}A${arc(r0)} 0 1 0 ${pt(r0, 360)}Z` : ring;
  }
  const large = sweep > 180 ? 1 : 0;
  if (r0 <= 0) return `M${cx} ${cy}L${pt(r1, start)}A${arc(r1)} 0 ${large} 1 ${pt(r1, start + sweep)}Z`;
  return `M${pt(r1, start)}A${arc(r1)} 0 ${large} 1 ${pt(r1, start + sweep)}L${pt(r0, start + sweep)}A${arc(r0)} 0 ${large} 0 ${pt(r0, start)}Z`;
}

// ── Radar ───────────────────────────────────────────────────────────────────

type RadarLayout = {
  cx: number;
  cy: number;
  r: number;
  scale: Scale;
  /** Each category's angle, degrees clockwise from twelve o'clock. */
  angles: number[];
  labels: (Block | null)[];
};

/** Category labels sit this far past the web; beside it they keep this much more from the plot's edge. */
const RADAR_GAP = 4 * PT;
const RADAR_MARGIN = 8 * PT;
/**
 * Fitted on five radars (`cht-chart-type`, `cht-chart-props`, POI's
 * `radar-chart`, Större): labels break at 0.234 of the chart's width —
 * "05/01/200" fits a 448 px chart, not a 441 px one —; the web is as big as
 * the labels beside it let it be, and leaves `RADAR_TOP` above and below
 * whatever the labels' size (43 px at 10 pt and at 18 pt: a two-line label
 * above overflows the chart); its scale has
 * at most five intervals whatever the text size (0..40 by 10 on an 85 px
 * radius at 18 pt, 0..10 by 2 on 143 px at 10 pt).
 */
const RADAR_WRAP = 0.234;
const RADAR_TOP = { labelled: 32.5 * PT, bare: 5 * PT };
const RADAR_INTERVALS = 5;

/** An axis with nothing set, for a chart part that has none. */
function bareAxis(font: ChartFont, kind: ChartAxis["kind"]): ChartAxis {
  return {
    kind,
    deleted: true,
    reversed: false,
    min: null,
    max: null,
    majorUnit: null,
    minorUnit: null,
    format: null,
    labels: "nextTo",
    majorTick: "none",
    line: null,
    majorGrid: null,
    minorGrid: null,
    font,
    rotation: null,
    crosses: "autoZero",
    between: true,
    title: null,
    labelSkip: null,
    tickSkip: null,
    labelOffset: 100,
  };
}

/** Text broken at spaces to `max`, and a word longer than that at any character. */
function wrapAnywhere(text: string, font: ChartFont, max: number): Block {
  const words: string[] = [];
  for (const word of text.split(" ")) {
    let w = word;
    while (w.length > 1 && textWidth(w, font) > max) {
      let n = w.length - 1;
      while (n > 1 && textWidth(w.slice(0, n), font) > max) n--;
      words.push(w.slice(0, n));
      w = w.slice(n);
    }
    words.push(w);
  }
  return plainBlock(words.join(" "), font, max);
}

/**
 * A radar centred in its space, as big as its category labels let it be:
 * each label hangs off its spoke's end — above or below the web at twelve
 * and six o'clock, beside it (centred on the spoke's end) elsewhere — broken
 * to a fifth of the chart's width.
 */
function layoutRadar(chart: Chart, r: Rect, W: number): RadarLayout {
  const count = Math.max(chart.categories.values.length, ...chart.plots.flatMap((p) => p.series.map((s) => s.values.values.length)), 1);
  const cat = chart.categoryAxis;
  const angles = Array.from({ length: count }, (_, i) => ((cat?.reversed ? -360 : 360) * i) / count);
  const shown = !!cat && !cat.deleted && cat.labels !== "none";
  const font = cat?.font ?? chart.font;
  const fmt = cat?.format ?? chart.categories.format;
  const labels = angles.map((_, i) =>
    shown ? wrapAnywhere(formatValue(chart.categories.values[i] ?? i + 1, fmt, chart.date1904), font, W * RADAR_WRAP) : null,
  );
  let radius = Math.min(r.w / 2, r.h / 2 - (shown ? RADAR_TOP.labelled : RADAR_TOP.bare));
  angles.forEach((a, i) => {
    const b = labels[i];
    const ux = Math.abs(Math.sin((a * Math.PI) / 180));
    if (b && ux > 0.05) radius = Math.min(radius, (r.w / 2 - RADAR_MARGIN - RADAR_GAP - b.w) / ux);
  });
  radius = Math.max(1, radius);
  const val = chart.valueAxis ?? bareAxis(chart.font, "value");
  const [lo, hi] = valueRange(chart.plots);
  const scale = valueScale(lo, hi, val, radius, radius / (RADAR_INTERVALS + 1), false);
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, r: radius, scale, angles, labels };
}

/** Where value `v` of category `i` sits. */
function radarPoint(rd: RadarLayout, i: number, v: number): [number, number] {
  const t = Math.max(0, (v - rd.scale.min) / (rd.scale.max - rd.scale.min || 1));
  const a = ((rd.angles[i] ?? 0) * Math.PI) / 180;
  return [rd.cx + Math.sin(a) * t * rd.r, rd.cy - Math.cos(a) * t * rd.r];
}

/** The web: a polygon per major value, and the spokes (the category axis's gridlines). */
function drawRadarBehind(chart: Chart, rd: RadarLayout, key: () => string): ReactNode[] {
  const out: ReactNode[] = [];
  const stroke = (l: Line): Record<string, string | number | undefined> => strokeProps(l, l.fill?.kind === "solid" ? l.fill.color : "none");
  const val = chart.valueAxis;
  for (const [grid, step] of [
    [val?.minorGrid ?? null, rd.scale.minor],
    [val?.majorGrid ?? null, rd.scale.major],
  ] as const) {
    if (!grid) continue;
    for (const v of ticks(rd.scale, step)) {
      if (v <= rd.scale.min) continue;
      const d = `M${rd.angles.map((_, i) => radarPoint(rd, i, v).join(" ")).join("L")}Z`;
      out.push(<path key={key()} d={d} fill="none" {...stroke(grid)} />);
    }
  }
  const spokes = chart.categoryAxis?.majorGrid;
  if (spokes) {
    for (let i = 0; i < rd.angles.length; i++) {
      const [x, y] = radarPoint(rd, i, rd.scale.max);
      out.push(<line key={key()} x1={rd.cx} y1={rd.cy} x2={x} y2={y} {...stroke(spokes)} />);
    }
  }
  return out;
}

/** The value axis up the first spoke, labelled on its left; the category labels round the web. */
function drawRadarFront(chart: Chart, rd: RadarLayout, key: () => string): ReactNode[] {
  const out: ReactNode[] = [];
  const val = chart.valueAxis;
  if (val && !val.deleted) {
    const [tx, ty] = radarPoint(rd, 0, rd.scale.max);
    const s = val.line?.fill ? strokeProps(val.line, val.line.fill.kind === "solid" ? val.line.fill.color : "none") : null;
    if (s) out.push(<line key={key()} x1={rd.cx} y1={rd.cy} x2={tx} y2={ty} {...s} />);
    const tick = val.majorTick === "out" || val.majorTick === "cross" ? tickLength(val) : 0;
    for (const v of ticks(rd.scale, rd.scale.major)) {
      const [x, y] = radarPoint(rd, 0, v);
      if (s && val.majorTick !== "none") {
        out.push(<line key={key()} x1={x - tick} y1={y} x2={x + (val.majorTick === "out" ? 0 : tickLength(val))} y2={y} {...s} />);
      }
      if (val.labels !== "none") {
        const text = formatValue(v, val.format ?? firstFormat(chart, false), chart.date1904);
        out.push(label(text, val.font, x - valueGap(tick), y - lineHeight(val.font) / 2, "end", key()));
      }
    }
  }
  rd.angles.forEach((a, i) => {
    const b = rd.labels[i];
    if (!b) return;
    const ux = Math.sin((a * Math.PI) / 180);
    const uy = -Math.cos((a * Math.PI) / 180);
    const ax = rd.cx + ux * (rd.r + RADAR_GAP);
    const ay = rd.cy + uy * (rd.r + RADAR_GAP);
    const rect =
      Math.abs(ux) < 0.05
        ? { x: ax - b.w / 2, y: uy < 0 ? ay - b.h : ay, w: b.w, h: b.h }
        : { x: ux > 0 ? ax : ax - b.w, y: ay - b.h / 2, w: b.w, h: b.h };
    out.push(drawText(b, rect, 0, key()));
  });
  return out;
}

function drawRadar(p: Extract<ChartPlot, { kind: "radar" }>, rd: RadarLayout, paint: Paint): ReactNode {
  const out: ReactNode[] = [];
  for (const s of p.series) {
    const pts = rd.angles.map((_, i) => {
      const v = num(s.values.values[i]);
      return v === null ? null : radarPoint(rd, i, v);
    });
    if (p.filled) {
      const ring = pts.map((q) => q ?? ([rd.cx, rd.cy] as [number, number]));
      const box = boundsOf(ring);
      const d = `M${ring.map((q) => `${q[0] - box.x} ${q[1] - box.y}`).join("L")}Z`;
      out.push(paint.group([paint.shape(d, s.fill, s.line, null, box)], s.effects));
    } else {
      // A radar's line closes on its first point.
      out.push(drawLine(s, pts[0] ? [...pts, pts[0]] : pts, paint, pts.length));
    }
  }
  return paint.group(out, null);
}

// ── Bubbles ─────────────────────────────────────────────────────────────────

/**
 * Bubble diameters (EMU) per series and point; `null` where none is drawn.
 * The biggest is a quarter of the plot area's smaller side — its inside plus
 * the tick labels hanging out of it (measured on five python-pptx decks: 66,
 * 85, 86 and 95 px against 264, 340, 344 and 380) — times `bubbleScale`; the
 * rest by area, or by width with `sizeRepresents="w"`.
 */
function bubbleSizes(p: Extract<ChartPlot, { kind: "bubble" }>, chart: Chart, base: number): (number | null)[][] {
  const bubbles = chart.plots.flatMap((q) => (q.kind === "bubble" ? q.series : []));
  const biggest = Math.max(0, ...bubbles.flatMap((s) => (s.sizes?.values ?? []).map((v) => Math.abs(num(v) ?? 0))));
  return p.series.map((s) =>
    s.values.values.map((_, i) => {
      const v = num(s.sizes?.values[i]);
      if (v === null || v === 0 || (v < 0 && !p.negatives) || !biggest) return null;
      const f = Math.abs(v) / biggest;
      return base * (p.scale / 100) * (p.byWidth ? f : Math.sqrt(f));
    }),
  );
}

/** A bubble's fill drawn as a sphere: lit high on the left, dark at the rim. */
function sphere(fill: Fill | null): Fill | null {
  const c = baseColor(fill);
  if (!c) return fill;
  return {
    kind: "path",
    shape: "circle",
    focus: { l: 0.4, t: 0.3, r: 0.6, b: 0.7 },
    stops: [
      { pos: 0, color: shade(c, 1.45) },
      { pos: 0.55, color: c },
      { pos: 1, color: shade(c, 0.45) },
    ],
  };
}

/** Bubbles, cut at the plot's edges like Office's (a bubble at an axis's maximum shows half). */
function drawBubbles(p: Extract<ChartPlot, { kind: "bubble" }>, chart: Chart, plot: PlotLayout, paint: Paint): ReactNode {
  const sizes = bubbleSizes(p, chart, plot.bubbleBase);
  return paint.clip(
    plot.inner,
    p.series.map((s, k) => {
      const xs = xValuesOf(s);
      const shapes = s.values.values.map((raw, i) => {
        const y = num(raw);
        const x = xs[i];
        const d = sizes[k]?.[i];
        if (y === null || x === null || x === undefined || !d) return null;
        const st = pointStyle(s, i);
        const neg = (num(s.sizes?.values[i]) ?? 0) < 0;
        const r = d / 2;
        const cx = plot.catPos(x);
        const cy = plot.valPos(y);
        const fill = neg ? null : s.bubble3D ? sphere(st.fill) : st.fill;
        return paint.shape(`M0 ${r}a${r} ${r} 0 1 0 ${d} 0a${r} ${r} 0 1 0 ${-d} 0Z`, fill, st.line ?? (neg ? s.line : null), null, { x: cx - r, y: cy - r, w: d, h: d });
      });
      return paint.group(shapes, s.effects);
    }),
  );
}

// ── Colour ──────────────────────────────────────────────────────────────────

/** An `rgb()`/`rgba()` colour times `k` (> 1 lightens towards white). */
function shade(color: string, k: number): string {
  const m = /^rgba?\(([^)]*)\)$/.exec(color);
  if (!m) return color;
  const [r = 0, g = 0, b = 0, a = 1] = m[1]!.split(",").map(Number);
  const f = (x: number): number => Math.round(Math.min(255, Math.max(0, k <= 1 ? x * k : x + (255 - x) * (k - 1))));
  return a === 1 ? `rgb(${f(r)},${f(g)},${f(b)})` : `rgba(${f(r)},${f(g)},${f(b)},${a})`;
}

/** A fill's main colour: a gradient's middle, a pattern's foreground. */
function baseColor(fill: Fill | null): string | null {
  if (!fill) return null;
  if (fill.kind === "solid") return fill.color;
  if (fill.kind === "linear" || fill.kind === "path") return fill.stops[Math.floor(fill.stops.length / 2)]?.color ?? null;
  if (fill.kind === "pattern") return fill.fg;
  return null;
}

/** A fill darkened (or lightened) by `k`, gradient stops and all. */
function shadeFill(fill: Fill | null, k: number): Fill | null {
  if (!fill || k === 1) return fill;
  switch (fill.kind) {
    case "solid":
      return { ...fill, color: shade(fill.color, k) };
    case "linear":
    case "path":
      return { ...fill, stops: fill.stops.map((s) => ({ ...s, color: shade(s.color, k) })) };
    case "pattern":
      return { ...fill, fg: shade(fill.fg, k), bg: shade(fill.bg, k) };
    default:
      return fill;
  }
}

// ── 3-D ─────────────────────────────────────────────────────────────────────

/** World coordinates: x across, y up, z away from the eye; a category's band is 1. */
type Vec = [number, number, number];

type Box3D = {
  view: Chart3D;
  /** Categories run along x (else along y: horizontal bars). */
  columns: boolean;
  size: Vec;
  count: number;
  rows: number;
  /** The share of a row a bar or an area is deep. */
  thickness: number;
  val: AxisLayout;
  cat: AxisLayout;
  /** World → screen (EMU), and depth (larger: farther). */
  at: (p: Vec) => [number, number, number];
  /** Where the eye looks: a face is seen when its normal points against it. */
  eye: Vec;
  /** A value's coordinate along the value direction; category `i`'s along the other. */
  v: (value: number) => number;
  c: (i: number) => number;
  /** The side wall's x: the side away from the eye. */
  side: number;
};

/**
 * How Office sees a 3-D chart: turned `rotY` about the vertical, the right
 * coming forward, then tipped `rotX` towards the eye, in perspective over a
 * field of view of `fov`. With right-angled axes the front stays square and
 * depth runs off obliquely along the same turned direction.
 */
function projection(view: Chart3D, size: Vec): { at: (p: Vec) => [number, number, number]; eye: Vec } {
  const [X, Y, Z] = size;
  const ry = (view.rotY * Math.PI) / 180;
  const rx = (view.rotX * Math.PI) / 180;
  const eye: Vec = [-Math.sin(ry) * Math.cos(rx), -Math.sin(rx), Math.cos(ry) * Math.cos(rx)];
  const depth = (p: Vec): number => eye[0] * (p[0] - X / 2) + eye[1] * (p[1] - Y / 2) + eye[2] * (p[2] - Z / 2);
  if (view.rightAngles) {
    const kx = Math.sin(ry);
    const ky = Math.cos(ry) * Math.sin(rx);
    return { at: (p) => [p[0] + p[2] * kx, -(p[1] + p[2] * ky), depth(p)], eye: [-kx, -ky, 1] };
  }
  const R = Math.hypot(X, Y, Z) / 2;
  const dist = view.fov > 0 ? Math.max(1.5 * R, R / Math.tan((view.fov * Math.PI) / 360)) : Infinity;
  return {
    at: (p) => {
      const x = p[0] - X / 2;
      const y = p[1] - Y / 2;
      const z = p[2] - Z / 2;
      const x1 = x * Math.cos(ry) + z * Math.sin(ry);
      const z1 = -x * Math.sin(ry) + z * Math.cos(ry);
      const y2 = y * Math.cos(rx) + z1 * Math.sin(rx);
      const z2 = -y * Math.sin(rx) + z1 * Math.cos(rx);
      const f = dist === Infinity ? 1 : dist / (dist + z2);
      return [x1 * f, -y2 * f, z2];
    },
    eye,
  };
}

const corners = (s: Vec): Vec[] => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k & 1 ? s[0] : 0, k & 2 ? s[1] : 0, k & 4 ? s[2] : 0]);

/**
 * The box fitted to `inner`: the value extent (`dims(h)`) chosen so the box's
 * picture has `inner`'s proportions — Office's autoscaled height — unless
 * `height` is given, then scaled and centred to fit.
 */
function fit3D(
  view: Chart3D,
  dims: (h: number) => Vec,
  inner: Rect,
  height: number | null,
): { size: Vec; at: (p: Vec) => [number, number, number]; eye: Vec } {
  const bounds = (size: Vec): { x: number; y: number; w: number; h: number } => {
    const pts = corners(size).map(projection(view, size).at);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x || 1e-9, h: Math.max(...ys) - y || 1e-9 };
  };
  const unit = Math.max(...dims(0).map(Math.abs), 1);
  const miss = (t: number): number => {
    const b = bounds(dims(Math.exp(t) * unit));
    return Math.log(b.h / b.w) - Math.log(inner.h / inner.w);
  };
  let a = Math.log(0.02);
  let z = Math.log(50);
  const rising = miss(z) > miss(a);
  for (let k = 0; k < 40; k++) {
    const m = (a + z) / 2;
    if (miss(m) > 0 === rising) z = m;
    else a = m;
  }
  const size = dims(height ?? Math.exp((a + z) / 2) * unit);
  const pr = projection(view, size);
  const b = bounds(size);
  const s = Math.min(inner.w / b.w, inner.h / b.h);
  const ox = inner.x + (inner.w - b.w * s) / 2 - b.x * s;
  const oy = inner.y + (inner.h - b.h * s) / 2 - b.y * s;
  return {
    size,
    eye: pr.eye,
    at: (p) => {
      const q = pr.at(p);
      return [ox + q[0] * s, oy + q[1] * s, q[2]];
    },
  };
}

function layout3D(chart: Chart, view: Chart3D, outer: Rect, innerGiven: boolean): Box3D {
  const p0 = chart.plots[0]!;
  const columns = !(p0.kind === "bar" && p0.horizontal);
  const bars = p0.kind === "bar";
  const grouping = "grouping" in p0 ? p0.grouping : "standard";
  const count = Math.max(chart.categories.values.length, ...chart.plots.flatMap((p) => p.series.map((s) => s.values.values.length)), 1);
  const rows = p0.kind === "surface" || p0.kind === "line" || grouping === "standard" ? Math.max(1, p0.series.length) : 1;
  const [lo, hi] = valueRange(chart.plots);
  const valAxis = chart.valueAxis ?? bareAxis(chart.font, "value");
  const catAxis = chart.categoryAxis ?? bareAxis(chart.font, "category");
  // The front face takes about three quarters of each side: enough to pick a
  // major unit and to see whether category labels need turning.
  // A 3-D value axis ends at the data: 0..700 for a top of 700 (the dark deck).
  const guess = (r: Rect): [AxisLayout, AxisLayout] => [
    valueAxisLayout(valAxis, lo, hi, (columns ? r.h : r.w) * 0.75, !columns, grouping === "percentStacked", firstFormat(chart, false), chart, 0),
    categoryAxisLayout(catAxis, chart, count, !bars, (columns ? r.w : r.h) * 0.75, columns),
  ];
  let [val, cat] = guess(outer);
  let inner = outer;
  if (!innerGiven) {
    const left = columns ? val.depth : cat.depth;
    const bottom = columns ? cat.depth : val.depth;
    inner = { x: outer.x + left, y: outer.y + PLOT_TOP, w: Math.max(1, outer.w - left - PLOT_RIGHT), h: Math.max(1, outer.h - PLOT_TOP - bottom) };
    [val, cat] = guess(inner);
  }
  const X = bars ? count : Math.max(1, count - 1);
  // A row is `depthPercent` of a category's band deep (areas and lines have
  // their points on the ticks, so a band is a little under an interval);
  // past 100% it deepens slower — the dark deck's 650% area is 2.5 bands
  // deep, not 5.6.
  const depth = view.depth <= 100 ? view.depth : 100 * Math.sqrt(view.depth / 100);
  const Z = ((rows * depth) / 100) * (X / count);
  // In perspective the box's height grows slower than its width and shrinks
  // with every row behind the first: fitted on python-pptx's 3-D areas and
  // the dark deck's bars and pyramids (3.7 for 4 categories wide, 6.9 for
  // 10; 2.5 and 1.8 with 2 and 3 rows). Right-angled axes fill the plot area.
  const height = view.rightAngles || !columns ? null : (1.44 * Math.pow(X, 0.68)) / (1 + 0.5 * (rows - 1));
  const fit = fit3D(view, (h) => (columns ? [X, h, Z] : [h, X, Z]), inner, height);
  const extent = columns ? fit.size[1] : fit.size[0];
  const sc = val.scale!;
  return {
    view,
    columns,
    size: fit.size,
    count,
    rows,
    thickness: 1 / (1 + view.gapDepth / 100),
    val,
    cat,
    at: fit.at,
    eye: fit.eye,
    v: (value) => ((Math.min(sc.max, Math.max(sc.min, value)) - sc.min) / (sc.max - sc.min || 1)) * extent,
    c: (i) => (bars ? i + 0.5 : count > 1 ? i : 0.5),
    side: view.rotY % 360 > 180 || view.rotY < 0 ? fit.size[0] : 0,
  };
}

/** A world point on the category (`u`) / value (`val`) / depth axes. */
const point3 = (b: Box3D, u: number, val: number, z: number): Vec => (b.columns ? [u, val, z] : [val, u, z]);

/**
 * Office's light, fitted on its bars: a face turned to the front keeps its
 * colour, the top is 0.76 of it and the right side 0.62 — measured alike with
 * and without right-angled axes (a 2016 dark deck, LibreOffice's `100610`).
 */
const LIGHT: Vec = [0.3, 0.49, -0.82];
function lit(n: Vec): number {
  const len = Math.hypot(...n) || 1;
  return 0.4 + 0.733 * Math.max(0, (n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]) / len);
}

const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

type Face = { pts: Vec[]; n: Vec; fill: Fill | null; line: Line | null; shade: boolean };

/** Faces the eye sees, farthest first. */
function drawFaces(b: Box3D, faces: Face[], paint: Paint): ReactNode[] {
  return faces
    .filter((f) => dot(f.n, b.eye) < -1e-9)
    .map((f) => ({ f, pts: f.pts.map(b.at) }))
    .map((x) => ({ ...x, depth: x.pts.reduce((s, p) => s + p[2], 0) / x.pts.length }))
    .sort((x, y) => y.depth - x.depth)
    .map(({ f, pts }) => {
      const box = boundsOf(pts.map((p) => [p[0], p[1]]));
      const d = `M${pts.map((p) => `${p[0] - box.x} ${p[1] - box.y}`).join("L")}Z`;
      return paint.shape(d, f.shade ? shadeFill(f.fill, lit(f.n)) : f.fill, f.line, null, box);
    });
}

/** The back wall, the side wall and the floor, and the value gridlines over them. */
function draw3DBehind(b: Box3D, paint: Paint, key: () => string): ReactNode[] {
  const v = b.view;
  const [X, Y, Z] = b.size;
  const s = b.side;
  const out: ReactNode[] = [
    ...drawFaces(
      b,
      [
        { pts: [[0, 0, Z], [X, 0, Z], [X, Y, Z], [0, Y, Z]], n: [0, 0, -1], fill: v.backWall.fill, line: v.backWall.line, shade: false },
        { pts: [[s, 0, 0], [s, 0, Z], [s, Y, Z], [s, Y, 0]], n: [s ? -1 : 1, 0, 0], fill: v.sideWall.fill, line: v.sideWall.line, shade: false },
        { pts: [[0, 0, 0], [X, 0, 0], [X, 0, Z], [0, 0, Z]], n: [0, 1, 0], fill: v.floor.fill, line: v.floor.line, shade: false },
      ],
      paint,
    ),
  ];
  const sc = b.val.scale!;
  const axis = b.val.axis;
  for (const [grid, step] of [
    [axis.minorGrid, sc.minor],
    [axis.majorGrid, sc.major],
  ] as const) {
    if (!grid?.fill) continue;
    const stroke = strokeProps(grid, grid.fill.kind === "solid" ? grid.fill.color : "none");
    for (const t of ticks(sc, step)) {
      const w = b.v(t);
      const pts = b.columns ? [b.at([s, w, 0]), b.at([s, w, Z]), b.at([X - s, w, Z])] : [b.at([w, 0, 0]), b.at([w, 0, Z]), b.at([w, Y, Z])];
      out.push(<polyline key={key()} points={pts.map((p) => `${p[0]},${p[1]}`).join(" ")} fill="none" {...stroke} />);
    }
  }
  return out;
}

/** Axis lines along the front edges, value labels left of (or under) the front, category labels under (or left of) it. */
function draw3DFront(b: Box3D, key: () => string): ReactNode[] {
  const out: ReactNode[] = [];
  const [X, Y] = b.size;
  for (const [a, along] of [
    [b.cat, b.columns ? "x" : "y"],
    [b.val, b.columns ? "y" : "x"],
  ] as const) {
    const axis = a.axis;
    if (axis.deleted) continue;
    const end = b.at(along === "x" ? [X, 0, 0] : [0, Y, 0]);
    const o = b.at([0, 0, 0]);
    if (axis.line?.fill) {
      out.push(<line key={key()} x1={o[0]} y1={o[1]} x2={end[0]} y2={end[1]} {...strokeProps(axis.line, axis.line.fill.kind === "solid" ? axis.line.fill.color : "none")} />);
    }
    const font = axis.font;
    const tick = axis.majorTick === "out" || axis.majorTick === "cross" ? tickLength(axis) : 0;
    for (const l of a.labels) {
      const w = a.scale ? b.v(l.at) : b.c(l.at);
      const p = b.at(along === "x" ? [w, 0, 0] : [0, w, 0]);
      if (along === "y") out.push(label(l.text, font, p[0] - (a.scale ? valueGap(tick) : tick + 6.1 * PT), p[1] - lineHeight(font) / 2, "end", key()));
      else out.push(categoryLabel(a, l.text, p[0], p[1] + categoryGap(tick, axis.labelOffset), key));
    }
  }
  return out;
}

type Bar3D = { s: ChartSeries; i: number; u: number; hu: number; z: number; hd: number; from: number; to: number; taper: [number, number] };

/** Every bar of a 3-D bar plot, in world units. */
function bars3D(p: Extract<ChartPlot, { kind: "bar" }>, b: Box3D): Bar3D[] {
  const stacked = p.grouping === "stacked" || p.grouping === "percentStacked";
  const rowsOfSeries = b.rows > 1;
  const n = stacked || rowsOfSeries ? 1 : p.series.length;
  const bw = 1 / (n + p.gapWidth / 100);
  const depth = b.size[2] / b.rows;
  const hd = (depth * b.thickness) / 2;
  const sc = b.val.scale!;
  const totals = Array.from({ length: b.count }, (_, i) => p.series.reduce((sum, s) => sum + Math.abs(num(s.values.values[i]) ?? 0), 0));
  const tops = Array.from({ length: b.count }, (_, i) => p.series.reduce((sum, s) => sum + Math.max(0, num(s.values.values[i]) ?? 0), 0));
  const pos = Array.from({ length: b.count }, () => 0);
  const neg = Array.from({ length: b.count }, () => 0);
  const shape = b.view.shape;
  const base = Math.min(sc.max, Math.max(sc.min, 0));
  const out: Bar3D[] = [];
  p.series.forEach((s, k) => {
    for (let i = 0; i < b.count; i++) {
      let v = num(s.values.values[i]);
      if (v === null) continue;
      if (p.grouping === "percentStacked") v = totals[i] ? v / totals[i]! : 0;
      let from = base;
      let to = v;
      if (stacked) {
        const acc = v >= 0 ? pos : neg;
        from = acc[i]!;
        to = from + v;
        acc[i] = to;
      }
      // Pyramids and cones narrow to their own top, a stack's top, or the
      // axis's maximum ("…ToMax").
      const apex =
        shape === "pyramidToMax" || shape === "coneToMax" ? sc.max : stacked ? (p.grouping === "percentStacked" ? 1 : tops[i]!) : to;
      const narrow = shape !== "box" && shape !== "cylinder";
      const t = (x: number): number => (narrow ? Math.max(0, 1 - (x - base) / ((apex - base) || 1)) : 1);
      const slot = n === 1 ? 0 : k * bw - ((n - 1) * bw) / 2;
      out.push({
        s,
        i,
        u: b.c(i) + slot,
        hu: bw / 2,
        z: (rowsOfSeries ? k + 0.5 : 0.5) * depth,
        hd,
        from: b.v(from),
        to: b.v(to),
        taper: [t(from), t(to)],
      });
    }
  });
  return out;
}

/** A bar's faces: a box, or a 24-sided cylinder, narrowed towards its apex for pyramids and cones. */
function barFaces(b: Box3D, bar: Bar3D, round: boolean, fill: Fill | null, line: Line | null): Face[] {
  const ring: [number, number][] = round
    ? Array.from({ length: 24 }, (_, j) => [Math.cos((j * Math.PI) / 12) * bar.hu, Math.sin((j * Math.PI) / 12) * bar.hd])
    : [[-bar.hu, -bar.hd], [bar.hu, -bar.hd], [bar.hu, bar.hd], [-bar.hu, bar.hd]];
  const at = (val: number, k: number, [du, dz]: [number, number]): Vec => point3(b, bar.u + du * k, val, bar.z + dz * k);
  const lower = ring.map((q) => at(bar.from, bar.taper[0], q));
  const upper = ring.map((q) => at(bar.to, bar.taper[1], q));
  const axis = (val: number): Vec => point3(b, bar.u, val, bar.z);
  const up: Vec = point3(b, 0, Math.sign(bar.to - bar.from) || 1, 0);
  const faces: Face[] = ring.map((_, j) => {
    const k = (j + 1) % ring.length;
    const pts = [lower[j]!, lower[k]!, upper[k]!, upper[j]!];
    let n = cross(sub(pts[1]!, pts[0]!), sub(pts[3]!, pts[0]!));
    if (Math.hypot(...n) < 1e-12) n = cross(sub(pts[2]!, pts[1]!), sub(pts[3]!, pts[1]!));
    const mid = pts.reduce<Vec>((acc, q) => [acc[0] + q[0] / 4, acc[1] + q[1] / 4, acc[2] + q[2] / 4], [0, 0, 0]);
    const out = sub(mid, axis(b.columns ? mid[1] : mid[0]));
    if (dot(n, out) < 0) n = [-n[0], -n[1], -n[2]];
    return { pts, n, fill, line, shade: true };
  });
  if (bar.taper[1] > 1e-6) faces.push({ pts: upper, n: up, fill, line, shade: true });
  faces.push({ pts: lower, n: [-up[0], -up[1], -up[2]], fill, line, shade: true });
  return faces;
}

/** Area and line series as slabs (a line: its top only, a ribbon), back rows first. */
function slabs3D(p: Extract<ChartPlot, { kind: "area" | "line" }>, b: Box3D): { s: ChartSeries; faces: Face[]; depth: number }[] {
  const stacked = p.grouping === "stacked" || p.grouping === "percentStacked";
  const depth = b.size[2] / b.rows;
  const totals = Array.from({ length: b.count }, (_, i) => p.series.reduce((sum, s) => sum + (num(s.values.values[i]) ?? 0), 0));
  const acc = Array.from({ length: b.count }, () => 0);
  const base = b.v(0);
  return p.series.map((s, k) => {
    const row = b.rows > 1 ? k : 0;
    const z0 = (row + (1 - b.thickness) / 2) * depth;
    const z1 = z0 + b.thickness * depth;
    const top: [number, number][] = [];
    const low: [number, number][] = [];
    for (let i = 0; i < b.count; i++) {
      let v = num(s.values.values[i]) ?? 0;
      if (p.grouping === "percentStacked") v = totals[i] ? v / totals[i]! : 0;
      const from = stacked ? acc[i]! : 0;
      if (stacked) acc[i] = from + v;
      top.push([b.c(i), b.v(from + v)]);
      low.push([b.c(i), stacked ? b.v(from) : base]);
    }
    const fill = p.kind === "line" ? (s.line?.fill ?? null) : s.fill;
    const line = p.kind === "line" ? null : s.line;
    const faces: Face[] = [];
    for (let i = 0; i + 1 < top.length; i++) {
      const [x0, y0] = top[i]!;
      const [x1, y1] = top[i + 1]!;
      faces.push({ pts: [[x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1]], n: [y0 - y1, x1 - x0, 0], fill, line, shade: true });
    }
    // The underside is the floor or the series below: never seen.
    if (p.kind === "area") {
      const ring = [...top, ...low.slice().reverse()];
      faces.push({ pts: ring.map(([x, y]) => [x, y, z0]), n: [0, 0, -1], fill, line, shade: true });
      faces.push({ pts: ring.map(([x, y]) => [x, y, z1]), n: [0, 0, 1], fill, line, shade: true });
      for (const [i, nx] of [[0, -1], [top.length - 1, 1]] as const) {
        const [x, y1] = top[i]!;
        const y0 = low[i]![1];
        faces.push({ pts: [[x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1]], n: [nx, 0, 0], fill, line, shade: true });
      }
    }
    return { s, faces, depth: row };
  });
}

/**
 * A surface: the series one behind the other, each cell cut in four by four
 * and painted in the band its value falls in, lit like the bars.
 */
function surfaceFaces(p: Extract<ChartPlot, { kind: "surface" }>, b: Box3D): Face[] {
  const sc = b.val.scale!;
  const rows = p.series.length;
  const Z = b.size[2];
  const zOf = (k: number): number => (rows > 1 ? (k * Z) / (rows - 1) : Z / 2);
  const value = (k: number, i: number): number => num(p.series[k]?.values.values[i]) ?? sc.min;
  const band = (v: number): ChartBox | undefined => p.bands[Math.max(0, Math.floor((v - sc.min) / sc.major + 1e-9)) % Math.max(1, p.bands.length)];
  const faces: Face[] = [];
  const S = 4;
  for (let k = 0; k + 1 < rows; k++) {
    for (let i = 0; i + 1 < b.count; i++) {
      const at = (u: number, w: number): number =>
        (1 - u) * (1 - w) * value(k, i) + u * (1 - w) * value(k, i + 1) + (1 - u) * w * value(k + 1, i) + u * w * value(k + 1, i + 1);
      for (let a = 0; a < S; a++) {
        for (let c = 0; c < S; c++) {
          const q = [[a, c], [a + 1, c], [a + 1, c + 1], [a, c + 1]].map(([u, w]) => [u! / S, w! / S] as const);
          const pts: Vec[] = q.map(([u, w]) => [b.c(i) + u, b.v(at(u, w)), zOf(k) + (zOf(k + 1) - zOf(k)) * w]);
          const mean = q.reduce((sum, [u, w]) => sum + at(u, w), 0) / 4;
          let n = cross(sub(pts[2]!, pts[0]!), sub(pts[3]!, pts[1]!));
          // Either side of a surface shows.
          if (dot(n, b.eye) > 0) n = [-n[0], -n[1], -n[2]];
          const bx = band(mean);
          const fill = bx?.fill ?? null;
          faces.push(
            p.wireframe
              ? { pts, n, fill: null, line: bx?.line ?? (fill?.kind === "solid" ? { ...HAIRLINE, fill } : null), shade: false }
              : { pts, n, fill, line: fill?.kind === "solid" ? { ...HAIRLINE, fill: { kind: "solid", color: shade(fill.color, lit(n)) } } : null, shade: true },
          );
        }
      }
    }
  }
  return faces;
}

/** A thin seam-hiding stroke. */
const HAIRLINE: Line = { fill: null, width: 6350, dash: null, cap: "flat", join: "round", head: null, tail: null, compound: "sng" };

function drawPlot3D(p: ChartPlot, b: Box3D, paint: Paint): ReactNode {
  if (p.kind === "bar") {
    const round = b.view.shape === "cylinder" || b.view.shape === "cone" || b.view.shape === "coneToMax";
    const bars = bars3D(p, b)
      .map((bar) => ({ bar, depth: b.at(point3(b, bar.u, (bar.from + bar.to) / 2, bar.z))[2] }))
      .sort((x, y) => y.depth - x.depth);
    return paint.group(
      bars.flatMap(({ bar }) => {
        const st = pointStyle(bar.s, bar.i);
        return drawFaces(b, barFaces(b, bar, round, st.fill, st.line), paint);
      }),
      null,
    );
  }
  if (p.kind === "area" || p.kind === "line") {
    const list = slabs3D(p, b).map((x, k) => ({ ...x, k }));
    list.sort((x, y) => y.depth - x.depth || x.k - y.k);
    return paint.group(list.flatMap((x) => drawFaces(b, x.faces, paint)), null);
  }
  if (p.kind === "surface") return paint.group(drawFaces(b, surfaceFaces(p, b), paint), null);
  return null;
}

// ── 3-D pies ────────────────────────────────────────────────────────────────

/**
 * A 3-D pie's rim is this deep, in radii, at `depthPercent` 100 and seen
 * side on (measured: 40 px under a 162 px radius tilted 30°).
 */
const PIE_DEPTH = 0.26;

type PieLayout = { cx: number; cy: number; r: number; tilt: number; thick: number; first: number | null };

/** A point on a pie's top at angle `a` (clockwise from twelve) and radius `r`. */
function pieAt(pie: PieLayout, cx: number, cy: number, r: number, a: number): [number, number] {
  const t = ((a - 90) * Math.PI) / 180;
  return [cx + Math.cos(t) * r, cy + Math.sin(t) * r * pie.tilt];
}

/**
 * A 3-D pie: the slices' cut sides, then the rim where it faces the eye
 * (from three to nine o'clock through six), shaded from light on the left
 * to dark on the right like Office's, then the tops.
 */
function drawPie3D(p: Extract<ChartPlot, { kind: "pie" }>, pie: PieLayout, paint: Paint): ReactNode[] {
  const t = pie.thick;
  const box = { x: pie.cx - pie.r, y: pie.cy - pie.r * pie.tilt, w: 2 * pie.r, h: 2 * pie.r * pie.tilt + t };
  const rel = ([x, y]: [number, number], dy = 0): string => `${x - box.x} ${y + dy - box.y}`;
  const walls: ReactNode[] = [];
  const rims: ReactNode[] = [];
  const tops: ReactNode[] = [];
  const list = (slices(p, pie)[0] ?? []).filter((sl) => sl.value > 0);
  list.sort((x, y) => -Math.cos(((x.start + x.sweep / 2) * Math.PI) / 180) - -Math.cos(((y.start + y.sweep / 2) * Math.PI) / 180));
  for (const sl of list) {
    const st = pointStyle(sl.s, sl.i);
    const explosion = ((sl.s.points?.[sl.i]?.explosion ?? sl.s.explosion) / 100) * pie.r;
    const mid = ((sl.start + sl.sweep / 2 - 90) * Math.PI) / 180;
    const cx = pie.cx + Math.cos(mid) * explosion;
    const cy = pie.cy + Math.sin(mid) * explosion * pie.tilt;
    const c = baseColor(st.fill);
    const at = (a: number): [number, number] => pieAt(pie, cx, cy, sl.r1, a);
    for (const a of sl.sweep < 359.999 ? [sl.start, sl.start + sl.sweep] : []) {
      walls.push(paint.shape(`M${rel([cx, cy])}L${rel(at(a))}L${rel(at(a), t)}L${rel([cx, cy], t)}Z`, shadeFill(st.fill, 0.6), null, null, box));
    }
    const rimFill: Fill | null = c
      ? { kind: "linear", angle: 0, scaled: true, stops: [{ pos: 0, color: shade(c, 0.85) }, { pos: 0.5, color: shade(c, 0.55) }, { pos: 1, color: shade(c, 0.38) }] }
      : st.fill;
    // The front half, 90..270 (mod 360), of [start, start + sweep].
    for (const k of [-1, 0, 1]) {
      const a0 = Math.max(sl.start, 90 + 360 * k);
      const a1 = Math.min(sl.start + sl.sweep, 270 + 360 * k);
      if (a1 - a0 < 1e-6) continue;
      const large = a1 - a0 > 180 ? 1 : 0;
      const r = sl.r1;
      const ry = r * pie.tilt;
      rims.push(
        paint.shape(
          `M${rel(at(a0))}A${r} ${ry} 0 ${large} 1 ${rel(at(a1))}L${rel(at(a1), t)}A${r} ${ry} 0 ${large} 0 ${rel(at(a0), t)}Z`,
          rimFill,
          st.line,
          null,
          box,
        ),
      );
    }
    tops.push(paint.shape(sector(cx - box.x, cy - box.y, sl.r0, sl.r1, sl.start, sl.sweep, pie.tilt), st.fill, st.line, null, box));
  }
  return [paint.group([...walls, ...rims, ...tops], p.series[0]?.effects ?? null)];
}

// ── Data labels ─────────────────────────────────────────────────────────────

/**
 * Percent labels the way Office rounds them: to the format's precision, but so
 * that they add up to exactly 100% — the largest remainders round up (a 58.57%
 * slice reads 58% when 23% + 10% + 9% need the point).
 */
function percents(values: number[], format: string): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return values.map(() => 0);
  const decimals = (format.split(".")[1]?.match(/[0#]/g) ?? []).length;
  const unit = Math.pow(10, -(decimals + 2));
  const exact = values.map((v) => v / total / unit);
  const floors = exact.map(Math.floor);
  let left = Math.round(1 / unit) - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - floors[i]!, i] as const).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i] = floors[i]! + 1;
    left--;
  }
  return floors.map((f) => f * unit);
}

function labelText(l: ChartDataLabel, s: ChartSeries, i: number, chart: Chart, percent: number | null): string {
  const sep = l.separator ?? (separators().decimal === "," ? "; " : ", ");
  const parts: string[] = [];
  if (l.series) parts.push(s.name);
  // A scatter's or bubble's "category" is its X value.
  if (l.category) {
    parts.push(
      s.xValues
        ? formatValue(s.xValues.values[i] ?? i + 1, s.xValues.format, chart.date1904)
        : formatValue(chart.categories.values[i] ?? i + 1, chart.categories.format, chart.date1904),
    );
  }
  const v = s.values.values[i] ?? null;
  if (l.value) parts.push(formatValue(v, l.format ?? s.values.format, chart.date1904));
  if (l.percent && percent !== null) parts.push(formatValue(percent, l.format && l.format.includes("%") ? l.format : "0%"));
  if (l.size && s.sizes) parts.push(formatValue(s.sizes.values[i] ?? null, s.sizes.format, chart.date1904));
  return parts.join(sep);
}

/** A data label's text, broken to a fifth of the chart's width like Office's. */
function labelBlock(l: ChartDataLabel, s: ChartSeries, i: number, chart: Chart, layout: Layout, percent: number | null): Block | null {
  const max = layout.chartW / 5;
  if (l.text) return l.text.some((p) => p.runs.some((r) => r.text)) ? block(l.text, max) : null;
  const text = labelText(l, s, i, chart, percent);
  return text ? plainBlock(text, l.font, max) : null;
}

/** A label centred on (cx, cy), with its legend key before it when asked. */
function placeLabel(b: Block, l: ChartDataLabel, fill: Fill | null, cx: number, cy: number, paint: Paint, k: string): ReactNode {
  if (!l.legendKey) return drawText(b, { x: cx - b.w / 2, y: cy - b.h / 2, w: b.w, h: b.h }, 0, k);
  const key = keySize(l.font);
  const gap = 0.39 * l.font.size * PT;
  const w = key + gap + b.w;
  const first = b.lines[0]?.runs[0]?.font ?? l.font;
  return (
    <g key={k}>
      {paint.shape({ x: cx - w / 2, y: cy - b.h / 2 + (lineHeight(first) - key) / 2, w: key, h: key }, fill, null, null)}
      {drawText(b, { x: cx - w / 2 + key + gap, y: cy - b.h / 2, w: b.w, h: b.h }, 0, `${k}t`)}
    </g>
  );
}

function drawDataLabels(chart: Chart, whole: Layout, paint: Paint, key: () => string): ReactNode[] {
  const out: ReactNode[] = [];
  for (const [index, p] of chart.plots.entries()) {
    const layout = onAxes(chart, whole, index);
    const plot = layout.plot;
    if (p.kind === "pie") {
      const pie = layout.pie;
      if (!pie) continue;
      for (const ring of slices(p, pie)) {
        const s = ring[0]?.s;
        if (!s) continue;
        const pct = percents(ring.map((sl) => sl.value), s.labels.find((l) => l?.format?.includes("%"))?.format ?? "0%");
        for (const sl of ring) {
          const l = s.labels[sl.i];
          if (!l || sl.value <= 0) continue;
          const b = labelBlock(l, s, sl.i, chart, layout, sl.total ? (pct[sl.i] ?? 0) : null);
          if (!b) continue;
          // Inside the slice (the middle of a doughnut's ring), or past its rim.
          const outside = l.position === "outEnd";
          const mid = ((sl.start + sl.sweep / 2 - 90) * Math.PI) / 180;
          const rr = outside ? pie.r + b.h * 0.6 : sl.r0 > 0 ? (sl.r0 + sl.r1) / 2 : l.position === "ctr" ? sl.r1 / 2 : sl.r1 * 0.65;
          const cx = pie.cx + Math.cos(mid) * rr + (outside ? (Math.cos(mid) * b.w) / 2 : 0);
          const cy = pie.cy + Math.sin(mid) * rr * pie.tilt;
          out.push(placeLabel(b, l, pointStyle(s, sl.i).fill, cx, cy, paint, key()));
        }
      }
      continue;
    }
    if (p.kind === "radar") {
      const rd = layout.radar;
      if (rd) out.push(...pointLabels(p, chart, layout, paint, key, (_, i, v) => radarPoint(rd, i, v), (i) => rd.angles[i] ?? 0));
      continue;
    }
    if (layout.box3d) {
      out.push(...labels3D(p, chart, layout, layout.box3d, paint, key));
      continue;
    }
    if (!plot || !plot.val?.scale) continue;
    const scale = plot.val.scale;
    const count = plot.cat?.count ?? 1;
    const grouping = "grouping" in p ? p.grouping : "standard";
    const stacked = grouping === "stacked" || grouping === "percentStacked";
    const sizes = p.kind === "bubble" ? bubbleSizes(p, chart, plot.bubbleBase) : null;
    const acc = Array.from({ length: count }, () => 0);
    const n = p.kind === "bar" && !stacked ? p.series.length : 1;
    const catLen = plot.cat?.band ?? (plot.horizontal ? plot.inner.h : plot.inner.w) / count;
    const overlap = p.kind === "bar" ? Math.max(-100, Math.min(100, stacked ? 100 : p.overlap)) / 100 : 0;
    const bw = p.kind === "bar" ? catLen / (n - (n - 1) * overlap + p.gapWidth / 100) : 0;
    const totals = Array.from({ length: count }, (_, i) => p.series.reduce((sum, s) => sum + Math.abs(num(s.values.values[i]) ?? 0), 0));
    p.series.forEach((s, k) => {
      const xs = p.kind === "scatter" || p.kind === "bubble" ? xValuesOf(s) : null;
      s.values.values.forEach((raw, i) => {
        let v = num(raw);
        if (v === null) return;
        if (grouping === "percentStacked") v = totals[i] ? v / totals[i] : 0;
        const from = stacked ? acc[i]! : 0;
        const to = from + v;
        if (stacked) acc[i] = to;
        const l = s.labels[i];
        if (!l) return;
        const b = labelBlock(l, s, i, chart, layout, null);
        if (!b) return;
        let cx: number;
        let cy: number;
        const gap = 3 * PT;
        if (p.kind === "bar") {
          const slot = n === 1 ? 0 : k * bw * (1 - overlap) - ((n - 1) * bw * (1 - overlap)) / 2;
          const c = plot.horizontal ? plot.catPos(i) - slot : plot.catPos(i) + slot;
          const clamp = (x: number): number => Math.min(scale.max, Math.max(scale.min, x));
          const a = plot.valPos(clamp(from));
          const e = plot.valPos(clamp(to));
          const pos = l.position ?? (stacked ? "ctr" : "outEnd");
          const dir = Math.sign(e - a) || (plot.horizontal ? 1 : -1);
          const ext = plot.horizontal ? b.w : b.h;
          const along =
            pos === "ctr" ? (a + e) / 2 : pos === "inBase" ? a + dir * (ext / 2 + gap) : pos === "inEnd" ? e - dir * (ext / 2 + gap) : e + dir * (ext / 2 + gap);
          [cx, cy] = plot.horizontal ? [along, c] : [c, along];
        } else {
          const x = xs ? plot.catPos(xs[i] ?? i + 1) : plot.catPos(i);
          const y = plot.valPos(Math.min(scale.max, Math.max(scale.min, to)));
          const pos = l.position ?? (p.kind === "area" ? "ctr" : "r");
          const off = (sizes ? (sizes[k]?.[i] ?? 0) / 2 : s.marker ? (s.marker.size * PT) / 2 : 0) + gap;
          [cx, cy] = plot.horizontal ? [y, x] : [x, y];
          if (pos === "r") cx += off + b.w / 2;
          else if (pos === "l") cx -= off + b.w / 2;
          else if (pos === "t") cy -= off + b.h / 2;
          else if (pos === "b") cy += off + b.h / 2;
        }
        if (l.offset) {
          cx += l.offset.x * layout.chartW;
          cy += l.offset.y * layout.chartH;
        }
        const st = pointStyle(s, i);
        out.push(placeLabel(b, l, st.fill ?? st.line?.fill ?? null, cx, cy, paint, key()));
      });
    });
  }
  return out;
}

/** Labels beside points placed by `at`: to the right unless the label says
 *  otherwise — a radar's (`spoke`: point `i`'s angle) out along its spoke. */
function pointLabels(
  p: ChartPlot,
  chart: Chart,
  layout: Layout,
  paint: Paint,
  key: () => string,
  at: (s: ChartSeries, i: number, v: number) => [number, number] | null,
  spoke: ((i: number) => number) | null = null,
): ReactNode[] {
  const out: ReactNode[] = [];
  for (const s of p.series) {
    s.values.values.forEach((raw, i) => {
      const v = num(raw);
      const l = s.labels[i];
      const q = v === null ? null : at(s, i, v);
      if (!l || !q) return;
      const b = labelBlock(l, s, i, chart, layout, null);
      if (!b) return;
      const off = (s.marker ? (s.marker.size * PT) / 2 : 0) + 3 * PT;
      let [cx, cy] = q;
      const pos = l.position ?? (spoke ? "outEnd" : "r");
      if (pos === "outEnd" && spoke) {
        const a = (spoke(i) * Math.PI) / 180;
        cx += Math.sin(a) * (off + b.w / 2);
        cy -= Math.cos(a) * (off + b.h / 2);
      } else if (pos === "r") cx += off + b.w / 2;
      else if (pos === "l") cx -= off + b.w / 2;
      else if (pos === "t" || pos === "outEnd") cy -= off + b.h / 2;
      else if (pos === "b") cy += off + b.h / 2;
      if (l.offset) {
        cx += l.offset.x * layout.chartW;
        cy += l.offset.y * layout.chartH;
      }
      const st = pointStyle(s, i);
      out.push(placeLabel(b, l, st.fill ?? st.line?.fill ?? null, cx, cy, paint, key()));
    });
  }
  return out;
}

/** A 3-D chart's labels: over a bar's front top (centred in a stack), on an area's or line's point. */
function labels3D(p: ChartPlot, chart: Chart, layout: Layout, b: Box3D, paint: Paint, key: () => string): ReactNode[] {
  if (p.kind === "bar") {
    const out: ReactNode[] = [];
    const stacked = p.grouping === "stacked" || p.grouping === "percentStacked";
    for (const bar of bars3D(p, b)) {
      const l = bar.s.labels[bar.i];
      const blk = l ? labelBlock(l, bar.s, bar.i, chart, layout, null) : null;
      if (!l || !blk) continue;
      const front = bar.z - bar.hd;
      const pos = l.position ?? (stacked ? "ctr" : "outEnd");
      const [x, y] = b.at(point3(b, bar.u, pos === "ctr" ? (bar.from + bar.to) / 2 : bar.to, pos === "ctr" ? front : bar.z));
      const gap = 3 * PT;
      const out2 = pos === "ctr" ? [x, y] : b.columns ? [x, y - (bar.to >= bar.from ? 1 : -1) * (blk.h / 2 + gap)] : [x + (bar.to >= bar.from ? 1 : -1) * (blk.w / 2 + gap), y];
      const st = pointStyle(bar.s, bar.i);
      out.push(placeLabel(blk, l, st.fill, out2[0]!, out2[1]!, paint, key()));
    }
    return out;
  }
  if (p.kind === "area" || p.kind === "line") {
    const stacked = p.grouping === "stacked" || p.grouping === "percentStacked";
    const acc = Array.from({ length: b.count }, () => 0);
    const depth = b.size[2] / b.rows;
    return pointLabels(p, chart, layout, paint, key, (s, i, v) => {
      const k = p.series.indexOf(s);
      const top = stacked ? (acc[i] = acc[i]! + v) : v;
      const q = b.at([b.c(i), b.v(top), ((b.rows > 1 ? k : 0) + 0.5) * depth]);
      return [q[0], q[1]];
    });
  }
  return [];
}

// ── Legend ──────────────────────────────────────────────────────────────────

function drawLegend(chart: Chart, legend: NonNullable<Layout["legend"]>, paint: Paint, key: () => string): ReactNode {
  const lg = chart.legend!;
  const font = lg.font;
  const em = font.size * PT;
  const out: ReactNode[] = [paint.box(lg, legend.rect)];
  const key0 = keySize(font);
  const kw = keyWidth(legend.entries, font);
  const rows = Math.ceil(legend.entries.length / legend.columns);
  const top0 = legend.rect.y + (legend.rect.h - rows * legend.rowH) / 2;
  let x = legend.rect.x + LEGEND_PAD_X;
  legend.entries.forEach((e, i) => {
    const col = i % legend.columns;
    const row = Math.floor(i / legend.columns);
    if (!legend.single) x = legend.rect.x + LEGEND_PAD_X + col * legend.colW;
    const cy = top0 + row * legend.rowH + legend.rowH / 2;
    const st = e.point !== null ? pointStyle(e.series, e.point) : { fill: e.series.fill, line: e.series.line, effects: e.series.effects, marker: e.series.marker };
    if (e.kind === "line") {
      if (st.line?.fill) out.push(paint.shape(`M${x} ${cy}H${x + kw}`, null, st.line, null));
      if (st.marker) out.push(drawMarker(st.marker, x + kw / 2, cy, paint, Math.min(st.marker.size, LEGEND_MARKER)));
    } else if (e.kind === "bubble") {
      const r = key0 / 2;
      out.push(paint.shape(`M0 ${r}a${r} ${r} 0 1 0 ${key0} 0a${r} ${r} 0 1 0 ${-key0} 0Z`, st.fill, null, null, { x: x + kw / 2 - r, y: cy - r, w: key0, h: key0 }));
    } else {
      out.push(paint.shape({ x, y: cy - key0 / 2, w: kw, h: key0 }, st.fill, st.line ? { ...st.line, width: Math.min(st.line.width, 9525) } : null, null));
    }
    const tx = x + kw + keyGap(legend.entries) * em;
    out.push(label(e.text, font, tx, cy - lineHeight(font) / 2, "start", key()));
    if (legend.single) x = tx + textWidth(e.text, font) + LEGEND_ENTRY_GAP * em;
  });
  return <g key={key()}>{out}</g>;
}
