import type {
  Frame,
  GroupElement,
  LineEnd,
  PictureElement,
  ShapeElement,
  SlideElement,
  SlideModel,
  SlideTextSettings,
  TableElement,
} from "@shared/types/slide-model";
import { memo, useId, type CSSProperties, type ReactNode } from "react";
import { cqw, effectFilter, ImageInBox, SlideTextContext, strokeProps, svgPaint, type PaintContext, type ResolvePart } from "./slide-paint";
import { SlideChart } from "./slide-chart";
import { SlideText } from "./slide-text";
import "./slide-fonts.css";

/**
 * A `.pptx` slide drawn from its model (`src/main/slides/pptx/reader.ts`):
 * the same component on the projector, the monitors and the thumbnails.
 *
 * The root is a size container, so every length below is in `cqw` of the
 * slide — it scales with whatever box it is given and needs no measuring.
 * Geometry is SVG in the element's own EMU; text is HTML laid over it.
 *
 * Memoized (`sameSlide`): every slide change re-renders both slide grids (the
 * highlighted tile moves), and each of their ~18 slides was drawn again before
 * `projection-sync` told the projector, up to 57 ms at the p90 of a heavy
 * template (2026-11-15 audit, A27). The faces a model names are loaded before
 * it is handed out (`loadSlideModel`), so a slide drawn once measured right.
 */
export const SlideView = memo(function SlideView({ model, resolve, style, text = NO_TEXT_SETTINGS }: SlideViewProps): ReactNode {
  const id = useId().replace(/:/g, "");
  const scope: Scope = { id, resolve, slideWidth: model.width, background: model.background, slide: { w: model.width, h: model.height } };
  // The background is painted like any fill — an SVG rect — so a picture
  // background gets its transparency and colour effects too.
  const bg = svgPaint(model.background, `${id}-bg`, paintContext(scope, ROOT, 0, 0), scope.slide);
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: `${model.width} / ${model.height}`,
        containerType: "size",
        overflow: "hidden",
        backgroundColor: "white",
        ...style,
      }}
    >
      <svg viewBox={`0 0 ${model.width} ${model.height}`} preserveAspectRatio="none" width="100%" height="100%" style={{ position: "absolute", inset: 0 }}>
        <defs>{bg.defs}</defs>
        <rect width={model.width} height={model.height} fill={bg.paint === "none" ? "white" : bg.paint} />
      </svg>
      <SlideTextContext value={text}>
        {model.elements.map((el, i) => (
          <Element key={i} el={el} place={ROOT} scope={scope} path={`${i}`} />
        ))}
      </SlideTextContext>
    </div>
  );
}, sameSlide);

type SlideViewProps = {
  model: SlideModel;
  resolve: ResolvePart;
  style?: CSSProperties | undefined;
  /** The face for a font this machine lacks and the language of chart numbers. */
  text?: SlideTextSettings | undefined;
};

function sameSlide(a: SlideViewProps, b: SlideViewProps): boolean {
  const ta = a.text ?? NO_TEXT_SETTINGS;
  const tb = b.text ?? NO_TEXT_SETTINGS;
  return a.model === b.model && a.resolve === b.resolve && a.style === b.style && ta.fallbackFont === tb.fallbackFont && ta.locale === tb.locale;
}

const NO_TEXT_SETTINGS: SlideTextSettings = { fallbackFont: null, locale: "" };

type Scope = { id: string; resolve: ResolvePart; slideWidth: number; background: SlideModel["background"]; slide: { w: number; h: number } };

/** Maps a frame in the current coordinate space to a box relative to the
 *  enclosing positioned div (EMU of the slide); `ax/ay` is where that div's
 *  origin sits on the slide. */
type Place = { ox: number; oy: number; sx: number; sy: number; ax: number; ay: number };
const ROOT: Place = { ox: 0, oy: 0, sx: 1, sy: 1, ax: 0, ay: 0 };

function paintContext(scope: Scope, place: Place, x: number, y: number): PaintContext {
  // ponytail: ignores rotation on the way down; a rotated shape with
  // useBgFill shows the background unrotated, offset by its box.
  return { resolve: scope.resolve, background: scope.background, slide: scope.slide, at: { x: place.ax + x, y: place.ay + y } };
}

function boxOf(frame: Frame, place: Place): { x: number; y: number; w: number; h: number } {
  return { x: (frame.x - place.ox) * place.sx, y: (frame.y - place.oy) * place.sy, w: frame.w * place.sx, h: frame.h * place.sy };
}

