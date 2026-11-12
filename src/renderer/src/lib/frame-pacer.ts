/**
 * When a media-engine frame goes on screen: at an animation frame, the page's own clock, one video frame
 * per its share of refreshes — never as it lands.
 *
 * Drawn as they landed, the frames met the compositor (60 Hz projector) and the NDI window (30 Hz) on
 * clocks of their own: by the phase each playback started with, NDI lost 8–37 % of an engine video's
 * frames, a 1080p60 lost up to 45 % on the projector, and a 30 fps one alternated 17/50 ms instead of
 * 33/33 (2026-11-10 review, agent2-01/03/04, agent1-02) — the 2.7.0 NDI bug's class, on screen.
 *
 * A frame is due once `floor(frame interval / refresh interval + ¼)` refreshes have gone by since the
 * last one drawn (2 for 30 fps at 60 Hz, alternating 3 and 2 for 24/25 fps, 1 for 60 fps or for the
 * 30 Hz NDI window): the cadence stays even whatever the arrival jitter. Two or more waiting means it is
 * behind, and the oldest goes up at once. Both intervals are measured, not assumed: a projector may run
 * at 50 or 75 Hz.
 *
 * A source faster than 40 fps goes up at half its rate, every other frame (owner, 2026-11-10): at 60 fps one
 * page frame in five that Chromium starts ~8 ms late still lost 0.3–20 % of them on the Mac's projector, at
 * random; a steady 30 never loses one. A `<video>` (Chromium's own path) keeps its 60.
 */
/** Frames closer than this (ms) are a source over 40 fps: halved. */
const HALVE_UNDER_MS = 25;
/** The rate is seeded by the median of the first this-many intervals, not by the first one: an engine starts
 *  with 2–3 frames ~2–9 ms apart, and a rate seeded by that burst halved a 30 fps clip for its first ~0.6 s (the
 *  2 h soak, 2026-11-11: 0, 1, 5, 6, 8, 10, 10, 12… on every engine start). */
const RATE_SEED_GAPS = 5;

export class FramePacer {
  private frameMs = 0;
  private refreshMs = 0;
  private lastArrival = -1;
  private lastTick = -1;
  private ticksSinceDraw = 0;
  private skipNext = false;
  private seedGaps: number[] = [];

  /** A frame landed at `now` (ms): whether it is one to show (not the half of a fast source left out). */
  arrived(now: number): boolean {
    const gap = now - this.lastArrival;
    // A pause, a seek or the first frame says nothing about the video's rate.
    if (this.lastArrival >= 0 && gap > 4 && gap < 250) {
      if (this.frameMs) this.frameMs = this.frameMs * 0.9 + gap * 0.1;
      else if (this.seedGaps.push(gap) === RATE_SEED_GAPS) {
        this.frameMs = this.seedGaps.sort((a, b) => a - b)[RATE_SEED_GAPS >> 1]!;
      }
    }
    this.lastArrival = now;
    if (!this.halved()) return true;
    this.skipNext = !this.skipNext;
    return this.skipNext;
  }

  private halved(): boolean {
    return this.frameMs > 0 && this.frameMs < HALVE_UNDER_MS;
  }

  /** An animation frame at `now` (ms), `queued` frames waiting: whether the oldest goes up now. */
  tick(now: number, queued: number): boolean {
    const gap = now - this.lastTick;
    if (this.lastTick >= 0 && gap > 4 && gap < 100) this.refreshMs = this.refreshMs ? this.refreshMs * 0.9 + gap * 0.1 : gap;
    this.lastTick = now;
    this.ticksSinceDraw += 1;
    if (queued === 0) return false;
    const frameMs = this.halved() ? this.frameMs * 2 : this.frameMs;
    const due = frameMs && this.refreshMs ? Math.max(1, Math.floor(frameMs / this.refreshMs + 0.25)) : 1;
    if (queued < 2 && this.ticksSinceDraw < due) return false;
    this.ticksSinceDraw = 0;
    return true;
  }
}
