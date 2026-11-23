import {
  SLIDES_CLIP_COPY_TIMEOUT_MS,
  SLIDES_DECK_READ_TIMEOUT_MS,
  SLIDES_PART_READ_TIMEOUT_MS,
} from "@shared/constants";
import { ooxmlDir } from "../paths";
import { createDeckQueue, TOO_SLOW } from "./deck-queue";
import type { RasterLane } from "./rasterizer";
import createPptxWorker from "./pptx-worker?nodeWorker";
import type { DeckPart, NativeRead, PptxClips, PptxExtract, PptxRead, PptxReply, PptxRequest } from "./pptx-worker";
import type { ContainerKind } from "./pptx-metadata";
import type { UnreadableDeckReason } from "./ppt-binary";

export type { DeckPart, NativeRead, PptxRead } from "./pptx-worker";

function spawn(): ReturnType<typeof createPptxWorker> {
  const started = createPptxWorker({ workerData: { ooxmlDir } });
  // Never what keeps the process alive: quitting doesn't wait for a read.
  started.unref();
  return started;
}

/**
 * Reads a deck into its model in `pptx-worker.ts`, one deck after another on
 * one worker thread, started with the first deck. `null` when the file can't be
 * read as a presentation at all, or when the worker died on it: that deck
 * fails as unreadable, and is never retried here on main, where the same file
 * would take the whole app down instead of one thread. `TOO_SLOW` when the
 * queue's clock stopped it.
 */
const queue = createDeckQueue<PptxRequest, PptxReply>(spawn, SLIDES_DECK_READ_TIMEOUT_MS);

/**
 * The hymnal's own thread and queue, of the same module: what a file is, a legacy deck read as pictures and why a
 * deck won't open, each a millisecond or two. In `queue` a hymn waited behind a heavy `.pptx` (5 to 11 s); on main,
 * 32 of them were one turn of the thread every engine frame crosses, and a share that stopped answering held it
 * whole (2026-11-22 audit, RM1). A file that kills this thread is never read on main either.
 */
const hymnal = createDeckQueue<PptxRequest, PptxReply>(spawn, SLIDES_DECK_READ_TIMEOUT_MS);

/**
 * A model deck's pictures, metafiles and fonts, on a third thread with a short clock of its own: a slide on air asks
 * for its parts and waits on them, so they never queue behind a `.pptx` read (5 to 11 s) nor a hymn's file on a
 * share that stopped answering (the hymnal's 60 s). Converted on main, an EMF of 156 bytes froze it a minute and
 * then took the app down (2026-11-22 audit, SE1).
 */
const parts = createDeckQueue<PptxRequest, PptxReply>(spawn, SLIDES_PART_READ_TIMEOUT_MS);
let nextId = 0;

export async function readPptx(sourcePath: string, lane: RasterLane): Promise<PptxRead | null | typeof TOO_SLOW> {
  const reply = await queue.ask(sourcePath, { id: ++nextId, file: sourcePath }, lane);
  if (reply === TOO_SLOW) return reply;
  return reply && "read" in reply ? reply.read : null;
}

/** The deck's embedded sound and video, copied into its cache on the worker thread. None when the
 *  worker could not copy them (the deck then goes without them, as with a part that won't read);
 *  `null` when the worker stopped before answering, which says nothing about the file; `TOO_SLOW` when its clock did. */
export async function extractClips(extract: PptxExtract, lane: RasterLane): Promise<PptxClips | null | typeof TOO_SLOW> {
  // Its own window, a beat per clip: gigabytes of video off a pen drive take minutes, and a share that went away
  // mid-copy held the worker for good when the copy was not timed at all (review of the 2026-11-15 audit, S4).
  const reply = await queue.ask(extract.file, { id: ++nextId, extract }, lane, SLIDES_CLIP_COPY_TIMEOUT_MS);
  if (reply === null || reply === TOO_SLOW) return reply;
  return "clips" in reply ? reply.clips : { audio: [], video: [] };
}

/** What `sourcePath` is by its bytes and, when `native` and it is a legacy binary, its read as pictures. `null`
 *  when the thread stopped on the file, `TOO_SLOW` when its clock did. */
export async function sniffDeck(
  sourcePath: string,
  native: boolean,
  lane: RasterLane,
): Promise<{ kind: ContainerKind; native: NativeRead | undefined } | null | typeof TOO_SLOW> {
  const reply = await hymnal.ask(sourcePath, { id: ++nextId, sniff: sourcePath, native }, lane);
  if (reply === null || reply === TOO_SLOW) return reply;
  return "kind" in reply ? reply : null;
}

/** Why no reader opens `sourcePath` (`sniffUnreadableDeck`); a thread that stopped on it says it is not a presentation. */
export async function unreadableReason(sourcePath: string): Promise<UnreadableDeckReason> {
  const reply = await hymnal.ask(sourcePath, { id: ++nextId, unreadable: sourcePath }, "now");
  return reply !== null && reply !== TOO_SLOW && "reason" in reply ? reply.reason : "NOT_A_PRESENTATION";
}

/** A part of a model deck's package, read and converted on `parts`' thread (`readDeckPart`), never on main. A part
 *  whose thread died on it won't convert: 415. One that ran out of the clock says nothing about the file (a pen drive
 *  or a share slow for a moment, as `TOO_SLOW` says for a deck): 404, which is never kept, so the next ask reads it
 *  again. */
export async function readDeckPart(sourcePath: string, kind: "part" | "font", part: string): Promise<DeckPart> {
  const reply = await parts.ask(sourcePath, { id: ++nextId, deckPart: { file: sourcePath, kind, part } }, "now");
  if (reply === TOO_SLOW) return 404;
  if (reply !== null && "error" in reply) throw new Error(reply.error);
  return reply !== null && "deckPart" in reply ? reply.deckPart : 415;
}

/** The operator opened a deck that was being read ahead: what is still queued for it goes first. */
export function hurryDeck(sourcePath: string): void {
  hymnal.hurry(sourcePath);
  queue.hurry(sourcePath);
}
