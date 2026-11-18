/**
 * Where a volume fader sits for a level: OBS's log fader (`OBS_FADER_LOG`, `libobs/obs-audio-controls.c`), the one the
 * operator streaming the service has open next to this app (owner, 2026-11-17, U16). The level itself stays a linear
 * gain from 0 to 1 everywhere else; a linear fader spent its last tenth going from −20 dB to silence, so a fade by hand
 * cut out at the end.
 */
const RANGE_DB = 96;
const OFFSET_DB = 6;
const LOG_TOP = Math.log10(RANGE_DB + OFFSET_DB);
const LOG_SPAN = LOG_TOP - Math.log10(OFFSET_DB);

/** A fader's position, 0..1, as a linear gain, 0..1: silence at 0, −96 dB just above it, −18.7 dB halfway, 0 dB on top. */
export function faderToGain(position: number): number {
  if (position <= 0) return 0;
  if (position >= 1) return 1;
  const db = OFFSET_DB - (RANGE_DB + OFFSET_DB) * 10 ** (-position * LOG_SPAN);
  return 10 ** (db / 20);
}

/** Where a fader sits, 0..1, for a linear gain, 0..1: `faderToGain` backwards. */
export function gainToFader(gain: number): number {
  if (gain >= 1) return 1;
  const db = gain > 0 ? 20 * Math.log10(gain) : -Infinity;
  if (db <= -RANGE_DB) return 0;
  return (LOG_TOP - Math.log10(OFFSET_DB - db)) / LOG_SPAN;
}

/** «−6 dB», «−∞ dB»: a level as a mixer says it. */
export function formatDb(gain: number): string {
  if (gain <= 0) return "−∞ dB";
  const db = Math.round(20 * Math.log10(gain));
  return `${db < 0 ? "−" : ""}${Math.abs(db)} dB`;
}
