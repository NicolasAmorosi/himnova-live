import type { Paragraph, TextBody, TextRun } from "@shared/types/slide-model";
import { Fragment, useContext, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { cqw, SlideTextContext, withFallback } from "./slide-paint";

const PT = 12700;
/** PowerPoint's single line spacing, the same 1.2 em for every face. */
const SINGLE_LINE = 1.2;

/**
 * Ascent and descent (em) of the face a run is actually drawn with — the
 * file's, an embedded one, a metric twin or a fallback — as the browser itself
 * measures it: where CSS puts a baseline inside a line box, which
 * `SlideParagraph` moves to where PowerPoint puts it. Cached per font list and
 * dropped whenever a font finishes loading (a face measured before it arrived
 * was the fallback's).
 */
const metricsCache = new Map<string, [number, number]>();
let measuring: CanvasRenderingContext2D | null | undefined;
if (typeof document !== "undefined" && document.fonts) document.fonts.addEventListener("loadingdone", () => metricsCache.clear());

function metricsOf(fontList: string | undefined): [number, number] {
  const key = fontList ?? "";
  const cached = metricsCache.get(key);
  if (cached) return cached;
  if (measuring === undefined) measuring = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  let metrics: [number, number] = [0.93, 0.27];
  if (measuring) {
    measuring.font = `100px ${key || "sans-serif"}`;
    const m = measuring.measureText("Hg");
    if (m.fontBoundingBoxAscent > 0) metrics = [m.fontBoundingBoxAscent / 100, m.fontBoundingBoxDescent / 100];
  }
  metricsCache.set(key, metrics);
  return metrics;
}

export function SlideText({
  body,
  box,
  slideWidth,
  flow = false,
}: {
  body: TextBody;
  box: { x: number; y: number; w: number; h: number };
  slideWidth: number;
  /** In normal flow instead of in a fixed box: a table cell grows with it. */
  flow?: boolean;
}): ReactNode {
  const u = (emu: number): string => cqw(emu, slideWidth);
  const vertical = body.vertical !== "horz";
  // Positioned either way: tab stops are measured from this box (`placeTabs`).
  const placed: CSSProperties = flow
    ? { position: "relative" }
    : {
        position: "absolute",
        left: u(box.x + body.insets.l),
        top: u(box.y + body.insets.t),
        width: u(Math.max(0, box.w - body.insets.l - body.insets.r)),
        height: u(Math.max(0, box.h - body.insets.t - body.insets.b)),
      };
  const style: CSSProperties = {
    ...placed,
    display: "flex",
    flexDirection: "column",
    justifyContent: body.anchor === "ctr" ? "center" : body.anchor === "b" ? "flex-end" : "flex-start",
    alignItems: body.wrap ? "stretch" : "center",
    whiteSpace: body.wrap ? "pre-wrap" : "pre",
    overflowWrap: "break-word",
    ...(vertical ? { writingMode: WRITING_MODE[body.vertical] } : null),
    ...(body.rotation ? { transform: `rotate(${body.rotation}deg)` } : null),
    // PowerPoint fills a column to the bottom before starting the next.
    ...(body.columns.count > 1 ? { columnCount: body.columns.count, columnGap: u(body.columns.spacing), columnFill: "auto", display: "block" } : null),
  };
  const paragraphs = body.paragraphs.map((p, i) => (
    <SlideParagraph key={i} p={p} u={u} wrap={body.wrap} first={i === 0} slideWidth={slideWidth} />
  ));
  return <div style={style}>{body.stretch ? <Stretched>{paragraphs}</Stretched> : paragraphs}</div>;
}

/** The text laid out at its own size, then scaled to fill its box both ways —
 *  measured, and measured again whenever its size changes (a face arriving). */
function Stretched({ children }: { children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const inner = ref.current;
    const box = inner?.parentElement;
    if (!inner || !box) return;
    const fit = (): void => {
      const w = inner.offsetWidth, h = inner.offsetHeight;
      if (!(w > 0 && h > 0)) return;
      const sx = box.clientWidth / w, sy = box.clientHeight / h;
      inner.style.transform = `scale(${sx}, ${sy})`;
      inner.style.setProperty("--slide-stroke-scale", String(Math.sqrt(sx * sy)));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(inner);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ width: "max-content", transformOrigin: "center", alignSelf: "center" }}>
      {children}
    </div>
  );
}

