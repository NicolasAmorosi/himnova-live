import type { AudioBus } from "@shared/types/audio";
import { broadcast } from "../services/broadcast";
import { getSettingsRepo } from "../services/repos";

/** Left and right in dBFS (sample peak); `-Infinity` is silence. */
export type StereoDb = [number, number];

/** How often the control windows hear the buses: what the engine measures at (`EngineEvents.level`). */
const TICK_MS = 40;
/** A source that has said nothing for this long is gone (its engine quit, the projector closed): it stops counting.
 *  A playing source says something every ~40 ms; one that pauses says it once, silent. */
const STALE_MS = 200;
/** Quieter than this is silence: no meter draws it (they stop at −60), and nothing is sent for it. */
const SILENCE_DB = -90;

const sources = new Map<unknown, { bus: AudioBus; level: StereoDb; at: number }>();
let timer: NodeJS.Timeout | null = null;
let sentSound = false;

/** `peak` heard through `gain`: a source's level as the room hears it, after every fader. */
export function heardAt(peak: readonly [number, number], gain: number): StereoDb {
  const db = Number.isFinite(gain) && gain > 0 ? 20 * Math.log10(gain) : -Infinity;
  return [peak[0] + db, peak[1] + db];
}

/**
 * One source's level as the room (LIVE) or the operator (PREVIEW) hears it, in dBFS after its final gain: an engine
 * session (its peak through its volume) or the projector's own Chromium elements (already through theirs). Each bus
 * is the loudest of its sources per channel, sent to the control windows as ONE `audio-levels` every 40 ms while any
 * of them sounds, then one silent message: nothing crosses while nothing plays, nor while the strips are off.
 */
export function reportLevel(source: unknown, bus: AudioBus, level: StereoDb): void {
  if (!getSettingsRepo().get("audio.strips")) return;
  sources.set(source, { bus, level, at: Date.now() });
  timer ??= setInterval(tick, TICK_MS);
}

/** The buses from what each source last said, at `now`; the stale ones are forgotten. */
export function mixBuses(now: number): Record<AudioBus, StereoDb> {
  const buses: Record<AudioBus, StereoDb> = { live: [-Infinity, -Infinity], preview: [-Infinity, -Infinity] };
  for (const [key, { bus, level, at }] of sources) {
    if (now - at > STALE_MS) {
      sources.delete(key);
      continue;
    }
    const mix = buses[bus];
    mix[0] = Math.max(mix[0], level[0]);
    mix[1] = Math.max(mix[1], level[1]);
  }
  const heard = (db: number) => (db > SILENCE_DB ? db : -Infinity);
  return {
    live: [heard(buses.live[0]), heard(buses.live[1])],
    preview: [heard(buses.preview[0]), heard(buses.preview[1])],
  };
}

function tick(): void {
  const buses = mixBuses(Date.now());
  const sounds = [...buses.live, ...buses.preview].some((db) => db > -Infinity);
  if (sounds || sentSound) broadcast("audio-levels", buses);
  sentSound = sounds;
  if (sources.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}
