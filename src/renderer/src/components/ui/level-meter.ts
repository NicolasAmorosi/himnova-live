/** The audio strip's meter as numbers: its range, its zones and how a bar moves between two frames (`ChannelStrip`). */

/** The meter's range and zones (owner's sketch, 2026-11-15): green up to −20, amber up to −9, red above. */
export const FLOOR_DB = -60;
export const ZONES = [
  [FLOOR_DB, -20, "ok"],
  [-20, -9, "warn"],
  [-9, 0, "over"],
] as const;
export const SCALE_DB = [0, -9, -20, -40];
/** A meter falls back slower than it rises, and the peak tick holds before it falls: what a mixer's does. */
const RELEASE_DB_PER_S = 24;
const PEAK_HOLD_MS = 1500;
const PEAK_FALL_DB_PER_S = 20;

/** One bar of the meter between two frames. Rises at once, falls at `RELEASE_DB_PER_S`; never below the floor. */
export type MeterChannel = { shown: number; peak: number; peakAt: number };

export const SILENT_CHANNEL: MeterChannel = { shown: FLOOR_DB, peak: FLOOR_DB, peakAt: 0 };

export function stepMeterChannel(channel: MeterChannel, target: number, now: number, dtMs: number): MeterChannel {
  const fallen = channel.shown - (RELEASE_DB_PER_S * dtMs) / 1000;
  const shown = Math.max(FLOOR_DB, target >= channel.shown ? target : Math.max(target, fallen));
  if (shown >= channel.peak) return { shown, peak: shown, peakAt: now };
  const peak =
    now - channel.peakAt < PEAK_HOLD_MS ? channel.peak : Math.max(shown, channel.peak - (PEAK_FALL_DB_PER_S * dtMs) / 1000);
  return { shown, peak, peakAt: channel.peakAt };
}

export const isLit = (channel: MeterChannel): boolean => channel.shown > FLOOR_DB || channel.peak > FLOOR_DB;

