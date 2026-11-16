/**
 * Faces that ship with Office but not with macOS or Linux, and the metric-compatible face that keeps the file's line
 * breaks when the original is missing: Carlito, Caladea and Liberation, the ones Himnova bundles
 * (`assets/fonts/slides/`) and Linux distributions install. Named after the file's own face, so an installed original
 * wins. The one table for a slide's text (main), a metafile's text and a chart's: a face with no open twin (Arial
 * Narrow, Candara…) gets none here and falls to the chosen fallback.
 */
const METRIC_TWINS: Readonly<Record<string, string>> = {
  calibri: "Carlito",
  "calibri light": "Carlito",
  cambria: "Caladea",
  arial: "Liberation Sans",
  "times new roman": "Liberation Serif",
  "courier new": "Liberation Mono",
  // ChromeOS's names for the Liberation designs (Google Slides writes them).
  arimo: "Liberation Sans",
  tinos: "Liberation Serif",
  cousine: "Liberation Mono",
};

/** The metric twin of `face` (any case), or `null` when it has none. */
export function metricTwin(face: string): string | null {
  return METRIC_TWINS[face.toLowerCase()] ?? null;
}