const WRITING_MODE: Record<TextBody["vertical"], CSSProperties["writingMode"]> = {
  horz: "horizontal-tb",
  vert: "sideways-rl",
  vert270: "sideways-lr",
  eaVert: "vertical-rl",
  wordArtVert: "vertical-rl",
};

function firstRun(p: Paragraph): Extract<TextRun, { kind: "text" }> | undefined {
  const run = p.runs.find((r) => r.kind === "text");
  return run?.kind === "text" ? run : undefined;
}

function SlideParagraph({
  p,
  u,
  wrap,
  first,
  slideWidth,
}: {
  p: Paragraph;
  u: (emu: number) => string;
  wrap: boolean;
  first: boolean;
  slideWidth: number;
}): ReactNode {
  const run = firstRun(p);
  const size = run?.size ?? p.endSize;
  const { fallbackFont } = useContext(SlideTextContext);
  const font = run ? withFallback(run.font, fallbackFont) : undefined;
  // The strut: the smallest size in the paragraph. PowerPoint makes each line
  // as tall as its own biggest text, so a smaller line (an empty one between
  // two breaks, at the break's size) mustn't be held up to the first run's.
  const strut = Math.min(size, ...p.runs.map((r) => r.size));
  const ref = useRef<HTMLDivElement>(null);
  const tabbed = p.runs.some((r) => r.kind === "text" && r.text.includes("\t"));
  useLayoutEffect(() => {
    if (tabbed && ref.current) placeTabs(ref.current, p, strut * PT, slideWidth);
  });
  const [ascent, descent] = metricsOf(font);
  // PowerPoint's line geometry, measured in its own rendering for six faces at
  // 20 and 40 pt (`gen-metrics.pptx`), and the same for all of them: a single
  // line is 1.2 em; in percent spacing the first baseline sits at 0.955 em
  // plus 0.85 em per extra 100%; in exact spacing at 0.747 of the line. CSS
  // centres the glyphs in the line box instead (half-leading), so every line
  // of the paragraph is moved by the difference.
  const lineEm = "pts" in p.lineSpacing ? p.lineSpacing.pts / size : p.lineSpacing.pct * SINGLE_LINE;
  const target = "pts" in p.lineSpacing ? 0.747 * lineEm : 0.955 + 0.85 * (p.lineSpacing.pct - 1);
  const baselineShift = target - ((lineEm - (ascent + descent)) / 2 + ascent);
  const lineHeight = String(lineEm);
  // Space in percent is a share of a single line. PowerPoint never puts space
  // before the first paragraph of a text body.
  const spacing = (value: Paragraph["spaceBefore"]): string =>
    "pts" in value ? u(value.pts * PT) : u(value.pct * size * SINGLE_LINE * PT);
  const empty = !p.runs.some((r) => r.kind === "text");
  const style: CSSProperties = {
    textAlign: p.align === "ctr" ? "center" : p.align === "r" ? "right" : p.align === "just" || p.align === "dist" ? "justify" : "left",
    paddingLeft: u(p.marginLeft),
    // With a bullet, a positive indent is the bullet's own width (it sits at
    // the margin); without one it indents the first line.
    textIndent: u(p.bullet && p.indent > 0 ? 0 : p.indent),
    marginTop: first ? 0 : spacing(p.spaceBefore),
    marginBottom: spacing(p.spaceAfter),
    lineHeight,
    ...(baselineShift ? { position: "relative", top: u(baselineShift * size * PT) } : null),
    direction: p.rtl ? "rtl" : undefined,
    // The paragraph's own face sets the strut, so a line isn't made taller
    // than its line-height by a default face whose ascent:descent differs from
    // the text's (the two boxes align on the baseline and their union grows —
    // measured with Candara: 48.4 px lines for 47.5). `placeTabs` reads its
    // size back as the px-per-EMU scale.
    fontSize: u(strut * PT),
    fontFamily: font,
    ...(wrap ? null : { width: "max-content", alignSelf: p.align === "ctr" ? "center" : p.align === "r" ? "flex-end" : "flex-start" }),
  };
  return (
    <div ref={ref} style={style}>
      {p.bullet ? <Bullet p={p} size={size} u={u} /> : null}
      {empty ? <span style={{ fontSize: u(p.endSize * PT) }}>{"​"}</span> : p.runs.map((r, i) => <Run key={i} run={r} u={u} />)}
      {/* A trailing break still opens a line in PowerPoint; a trailing <br> opens none. */}
      {!empty && p.runs[p.runs.length - 1]?.kind === "break" ? <span style={{ fontSize: u(p.endSize * PT) }}>{"​"}</span> : null}
      {tabbed ? <span data-tab-end="" /> : null}
    </div>
  );
}

