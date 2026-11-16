/**
 * What a chart draws, read off `SlideChart`'s markup: a defect only the drawing shows (a face, where a label lands).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Chart3D, ChartAxis, ChartDataLabel, ChartFont, ChartModel, ChartPlot, ChartSeries } from "@shared/types/slide-chart";
import type { Effects } from "@shared/types/slide-model";
import { SlideChart } from "@renderer/components/shared/slide-view/slide-chart";
import { stacks } from "@renderer/components/shared/slide-view/slide-chart-stacks";

const NO_EFFECTS: Effects = { shadow: null, glow: null, softEdge: null, reflection: null, overlay: null };
const BOX = { fill: null, line: null, effects: NO_EFFECTS };

function font(face = "Calibri"): ChartFont {
  return { face, size: 10, bold: false, italic: false, underline: false, color: "#000000" };
}

function axis(kind: ChartAxis["kind"], face: string): ChartAxis {
  return {
    kind,
    deleted: false,
    reversed: false,
    min: null,
    max: null,
    majorUnit: null,
    minorUnit: null,
    format: null,
    labels: "nextTo",
    majorTick: "out",
    line: null,
    majorGrid: null,
    minorGrid: null,
    font: font(face),
    rotation: null,
    crosses: "autoZero",
    between: true,
    title: null,
    labelSkip: null,
    tickSkip: null,
    labelOffset: 100,
  };
}

/** A label that reads `text`, so the markup says whose it is. */
function label(text: string, position: ChartDataLabel["position"]): ChartDataLabel {
  return {
    value: false,
    percent: false,
    category: false,
    series: false,
    separator: null,
    position,
    format: null,
    font: font(),
    fill: null,
    line: null,
    size: false,
    offset: null,
    text: [{ align: "ctr", runs: [{ text, font: font() }] }],
    legendKey: false,
  };
}

function series(index: number, values: (number | null)[], color: string, position?: ChartDataLabel["position"]): ChartSeries {
  return {
    index,
    name: `S${index}`,
    values: { values, format: "General" },
    xValues: null,
    sizes: null,
    bubble3D: false,
    fill: { kind: "solid", color },
    line: null,
    effects: NO_EFFECTS,
    marker: null,
    points: null,
    smooth: false,
    explosion: 0,
    labels: values.map((_, i) => (position === undefined ? null : label(`S${index}.${i}`, position))),
  };
}

function chart(plot: ChartPlot, face = "Calibri", view3D: Chart3D | null = null): ChartModel {
  const count = Math.max(...plot.series.map((s) => s.values.values.length));
  return {
    kind: "chart",
    space: BOX,
    font: font(face),
    title: null,
    legend: null,
    plotArea: { ...BOX, layout: null },
    plots: [plot],
    categories: { values: Array.from({ length: count }, (_, i) => `C${i}`), format: "General" },
    categoryGroups: [],
    categoryAxis: axis("category", face),
    valueAxis: axis("value", face),
    secondary: null,
    date1904: false,
    view3D,
  };
}

function draw(model: ChartModel): string {
  return renderToStaticMarkup(createElement(SlideChart, { chart: model, w: 6_000_000, h: 4_000_000, slideWidth: 12_192_000 }));
}

test("a chart in Tinos (Google Slides) is drawn in its serif twin, not the sans fallback", () => {
  // The chart's own twin table had no «tinos»: on a machine without it, every label came out without serifs
  // (2026-11-15 audit, X7).
  const markup = draw(chart({ kind: "bar", horizontal: false, grouping: "clustered", gapWidth: 150, overlap: 0, series: [series(0, [1, 2], "#336699")] }, "Tinos"));
  expect(markup).toContain('font-family="&quot;Tinos&quot;, &quot;Liberation Serif&quot;, ');
});

/** Each label's baseline point (EMU), by its text. */
function labels(markup: string): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const m of markup.matchAll(/<text x="([^"]+)" y="([^"]+)"[^>]*><tspan[^>]*>(S\d+\.\d+)<\/tspan><\/text>/g)) {
    out.set(m[3]!, { x: Number(m[1]) * 12700, y: Number(m[2]) * 12700 });
  }
  return out;
}

/** Each bar's rectangle (EMU), by its fill. */
function bars(markup: string): Map<string, { y: number; h: number }[]> {
  const out = new Map<string, { y: number; h: number }[]>();
  for (const m of markup.matchAll(/translate\([^ ]+ ([^)]+)\)"><rect width="[^"]+" height="([^"]+)" fill="(#[0-9a-f]{6})"/g)) {
    out.set(m[3]!, [...(out.get(m[3]!) ?? []), { y: Number(m[1]), h: Number(m[2]) }]);
  }
  return out;
}

