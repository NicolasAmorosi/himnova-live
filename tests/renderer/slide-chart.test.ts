/**
 * What a chart draws, read off `SlideChart`'s markup: a defect only the drawing shows (a face, where a label lands).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { ChartAxis, ChartFont, ChartModel, ChartPlot, ChartSeries } from "@shared/types/slide-chart";
import type { Effects } from "@shared/types/slide-model";
import { SlideChart } from "@renderer/components/shared/slide-view/slide-chart";

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

function series(index: number, values: (number | null)[], color: string): ChartSeries {
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
    labels: values.map(() => null),
  };
}

function chart(plot: ChartPlot, face = "Calibri"): ChartModel {
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
    view3D: null,
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
