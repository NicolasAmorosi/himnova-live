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

/**
 * Where a bus sounds, resolved by the control window (`effects/audio-route.ts`) from the choice and the devices
 * plugged in: `sinkId` is Chromium's (`HTMLMediaElement.setSinkId`, "" the system's default) and `engineDevice` the
 * media engine's (mpv's `audio-device`, null the system's default). Always ONE device for both: a choice either side
 * cannot open sends the whole bus to the default, never half of it. LIVE's travels in the `ProjectionOutput`.
 */
export type AudioOut = { sinkId: string; engineDevice: string | null };

export const DEFAULT_AUDIO_OUT: AudioOut = { sinkId: "", engineDevice: null };

/** Where the engine's sound goes, as the control window resolved it (`audioRoute:set`): each bus's engine device (null
 *  the system's default) and whether PREVIEW plays on another output than LIVE (the NDI® sound is captured from
 *  LIVE's, D6). One message for both buses, so main never applies half of a change. */
export type AudioRoute = { live: string | null; preview: string | null; previewApart: boolean };

/** The media engine's name for each output asked (`audioRoute:matchOutputs`): «auto» for the default, null for none or
 *  more than one. "none": this build's engine cannot choose an output (none, or older than engine-8), so only
 *  Chromium moves; "pending": an engine that can has not answered yet, so nothing may move. */
export type EngineOutputNames = (string | null)[] | "none" | "pending";

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
 *  screen is a level nobody can explain from the booth. `muted` is the strip's mute (`audio.live.muted`, remembered:
 *  an app left silent opens silent, owner 2026-11-17); `volume` is the remembered level, never 0. */
export function liveMasterVolume(strips: boolean, volume: number, muted = false): number {
  if (!strips) return 1;
  return muted ? 0 : volume;
}
