/** Where the app's sound goes (owner, 2026-11-15): LIVE is what the room and the NDI® hear, PREVIEW what the operator
 *  listens to before it goes live. Each has a strip beside its monitor (`AudioStrip`). */
export type AudioBus = "live" | "preview";

/**
 * An audio output chosen for a bus (Settings ▸ Sound, or the strip's output menu); the setting is `null` for the
 * system's default output. Chromium (`setSinkId`) and the media engine (mpv's `audio-device`) list the same device
 * under ids of their own, so the two are matched by its NAME: `label`, as Chromium lists it. `deviceId` is Chromium's
 * id for it: a hint only Chromium can use, and stale once the device moves to another port.
 */
export type AudioOutputChoice = { label: string; deviceId: string };

const FIELD_MAX_LENGTH = 512;

const isField = (v: unknown, minLength: number): boolean =>
  typeof v === "string" && v.length >= minLength && v.length <= FIELD_MAX_LENGTH;

export function isAudioOutputChoice(v: unknown): v is AudioOutputChoice {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const { label, deviceId } = v as Record<string, unknown>;
  return isField(label, 1) && isField(deviceId, 0);
}

/** What a LIVE item plays at: its own level times the LIVE strip's fader (the master), both 0..1. Clamped, and never
 *  NaN: `HTMLMediaElement.volume` throws on either. */
export function busVolume(item: number, master: number): number {
  const volume = item * master;
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
}

/** The LIVE master in effect. With the strips off it is 100 % (owner, 2026-11-15, D3): a level nobody can see on
 *  screen is a level nobody can explain from the booth. */
export function liveMasterVolume(strips: boolean, volume: number): number {
  return strips ? volume : 1;
}
