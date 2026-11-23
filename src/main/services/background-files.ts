import fs from "node:fs";

/**
 * Background work on the operator's files (the library sweep, a linked folder's listing, an import, a relocation)
 * holds at most two of libuv's four threads. The same four serve every file the projector shows (a slide's `stat`, an
 * image, the bytes a video starts from), and a `stat` on a share that went away holds its thread for up to 21 s on
 * Windows: a sweep of 200 such rows queued every on-air read behind them (2026-11-22 audit, RM2).
 */
const IN_FLIGHT = 2;
let running = 0;
const waiting: (() => void)[] = [];

export async function backgroundStat(file: string): Promise<fs.Stats> {
  if (running < IN_FLIGHT) running += 1;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await fs.promises.stat(file);
  } finally {
    // The slot passes straight to the next one waiting, so a caller arriving in between cannot take a third.
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
}
