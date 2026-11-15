import { useRef } from "react";

/** Where an unmute lands when the operator never chose a level before muting. */
const FALLBACK_LEVEL = 0.5;

/** Mute as `volume = 0`, unmute back to the last level the operator heard (shared with the audio strips,
 *  `ChannelStrip`). The level lives here, not in a store: one number crosses IPC, the element's own `volume`. */
export function useMuteToggle(value: number, onChange: (volume: number) => void): () => void {
  /** Only ever written with a level the operator actually heard, so unmuting
   *  restores what they set rather than a default they never chose. */
  const lastAudible = useRef(value > 0 ? value : FALLBACK_LEVEL);
  if (value > 0) lastAudible.current = value;
  return () => onChange(value === 0 ? lastAudible.current : 0);
}