function frameStyle(frame: Frame, place: Place, scope: Scope): CSSProperties {
  const b = boxOf(frame, place);
  const u = (v: number): string => cqw(v, scope.slideWidth);
  const transforms: string[] = [];
  if (frame.rot) transforms.push(`rotate(${frame.rot}deg)`);
  if (frame.flipH || frame.flipV) transforms.push(`scale(${frame.flipH ? -1 : 1}, ${frame.flipV ? -1 : 1})`);
  return {
    position: "absolute",
    left: u(b.x),
    top: u(b.y),
    width: u(b.w),
    height: u(b.h),
    transform: transforms.length ? transforms.join(" ") : undefined,
  };
}

function Element({ el, place, scope, path }: { el: SlideElement; place: Place; scope: Scope; path: string }): ReactNode {
  switch (el.kind) {
    case "shape":
      return <Shape el={el} place={place} scope={scope} path={path} />;
    case "picture":
      return <Picture el={el} place={place} scope={scope} path={path} />;
    case "group":
      return <Group el={el} place={place} scope={scope} path={path} />;
    case "table":
      return <Table el={el} place={place} scope={scope} path={path} />;
    case "chart": {
      const b = boxOf(el.frame, place);
      return (
        <div style={frameStyle(el.frame, place, scope)}>
          <SlideChart chart={el.chart} w={b.w} h={b.h} slideWidth={scope.slideWidth} resolve={scope.resolve} />
        </div>
      );
    }
  }
}

function Group({ el, place, scope, path }: { el: GroupElement; place: Place; scope: Scope; path: string }): ReactNode {
  const b = boxOf(el.frame, place);
  // ponytail: a flipped group mirrors its children's text too; PowerPoint keeps
  // text readable. Flipped groups with text are rare; resolve per child if seen.
  const inner: Place = { ox: el.childFrame.x, oy: el.childFrame.y, sx: b.w / el.childFrame.w, sy: b.h / el.childFrame.h, ax: place.ax + b.x, ay: place.ay + b.y };
  return (
    <div style={frameStyle(el.frame, place, scope)}>
      {el.children.map((c, i) => (
        <Element key={i} el={c} place={inner} scope={scope} path={`${path}-${i}`} />
      ))}
    </div>
  );
}

/** Undoes a shape's flips for its text: PowerPoint never mirrors text, and a
 *  vertical flip turns it upside down instead. */
function textTransform(frame: Frame): string | undefined {
  // The shape's own transform is rotate·scale(fx, fy); the text wants
  // rotate·(flipV ? 180° : 0°), so it is scale(fx·fy', fy·fy') with fy' the
  // vertical flip — which always leaves y unflipped, and x flipped only when
  // exactly one of the two flips is set.
  return frame.flipH === frame.flipV ? undefined : "scale(-1, 1)";
}

