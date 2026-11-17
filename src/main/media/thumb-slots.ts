import { takeNewestBurst } from "../slides/raster-order";

/** A generation's place in line: `at` is when it was last asked for (`Date.now()`), what `takeNewestBurst` orders by. */
export type Turn = { at: number; start?: () => void };

/**
 * `max` thumbnail generations at once (`thumbnail-service.ts`); the rest wait, and the newest ask goes first.
 *
 * A folder of 300 videos scrolled through asked for every tile it passed, and arrival order drew all of them before
 * the tiles on screen: ~2 s on the Mac, ~15 s for photos on Linux (2026-11-15 audit, R7). Nothing is cancelled:
 * Electron never aborts a `protocol.handle` request's `signal` when the page drops the image (measured, Electron
 * 44), so what scrolled past is still drawn, after what is on screen. A tile asking again for a generation still
 * waiting (scrolled back) moves it to the newest ask (`bump`); inside one ask (a screenful, within 50 ms) arrival
 * order keeps the tiles top first.
 *
 * The slot is owned from the moment it is granted, and handed straight from one holder to the next: the waiter
 * incrementing `running` itself, a microtask after the `release()` that woke it, let a fresh `acquire()` in that gap
 * take a slot already spoken for, one more blocking decode than the number chosen as safe.
 */
export class ThumbSlots {
  private running = 0;
  private readonly waiting: Turn[] = [];

  constructor(private readonly max: number) {}

  acquire(turn: Turn): Promise<void> {
    if (this.running < this.max) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      turn.start = resolve;
      this.waiting.push(turn);
    });
  }

  release(): void {
    const next = takeNewestBurst(this.waiting);
    // Transfer, don't decrement-then-grant: `running` never dips, so no caller arriving in between can overtake.
    if (next) next.start?.();
    else this.running -= 1;
  }

  /** Asked for again while it waits: it joins the newest ask. A running or finished one is left alone. */
  bump(turn: Turn, now = Date.now()): void {
    const at = this.waiting.indexOf(turn);
    if (at < 0) return;
    this.waiting.splice(at, 1);
    turn.at = now;
    this.waiting.push(turn);
  }
}