/**
 * Tab stops, which CSS doesn't have (only a fixed `tab-size`): every `\t` is
 * an empty inline-block (`Run`), widened here one by one, in order, to reach
 * its stop — measured where the browser actually put it, so it follows the
 * real text widths and line breaks. Widths are written in `cqw`, so the slide
 * still scales with no measuring. Offsets, not client rects: a rotated shape
 * would skew the latter.
 */
function placeTabs(para: HTMLElement, p: Paragraph, sizeEmu: number, slideWidth: number): void {
  const marks = [...para.querySelectorAll<HTMLElement>("[data-tab]")];
  for (const m of marks) m.style.width = "0px";
  const box = para.parentElement;
  const pxPerEmu = parseFloat(getComputedStyle(para).fontSize) / sizeEmu;
  // ponytail: right-to-left tabs stay collapsed; measure from the right edge if one shows up.
  if (!box || p.rtl || !(pxPerEmu > 0)) return;
  const end = para.querySelector<HTMLElement>("[data-tab-end]");
  const at = (el: HTMLElement): number => leftWithin(el, box) / pxPerEmu;
  // Offsets are whole pixels: a tab already sitting on a stop must not take
  // that same stop again.
  const slack = 1.5 / pxPerEmu;
  const stops = p.indent < 0 ? [...p.tabs, { pos: p.marginLeft, align: "l" as const }].sort((a, b) => a.pos - b.pos) : p.tabs;
  marks.forEach((mark, i) => {
    const x = at(mark);
    if (!Number.isFinite(x)) return;
    const stop = stops.find((s) => s.pos > x + slack) ?? {
      pos: (Math.floor((x + slack) / p.defaultTab) + 1) * p.defaultTab,
      align: "l" as const,
    };
    // A right or centred stop aligns the text up to the next tab (or the end).
    const next = marks[i + 1] ?? end;
    const segment = stop.align === "l" || !next ? 0 : Math.max(0, at(next) - x);
    // ponytail: a decimal stop aligns the whole segment's end, not its decimal point.
    const width = stop.pos - x - (stop.align === "ctr" ? segment / 2 : segment);
    // Never wider than the slide: a wrong scale once made tabs millions of
    // pixels wide, and Chromium stopped painting the slide at all.
    mark.style.width = cqw(Math.min(slideWidth, Math.max(0, width)), slideWidth);
  });
}

/** `el`'s left edge in `box`'s padding box, through the offset parents. */
function leftWithin(el: HTMLElement, box: HTMLElement): number {
  let x = 0;
  let e: HTMLElement | null = el;
  while (e && e !== box) {
    x += e.offsetLeft;
    e = e.offsetParent as HTMLElement | null;
  }
  return e === box ? x : NaN;
}

