import type { ChartPlot } from "@shared/types/slide-chart";

/** A cached value as a number; `null` for a gap, text or a non-finite one. */
export const num = (v: number | string | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Where a point runs along the value axis, in values (a 100% stack's in fractions of its category's total). */
export type Span = { from: number; to: number };

/**
 * Where each point of a bar, area or line plot runs on the value axis, by series then category: from the axis (0) or
 * the top of the stack under it, to its own end. The one stacking the drawing and the labels both read: written six
 * times, a 3-D area's labels at 100% had lost the division and all sat at the top (2026-11-15 audit, X26).
 *
 * Bars stack positives up and negatives down apart, and at 100% divide by the category's sum of sizes; areas and
 * lines run one signed sum, divided by the category's signed total. `null` where nothing is drawn: a missing value,
 * except in a stacked area or line, where it adds nothing and the point sits on the stack under it.
 */
export function stacks(p: Extract<ChartPlot, { kind: "bar" | "area" | "line" }>, count: number): (Span | null)[][] {
  const stacked = p.grouping === "stacked" || p.grouping === "percentStacked";
  const bars = p.kind === "bar";
  const totals = Array.from({ length: count }, (_, i) =>
    p.series.reduce((sum, s) => sum + (bars ? Math.abs(num(s.values.values[i]) ?? 0) : (num(s.values.values[i]) ?? 0)), 0),
  );
  const up = Array.from({ length: count }, () => 0);
  const down = Array.from({ length: count }, () => 0);
  return p.series.map((s) =>
    Array.from({ length: count }, (_, i) => {
      let v = num(s.values.values[i]);
      if (v === null && (bars || !stacked)) return null;
      v ??= 0;
      if (p.grouping === "percentStacked") v = totals[i] ? v / totals[i] : 0;
      if (!stacked) return { from: 0, to: v };
      const acc = bars && v < 0 ? down : up;
      const from = acc[i]!;
      acc[i] = from + v;
      return { from, to: from + v };
    }),
  );
}
