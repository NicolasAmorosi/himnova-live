export type DisplayInfo = {
  id: number;
  label: string;
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

/**
 * Which screen a projector fit belongs to: its name and its mode in pixels, never its id or its place (Windows
 * renumbers screens across restarts and a projector moves between ports). Two projectors of the same model share
 * one, and overscan is the model's. The mode is in device pixels, so changing Windows' scale keeps the fit.
 */
export function projectorFitKey(label: string, width: number, height: number, scaleFactor: number): string {
  return `${label.trim()}|${Math.round(width * scaleFactor)}x${Math.round(height * scaleFactor)}`;
}

/**
 * A screen's size as its own system's display settings say it, so the number in Settings matches the one the church
 * sees there. Windows and Linux report screens in scaled units: a 1920x1080 projector at Windows' 125 % came out as
 * «1536x864», a size no screen has (2026-11-21, a church's projector). There it is the mode in pixels, with the scale
 * when it is not 100 %. macOS's settings speak in those same units («looks like 1512 × 982»), so there they stay.
 */
export function resolutionLabel(width: number, height: number, scaleFactor: number, platform: string): string {
  if (platform === "darwin" || scaleFactor === 1) return `${width}x${height}`;
  const size = `${Math.round(width * scaleFactor)}x${Math.round(height * scaleFactor)}`;
  return `${size} · ${Math.round(scaleFactor * 100)} %`;
}