function Bullet({ p, size, u }: { p: Paragraph; size: number; u: (emu: number) => string }): ReactNode {
  const b = p.bullet!;
  const fontSize = "pts" in b.size ? b.size.pts : b.size.pct * size;
  // Hanging (negative indent): the bullet sits in the indent and the text
  // starts at the margin. Positive indent: the bullet at the margin, the text
  // at margin + indent. A bigger bullet never makes its line taller.
  const style: CSSProperties = {
    display: "inline-block",
    textIndent: 0,
    minWidth: p.indent !== 0 ? u(Math.abs(p.indent)) : undefined,
    fontSize: u(fontSize * PT),
    lineHeight: 0,
  };
  if (b.kind === "image") return <span style={style}>•</span>;
  return (
    <span style={{ ...style, color: b.color ?? undefined, fontFamily: b.font ?? undefined }}>
      {b.char}
      {p.indent === 0 ? " " : null}
    </span>
  );
}

function Run({ run, u }: { run: TextRun; u: (emu: number) => string }): ReactNode {
  const { fallbackFont } = useContext(SlideTextContext);
  if (run.kind === "break") return <span style={{ fontSize: u(run.size * PT) }}><br /></span>;
  const style: CSSProperties = {
    fontFamily: withFallback(run.font, fallbackFont),
    fontSize: u(run.size * PT),
    fontWeight: run.bold ? 700 : 400,
    fontStyle: run.italic ? "italic" : "normal",
    textDecorationLine: [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
    textTransform: run.caps === "all" ? "uppercase" : undefined,
    fontVariantCaps: run.caps === "small" ? "small-caps" : undefined,
    letterSpacing: run.spacing ? u(run.spacing * PT) : undefined,
    backgroundColor: run.highlight ?? undefined,
    ...(run.baseline ? { position: "relative", top: u((-run.baseline / 100) * run.size * PT), fontSize: u(run.size * PT * 0.67) } : null),
  };
  const fill = run.fill;
  if (!fill) style.color = "transparent";
  else if (fill.kind === "solid") style.color = fill.color;
  else if (fill.kind === "linear") {
    style.backgroundImage = `linear-gradient(${fill.angle + 90}deg, ${fill.stops.map((s) => `${s.color} ${s.pos * 100}%`).join(", ")})`;
    style.backgroundClip = "text";
    style.color = "transparent";
  } else style.color = fill.kind === "path" ? (fill.stops[0]?.color ?? "black") : fill.kind === "pattern" ? fill.fg : "black";
  if (run.outline?.fill?.kind === "solid") {
    // Inside stretched WordArt the letters are scaled; their outline is not (`Stretched`).
    style.WebkitTextStroke = `calc(${u(run.outline.width)} / var(--slide-stroke-scale, 1)) ${run.outline.fill.color}`;
  }
  const shadows: string[] = [];
  const shadow = run.effects.shadow;
  if (shadow && !shadow.inner) {
    const a = (shadow.dir * Math.PI) / 180;
    shadows.push(`${u(Math.cos(a) * shadow.dist)} ${u(Math.sin(a) * shadow.dist)} ${u(shadow.blur / 2)} ${shadow.color}`);
  }
  // A glow is the glyphs grown by its radius and blurred: stacked zero-offset
  // shadows build up the solid band near the letters that one blur lacks.
  const glow = run.effects.glow;
  if (glow) for (const k of [0.25, 0.5, 1]) shadows.push(`0 0 ${u(glow.radius * k)} ${glow.color}`);
  if (shadows.length) style.textShadow = shadows.join(", ");
  const parts = run.text.split("\t");
  return (
    <span style={style}>
      {parts.length === 1
        ? run.text
        : parts.map((t, i) => (
            <Fragment key={i}>
              {i > 0 ? <span data-tab="" style={TAB} /> : null}
              {t}
            </Fragment>
          ))}
    </span>
  );
}

/** A tab's box; `placeTabs` sets its width. */
const TAB: CSSProperties = { display: "inline-block" };