function Shape({ el, place, scope, path }: { el: ShapeElement; place: Place; scope: Scope; path: string }): ReactNode {
  // Paths and the text rectangle come evaluated at the DRAWN size (the reader
  // folds in every enclosing group's stretch), so the SVG works in that size.
  const { x, y, w, h } = boxOf(el.frame, place);
  const ctx = paintContext(scope, place, x, y);
  const fill = svgPaint(el.fill, `${scope.id}-${path}-f`, ctx, { w, h });
  const stretched = el.fill?.kind === "image" && el.fill.mode === "stretch" ? el.fill : null;
  const pad = 12700 + (el.line ? el.line.width * 6 : 0);
  const stroke = svgPaint(el.line?.fill ?? null, `${scope.id}-${path}-s`, ctx, { w, h });
  const strokeAttrs = strokeProps(el.line, stroke.paint);
  const markers = lineMarkers(el, stroke.paint, `${scope.id}-${path}`);
  const overlay = el.effects.overlay && el.fill ? svgPaint(el.effects.overlay.fill, `${scope.id}-${path}-o`, ctx, { w, h }) : null;
  const textBox = { x: el.textRect.l, y: el.textRect.t, w: el.textRect.r - el.textRect.l, h: el.textRect.b - el.textRect.t };
  // A soft edge eats the shape from its outline in (`SoftEdge`): past half its
  // short side nothing is left to draw, glow included. Short of that, the glow
  // is the whole outline's, behind the faded shape — not the faded shape's.
  const soft = el.effects.softEdge;
  const gone = soft !== null && soft * SOFT_ERODE >= Math.min(w, h) / 2;
  const softGlow = soft && el.effects.glow ? el.effects.glow : null;
  return (
    <div style={frameStyle(el.frame, place, scope)}>
      {el.paths.length > 0 && (el.fill || el.line) && !gone ? (
        // The viewport reaches past the box by `pad` on every side: a straight
        // line's box has no height, and an SVG of height 0 scales its stroke
        // to nothing. The viewBox grows by the same amount, so the scale stays
        // one EMU per EMU.
        <svg
          viewBox={`${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`}
          preserveAspectRatio="none"
          overflow="visible"
          style={{
            position: "absolute",
            left: cqw(-pad, scope.slideWidth),
            top: cqw(-pad, scope.slideWidth),
            width: cqw(w + 2 * pad, scope.slideWidth),
            height: cqw(h + 2 * pad, scope.slideWidth),
            filter: effectFilter(softGlow ? { ...el.effects, glow: null } : el.effects, scope.slideWidth),
          }}
        >
          <defs>
            {stretched ? null : fill.defs}
            {stroke.defs}
            {markers.defs}
            {overlay?.defs}
            {softGlow ? (
              // The same blur as `effectFilter`'s glow (a drop-shadow of radius/2 is σ = radius/4).
              <filter id={`${scope.id}-${path}-gl`} x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation={softGlow.radius / 4} />
              </filter>
            ) : null}
            {stretched ? (
              <clipPath id={`${scope.id}-${path}-c`}>
                {el.paths.filter((p) => p.fill !== "none").map((p, i) => <path key={i} d={p.d} />)}
              </clipPath>
            ) : null}
          </defs>
          {softGlow ? (
            <g fill={softGlow.color} filter={`url(#${scope.id}-${path}-gl)`}>
              {el.paths.map((p, i) => (
                <path key={i} d={p.d} />
              ))}
            </g>
          ) : null}
          <SoftEdge id={`${scope.id}-${path}-e`} radius={el.effects.softEdge} outline={el.paths.map((p, i) => <path key={i} d={p.d} />)}>
            {/* Isolated, so an overlay blends with the shape's fill only. */}
            <g style={overlay ? { isolation: "isolate" } : undefined}>
              {stretched ? (
                // A stretched picture fill is the picture clipped by the outline
                // (a pattern tile the size of the box is the same thing, slower).
                <g clipPath={`url(#${scope.id}-${path}-c)`}>
                  <ImageInBox id={`${scope.id}-${path}-i`} image={stretched.image} w={w} h={h} resolve={scope.resolve} />
                </g>
              ) : null}
              {el.paths.map((p, i) => (
                <g key={i}>
                  {p.fill !== "none" && !stretched ? <path d={p.d} fill={fill.paint} stroke="none" /> : null}
                  {p.fill !== "none" && p.fill !== "norm" && el.fill ? <path d={p.d} fill={SHADE[p.fill]} stroke="none" /> : null}
                  {p.fill !== "none" && overlay ? (
                    <path d={p.d} fill={overlay.paint} stroke="none" style={{ mixBlendMode: BLEND[el.effects.overlay!.blend] }} />
                  ) : null}
                  {p.stroke ? <path d={p.d} fill="none" {...strokeAttrs} markerStart={markers.start} markerEnd={markers.end} /> : null}
                </g>
              ))}
            </g>
          </SoftEdge>
        </svg>
      ) : null}
      {el.text ? (
        // A shape that paints nothing casts its shadow and glow from its text.
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: textTransform(el.frame),
            filter: el.fill || el.line?.fill ? undefined : effectFilter(el.effects, scope.slideWidth),
          }}
        >
          <SlideText body={el.text} box={textBox} slideWidth={scope.slideWidth} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * `softEdge`: PowerPoint eats the shape from its outline in. Measured on red
 * rectangles from 6 to 100 pt (`gen-softedge.pptx`): the 50% contour sits at
 * 0.92 of the radius inside the outline and the 10–90% ramp is 0.8 of it wide,
 * the same at every radius — the outline shrunk by 0.92·r and blurred by
 * σ = 0.31·r. A radius past half the short side leaves nothing. In the SVG's
 * own EMU, so it scales.
 */
const SOFT_ERODE = 0.92;
const SOFT_BLUR = 0.31;

function SoftEdge({ id, radius, outline, children }: { id: string; radius: number | null; outline: ReactNode; children: ReactNode }): ReactNode {
  if (!radius) return children;
  return (
    <>
      <defs>
        <filter id={`${id}-f`} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
          <feMorphology operator="erode" radius={radius * SOFT_ERODE} />
          <feGaussianBlur stdDeviation={radius * SOFT_BLUR} />
        </filter>
        <mask id={`${id}-m`} maskUnits="userSpaceOnUse" x="-100%" y="-100%" width="300%" height="300%">
          <g fill="white" filter={`url(#${id}-f)`}>
            {outline}
          </g>
        </mask>
      </defs>
      <g mask={`url(#${id}-m)`}>{children}</g>
    </>
  );
}

/** `darken`/`lighten` subpaths: the shape's fill with black or white over it. */
const SHADE: Record<string, string> = {
  darken: "rgba(0,0,0,0.4)",
  darkenLess: "rgba(0,0,0,0.2)",
  lighten: "rgba(255,255,255,0.4)",
  lightenLess: "rgba(255,255,255,0.2)",
};

const BLEND: Record<NonNullable<ShapeElement["effects"]["overlay"]>["blend"], CSSProperties["mixBlendMode"]> = {
  over: "normal",
  mult: "multiply",
  screen: "screen",
  darken: "darken",
  lighten: "lighten",
};

const END_SIZE = { sm: 2, med: 3, lg: 5 } as const;

function lineMarkers(el: ShapeElement, paint: string, id: string): { defs: ReactNode; start?: string | undefined; end?: string | undefined } {
  const line = el.line;
  if (!line || paint === "none" || (!line.head && !line.tail)) return { defs: null };
  const marker = (end: LineEnd, markerId: string, start: boolean): ReactNode => {
    const w = END_SIZE[end.w];
    const len = END_SIZE[end.len];
    const shape =
      end.type === "oval" ? <ellipse cx={len / 2} cy={w / 2} rx={len / 2} ry={w / 2} fill={paint} />
      : end.type === "diamond" ? <path d={`M0 ${w / 2}L${len / 2} 0L${len} ${w / 2}L${len / 2} ${w}Z`} fill={paint} />
      : end.type === "arrow" ? <path d={`M0 0L${len} ${w / 2}L0 ${w}`} fill="none" stroke={paint} strokeWidth={0.6} />
      : end.type === "stealth" ? <path d={`M0 0L${len} ${w / 2}L0 ${w}L${len / 3} ${w / 2}Z`} fill={paint} />
      : <path d={`M0 0L${len} ${w / 2}L0 ${w}Z`} fill={paint} />;
    return (
      <marker key={markerId} id={markerId} markerUnits="strokeWidth" markerWidth={len} markerHeight={w} refX={len * 0.8} refY={w / 2} orient={start ? "auto-start-reverse" : "auto"} overflow="visible">
        {shape}
      </marker>
    );
  };
  // OOXML's headEnd is at the path's START.
  return {
    defs: (
      <>
        {line.head ? marker(line.head, `${id}-h`, true) : null}
        {line.tail ? marker(line.tail, `${id}-t`, false) : null}
      </>
    ),
    start: line.head ? `url(#${id}-h)` : undefined,
    end: line.tail ? `url(#${id}-t)` : undefined,
  };
}

function Picture({ el, place, scope, path }: { el: PictureElement; place: Place; scope: Scope; path: string }): ReactNode {
  const { x, y, w, h } = boxOf(el.frame, place);
  const clipId = `${scope.id}-${path}-c`;
  const ctx = paintContext(scope, place, x, y);
  const stroke = svgPaint(el.line?.fill ?? null, `${scope.id}-${path}-s`, ctx, { w, h });
  const fill = svgPaint(el.fill, `${scope.id}-${path}-f`, ctx, { w, h });
  const overlay = el.effects.overlay ? svgPaint(el.effects.overlay.fill, `${scope.id}-${path}-o`, ctx, { w, h }) : null;
  return (
    <div style={frameStyle(el.frame, place, scope)}>
      <svg
        viewBox={`0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`}
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        overflow="visible"
        style={{ position: "absolute", inset: 0, filter: effectFilter(el.effects, scope.slideWidth) }}
      >
        <defs>
          {fill.defs}
          <clipPath id={clipId}>
            {el.clip ? el.clip.filter((p) => p.fill !== "none").map((p, i) => <path key={i} d={p.d} />) : <rect width={w} height={h} />}
          </clipPath>
          {stroke.defs}
          {overlay?.defs}
        </defs>
        <SoftEdge
          id={`${scope.id}-${path}-e`}
          radius={el.effects.softEdge}
          outline={el.clip ? el.clip.map((p, i) => <path key={i} d={p.d} />) : <rect width={w} height={h} />}
        >
          <g clipPath={`url(#${clipId})`} style={overlay ? { isolation: "isolate" } : undefined}>
            {el.fill ? <rect width={w} height={h} fill={fill.paint} /> : null}
            <ImageInBox id={`${scope.id}-${path}-i`} image={el.image} w={w} h={h} resolve={scope.resolve} />
            {overlay ? <rect width={w} height={h} fill={overlay.paint} style={{ mixBlendMode: BLEND[el.effects.overlay!.blend] }} /> : null}
          </g>
        </SoftEdge>
        {el.line ? (
          el.clip ? (
            el.clip.filter((p) => p.stroke).map((p, i) => <path key={i} d={p.d} fill="none" {...strokeProps(el.line, stroke.paint)} />)
          ) : (
            <rect width={w} height={h} fill="none" {...strokeProps(el.line, stroke.paint)} />
          )
        ) : null}
      </svg>
    </div>
  );
}

function Table({ el, place, scope, path }: { el: TableElement; place: Place; scope: Scope; path: string }): ReactNode {
  const u = (v: number): string => cqw(v, scope.slideWidth);
  const box = boxOf(el.frame, place);
  const ctx = paintContext(scope, place, box.x, box.y);
  const background = svgPaint(el.background, `${scope.id}-${path}-bg`, ctx, { w: box.w, h: box.h });
  const border = (line: TableElement["rows"][number]["cells"][number]["borders"]["l"]): string | undefined =>
    line && line.fill?.kind === "solid" ? `${u(Math.max(line.width, 6350))} solid ${line.fill.color}` : undefined;
  return (
    <div style={frameStyle(el.frame, place, scope)}>
      {el.background ? (
        // The style's table background (often a themed gradient), under every
        // cell; a cell with no fill of its own shows it.
        <svg viewBox={`0 0 ${box.w} ${box.h}`} preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          <defs>{background.defs}</defs>
          <rect width={box.w} height={box.h} fill={background.paint} />
        </svg>
      ) : null}
      <table
        style={{
          position: "relative",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          width: u(el.columns.reduce((a, b) => a + b, 0) * place.sx),
        }}
      >
        <colgroup>
          {el.columns.map((c, i) => (
            <col key={i} style={{ width: u(c * place.sx) }} />
          ))}
        </colgroup>
        <tbody>
          {el.rows.map((row, r) => (
            <tr key={r} style={{ height: u(row.height * place.sy) }}>
              {row.cells.map((cell, c) =>
                cell.gridSpan === 0 ? null : (
                  <td
                    key={c}
                    colSpan={cell.gridSpan}
                    rowSpan={cell.rowSpan}
                    style={{
                      position: "relative",
                      padding: 0,
                      borderLeft: border(cell.borders.l),
                      borderRight: border(cell.borders.r),
                      borderTop: border(cell.borders.t),
                      borderBottom: border(cell.borders.b),
                      verticalAlign: cell.text.anchor === "ctr" ? "middle" : cell.text.anchor === "b" ? "bottom" : "top",
                    }}
                  >
                    {cell.fill ? <CellFill fill={cell.fill} id={`${scope.id}-${path}-${r}-${c}`} scope={scope} /> : null}
                    <CellText cell={cell} scope={scope} />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A cell's fill, any kind, stretched over the cell however tall it grew. */
function CellFill({ fill, id, scope }: { fill: NonNullable<TableElement["rows"][number]["cells"][number]["fill"]>; id: string; scope: Scope }): ReactNode {
  if (fill.kind === "solid") return <div style={{ position: "absolute", inset: 0, backgroundColor: fill.color }} />;
  const paint = svgPaint(fill, id, { resolve: scope.resolve, background: scope.background, slide: scope.slide, at: { x: 0, y: 0 } }, { w: 1000, h: 1000 });
  return (
    <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <defs>{paint.defs}</defs>
      <rect width={1000} height={1000} fill={paint.paint} />
    </svg>
  );
}

/** A cell grows with its text (unlike a shape), so its text flows in place. */
function CellText({ cell, scope }: { cell: TableElement["rows"][number]["cells"][number]; scope: Scope }): ReactNode {
  const u = (v: number): string => cqw(v, scope.slideWidth);
  const ins = cell.text.insets;
  return (
    <div style={{ padding: `${u(ins.t)} ${u(ins.r)} ${u(ins.b)} ${u(ins.l)}`, position: "relative" }}>
      <div style={{ position: "relative" }}>
        <SlideText body={{ ...cell.text, insets: { l: 0, t: 0, r: 0, b: 0 } }} box={{ x: 0, y: 0, w: 0, h: 0 }} slideWidth={scope.slideWidth} flow />
      </div>
    </div>
  );
}
