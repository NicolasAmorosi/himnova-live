/** How close together two requests have to arrive to be one ask: the slide the
 *  projector shows, then the pages it warms next to it, land within a frame. */
export const RASTER_BURST_MS = 50;

/**
 * Takes the next task to draw out of `queue` (arrival order): the first of the
 * newest burst — every task that arrived within `burstMs` of the newest one.
 *
 * An operator pressing → through a PDF queues a page per press, and the window
 * gave up on all but the last; Electron never tells main (a `protocol.handle`
 * request's `signal` is not aborted when the page drops the image — measured,
 * Electron 44). First-come-first-served drew every abandoned page before the
 * one on screen: 2–2.6 s on Windows/Linux after 12 quick presses. Newest
 * burst first puts the slide on screen next, and inside the burst arrival
 * order keeps it ahead of the pages warmed after it. Abandoned pages are still
 * drawn, later — nothing that was asked for is ever dropped.
 */
export function takeNewestBurst<T extends { at: number }>(queue: T[], burstMs = RASTER_BURST_MS): T | undefined {
  const newest = queue.at(-1);
  if (!newest) return undefined;
  const start = queue.findIndex((task) => task.at >= newest.at - burstMs);
  return queue.splice(start, 1)[0];
}
