/**
 * The pure half of `NdiSender.offer` (`ndi-output.ts`): which of the NDI window's paints reach the engine.
 * Tested in `tests/main/ndi-pacing.test.ts`.
 */

/** With nobody watching, a frame at most this often. The NDI SDK hands the last frame it sent to every new
 *  receiver the moment it connects (measured 2026-11-09), and OBS can reconnect on every scene change:
 *  never sending would put a picture from minutes ago on air. The engine encodes these once each. */
export const IDLE_FRAME_MS = 500;
/** A dropped paint whose page then went still is drawn again after this. */
export const SETTLE_MS = 100;

/**
 * A paint goes to the engine (`send`) when it is ready, no frame is in flight (one at a time: Chromium's pool
 * is small and a held texture stalls it) and, with no receivers, the last idle frame is `IDLE_FRAME_MS` old.
 * A dropped one may have been the page's last picture (the end of a fade): `redrawInMs` says when to draw it
 * again — `null` before the engine is ready, when there is nothing to draw it for.
 */
export function paintVerdict(state: {
  ready: boolean;
  inFlight: boolean;
  receivers: number;
  msSinceIdleFrame: number;
}): { send: true } | { send: false; redrawInMs: number | null } {
  if (!state.ready) return { send: false, redrawInMs: null };
  const idleWait = state.receivers === 0 ? IDLE_FRAME_MS - state.msSinceIdleFrame : 0;
  if (state.inFlight || idleWait > 0) return { send: false, redrawInMs: Math.max(idleWait, SETTLE_MS) };
  return { send: true };
}