test("stacks: bars stack negatives apart, areas run one sum, and a missing value is drawn as nothing", () => {
  const bar = (grouping: "stacked" | "percentStacked" | "clustered"): ChartPlot & { kind: "bar" } => ({
    kind: "bar",
    horizontal: false,
    grouping,
    gapWidth: 150,
    overlap: 100,
    series: [series(0, [3, null], "#aa0000"), series(1, [-1, 2], "#0000aa"), series(2, [1, 2], "#00aa00")],
  });
  expect(stacks(bar("percentStacked"), 2)).toEqual([
    [{ from: 0, to: 0.6 }, null],
    [{ from: 0, to: -0.2 }, { from: 0, to: 0.5 }],
    [{ from: 0.6, to: 0.8 }, { from: 0.5, to: 1 }],
  ]);
  expect(stacks(bar("clustered"), 2)[1]).toEqual([{ from: 0, to: -1 }, { from: 0, to: 2 }]);
  const area = (grouping: "stacked" | "standard"): ChartPlot & { kind: "area" } => ({
    kind: "area",
    grouping,
    series: [series(0, [1, null], "#aa0000"), series(1, [2, 2], "#0000aa")],
  });
  // Stacked, a missing value adds nothing and its point sits on the stack; not stacked, it is a gap.
  expect(stacks(area("stacked"), 2)).toEqual([
    [{ from: 0, to: 1 }, { from: 0, to: 0 }],
    [{ from: 1, to: 3 }, { from: 0, to: 2 }],
  ]);
  expect(stacks(area("standard"), 2)[0]).toEqual([{ from: 0, to: 1 }, null]);
});

test("a 100% stacked column's centred labels sit on their own bars, the negative's below the axis", () => {
  // The labels ran one sum where the drawing stacks negatives down apart: the -1's label landed inside the 3's bar
  // (2026-11-15 audit, X26).
  const markup = draw(
    chart({
      kind: "bar",
      horizontal: false,
      grouping: "percentStacked",
      gapWidth: 150,
      overlap: 100,
      series: [series(0, [3], "#aa0000", "ctr"), series(1, [-1], "#0000aa", "ctr")],
    }),
  );
  const at = labels(markup);
  const drawn = bars(markup);
  for (const [text, fill] of [["S0.0", "#aa0000"], ["S1.0", "#0000aa"]] as const) {
    const { y } = at.get(text)!;
    const [bar] = drawn.get(fill)!;
    expect(y, text).toBeGreaterThan(bar!.y);
    expect(y, text).toBeLessThan(bar!.y + bar!.h);
  }
});

test("a 100% stacked area's labels sit on its drawn edge when a value is negative", () => {
  // The labels divided by the category's sum of sizes, the drawing by its signed total: with a negative, every label
  // floated off its area (2026-11-15 audit, X26).
  const markup = draw(
    chart({
      kind: "area",
      grouping: "percentStacked",
      series: [series(0, [2, 2], "#aa0000", "ctr"), series(1, [-1, -1], "#00aa00", "ctr"), series(2, [3, 3], "#0000aa", "ctr")],
    }),
  );
  const at = labels(markup);
  for (const [k, fill] of ["#aa0000", "#00aa00", "#0000aa"].entries()) {
    // The area's first point is its top edge over the first category.
    const m = new RegExp(`translate\\([^ ]+ ([^)]+)\\)"><path d="M[^ ]+ ([^L]+)L[^"]*" fill="${fill}"`).exec(markup)!;
    const edge = Number(m[1]) + Number(m[2]);
    // A centred label's baseline is within its own line of the point.
    expect(Math.abs(at.get(`S${k}.0`)!.y - edge), fill).toBeLessThan(10 * 12700);
  }
});

test("a 3-D 100% stacked area's labels climb with their stack instead of all sitting at the top", () => {
  // The 3-D area's labels never divided by the category's total: every running sum past 1 was clamped to the top of
  // the box, 21 labels at 7 heights in the real «Dark» chart (2026-11-15 audit, X26).
  const view: Chart3D = {
    rotX: 15,
    rotY: 20,
    rightAngles: true,
    fov: 0,
    depth: 100,
    gapDepth: 150,
    shape: "box",
    floor: BOX,
    sideWall: BOX,
    backWall: BOX,
  };
  const markup = draw(
    chart(
      {
        kind: "area",
        grouping: "percentStacked",
        series: [series(0, [2, 3], "#aa0000", "r"), series(1, [1, 1], "#00aa00", "r"), series(2, [1, 2], "#0000aa", "r")],
      },
      "Calibri",
      view,
    ),
  );
  const at = labels(markup);
  for (const i of [0, 1]) {
    const [low, mid, high] = [0, 1, 2].map((k) => at.get(`S${k}.${i}`)!.y);
    // Down the page is up the stack.
    expect(low).toBeGreaterThan(mid!);
    expect(mid).toBeGreaterThan(high!);
  }
});
