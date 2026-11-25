export type DisplayInfo = {
  id: number;
  /** The device name the OS reports, «» when it gives none (often on Linux), with «#2» when two screens would
   *  otherwise read the same. The renderer says it with its resolution (`resolutionLabel`), in its own language. */
  name: string;
  /** The operator's own screen: the one hosting the control window, not the OS's «primary» (a
   *  church may have made the projector its primary display). */
  operator: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  /** Where `projection.fit` keeps this screen's picture size (`projectorFitKey`). */
  fitKey: string;
};

/** What the projector window draws besides the output: its picture's size (0.8–1, centred) and the test pattern
 *  Settings ▸ Screens shows while the operator fits it. Pushed only to the projector, never to its copies. */
export type ProjectorFit = { scale: number; pattern: boolean };

/** The smallest picture the projector draws, in percent. Overscan cuts 2.5–5 % per edge; 80 leaves room for more. */
export const PROJECTOR_FIT_MIN = 80;
/** Screens `projection.fit` remembers: a laptop that visits many rooms, not an unbounded list. */
export const PROJECTOR_FIT_MAX_SCREENS = 64;

/** A screen's mode in device pixels: Electron's `Display.bounds` are scaled units (DIPs), Chromium draws at pixels. */
export function pixelSize(width: number, height: number, scaleFactor: number): { width: number; height: number } {
  return { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) };
}

/**
 * Which screen a projector fit belongs to: its name and its mode in pixels, never its id or its place (Windows
 * renumbers screens across restarts and a projector moves between ports). Two projectors of the same model share
 * one, and overscan is the model's. The mode is in device pixels, so changing Windows' scale keeps the fit.
 */
export function projectorFitKey(label: string, width: number, height: number, scaleFactor: number): string {
  const pixels = pixelSize(width, height, scaleFactor);
  return `${label.trim()}|${pixels.width}x${pixels.height}`;
}

/** The words a resolution is said with, in the interface's language. */
export type ResolutionWords = { looksLike: (size: string) => string; pictureTakes: (size: string) => string };

/**
 * A screen's resolution, the one formatter for every place that shows it (owner, 2026-11-25): its real size in
 * device pixels first. Windows and Linux report screens in scaled units (a 1920x1080 projector at Windows' 125 % came
 * out as «1536x864», 2026-11-21), so a scaled screen adds its scale, as their settings say it. macOS's settings speak
 * in points («looks like 1470 × 956»), so a Retina screen adds those. With the projector's fit below 100 % (`fit`, in
 * percent), it adds the pixels the picture takes.
 */
export function resolutionLabel(
  width: number,
  height: number,
  scaleFactor: number,
  mac: boolean,
  words: ResolutionWords,
  fit = 100,
): string {
  const pixels = pixelSize(width, height, scaleFactor);
  const parts = [`${pixels.width}x${pixels.height}`];
  if (scaleFactor !== 1) parts.push(mac ? words.looksLike(`${width}x${height}`) : `${Math.round(scaleFactor * 100)} %`);
  if (fit < 100) {
    parts.push(words.pictureTakes(`${Math.round((pixels.width * fit) / 100)}x${Math.round((pixels.height * fit) / 100)}`));
  }
  return parts.join(" · ");
}
