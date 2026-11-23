import fs from "node:fs";

/**
 * Background work on the operator's files (the library sweep, a linked folder's listing, an import, a relocation, the
 * decks read ahead) holds at most two of libuv's four threads. The same four serve every file the projector shows (a
 * slide's `stat`, an image, the bytes a video starts from), and a `stat` on a share that went away holds its thread for
 * up to 21 s on Windows: a sweep of 200 such rows queued every on-air read behind them (2026-11-22 audit, RM2).
 */
const IN_FLIGHT = 2;
let running = 0;
/** Two rows for the same two threads: the decks read ahead are served before the sweep and the rest. In one row a
 *  hymn read ahead waited behind a sweep's whole chunk of 200 rows, up to ~35 min with a dead share in the library,
 *  and GO LIVE read it on the spot (2026-11-22 review, RN2-3). */
const waiting: (() => void)[] = [];
const waitingAhead: (() => void)[] = [];

/** The stats under way, one per path, whether the operator started it and when: GO LIVE's check of a file
 *  (`MediaRepo.check`) and the deck read right after it stat it once, and background work never stats a file twice at
 *  a time (2026-11-22 review, RN-6). Only a stat already started is here, never one still waiting for a thread, and
 *  nothing is kept once it answers. */
const started = new Map<string, { stat: Promise<fs.Stats>; operator: boolean; at: number }>();

/** How old a stat of the operator's may be for another of their asks to join it. */
const OPERATOR_JOIN_MS = 2000;

function start(file: string, operator: boolean): Promise<fs.Stats> {
  const entry = { stat: fs.promises.stat(file), operator, at: Date.now() };
  started.set(file, entry);
  // Only its own entry: the operator's may have taken the place of a background one still under way.
  const forget = (): void => {
    if (started.get(file) === entry) started.delete(file);
  };
  entry.stat.then(forget, forget);
  return entry.stat;
}

/**
 * What the operator waits on (GO LIVE, a deck chosen): started at once, never behind the background's queue, and it
 * waits no longer than if it asked alone. It joins only a stat the operator started within the last two seconds: one the
 * background started, or an older one of theirs, may have begun while the share was down, and answer only when the
 * system gives up (21 s on Windows, never on a mount that never answers) for a file that is back. So «Reintentar» or a
 * new GO LIVE starts its own beside that one, a thread more for that file only (review, RN2-1); the background then
 * joins the newest, a background ask still waiting for a thread included. A deck read after a check or a peek that gave
 * up at its second on a disk slow to wake starts one too.
 */
export function operatorStat(file: string): Promise<fs.Stats> {
  const asked = started.get(file);
  return asked?.operator && Date.now() - asked.at <= OPERATOR_JOIN_MS ? asked.stat : start(file, true);
}

/** `ahead`: a deck read ahead, which waits in the row served first. */
export async function backgroundStat(file: string, ahead = false): Promise<fs.Stats> {
  // Joining a stat under way takes no thread.
  const asked = started.get(file);
  if (asked) return asked.stat;
  if (running < IN_FLIGHT) running += 1;
  else await new Promise<void>((resolve) => (ahead ? waitingAhead : waiting).push(resolve));
  try {
    // Asked again: the operator may have started this file while it waited.
    return await (started.get(file)?.stat ?? start(file, false));
  } finally {
    // The slot passes straight to the next one waiting, so a caller arriving in between cannot take a third.
    const next = waitingAhead.shift() ?? waiting.shift();
    if (next) next();
    else running -= 1;
  }
}
