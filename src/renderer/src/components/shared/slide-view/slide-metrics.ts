import { useSyncExternalStore } from "react";

/**
 * Ascent and descent (em) of the face a run is actually drawn with (the
 * file's, an embedded one, a metric twin or a fallback), as the browser itself
 * measures it: where CSS puts a baseline inside a line box, which
 * `SlideParagraph` moves to where PowerPoint puts it. Cached per font list and
 * dropped whenever a font finishes loading (a face measured before it arrived
 * was the fallback's).
 */
const metricsCache = new Map<string, [number, number]>();
let measuring: CanvasRenderingContext2D | null | undefined;
/** Bumped when a face finishes loading, for the slides to draw again (`useFontsLoaded`). */
let fontsLoaded = 0;
const fontWatchers = new Set<() => void>();
if (typeof document !== "undefined" && document.fonts) {
  document.fonts.addEventListener("loadingdone", () => {
    metricsCache.clear();
    fontsLoaded += 1;
    for (const watcher of fontWatchers) watcher();
  });
}

/** Draws the caller again when a face finishes loading. `SlideView` is memoized on what it draws (A27): a face that
 *  arrived after its first draw left its text measured with the fallback for good (2026-11-15 audit, A41). */
export function useFontsLoaded(): number {
  return useSyncExternalStore(
    (watch) => {
      fontWatchers.add(watch);
      return () => fontWatchers.delete(watch);
    },
    () => fontsLoaded,
  );
}

export function metricsOf(fontList: string | undefined): [number, number] {
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
