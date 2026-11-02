import fs from "node:fs";
import path from "node:path";
import { ASSET_EXTENSIONS, PREWARM_EXPLICIT_MAX, type AssetKind } from "@shared/constants";
import type { MediaAsset } from "@shared/types/media";
import { getMediaRepo } from "./repos";
import { broadcast } from "./broadcast";
import { prewarmExplicit } from "../slides/deck-service";
import { notifyMediaChanged } from "../media/engine-assets";

const CHUNK_SIZE = 100;
/** Below this, an import resolves fast enough (a handful of `statSync` calls
 *  plus one transaction) that a progress event would never even be seen. */
const PROGRESS_THRESHOLD = 200;
const PROGRESS_MIN_INTERVAL_MS = 250; // ≤4 events/s

/** Serializes every import against every other one. A chunk yields the event
 *  loop between transactions, so two imports running at the same time (e.g.
 *  a drag&drop while a linked folder is being browsed) could otherwise
 *  interleave and race `ux_media_path`'s UNIQUE constraint — a single
 *  process-wide queue removes the race instead of just making it rarer. Two
 *  unrelated imports running back-to-back instead of concurrently is
 *  invisible next to how rarely that actually happens. */
let importChainTail: Promise<unknown> = Promise.resolve();

function withImportLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = importChainTail.then(fn, fn);
  // Swallow so one failed import doesn't wedge the queue for the next one.
  importChainTail = result.catch(() => undefined);
  return result;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Whether a file may become a library row of `kind`. Every way in goes through
 * here: «Add», drag and drop, a linked folder, the legacy import.
 *
 * - **Never a sidecar.** macOS writes an AppleDouble `._522.pps` next to every
 *   file it copies onto a FAT/exFAT stick, and PowerPoint keeps a `~$Himno.pptx`
 *   lock file beside an open deck. Both carry the extension, neither is a
 *   presentation: a hymnal copied from a Mac showed every tile twice, and the
 *   copies were counted, pre-warmed and fed to `soffice` to fail.
 * - **The extension decides, not the caller.** `kind` comes from the renderer
 *   (a picker's filter is a hint that can be typed past), and an `.mp3` filed
 *   as a video only fails later, on the projector.
 */
function importable(filePath: string, kind: AssetKind): boolean {
  const name = path.basename(filePath);
  if (name.startsWith("._") || name.startsWith("~$")) return false;
  const ext = path.extname(name).slice(1).toLowerCase();
  return ASSET_EXTENSIONS[kind].includes(ext);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** A first progress event is only worth showing once the import has actually
 *  run long enough to still be going — a stable linked folder (the common
 *  case: nothing changed since last time) resolves its whole first chunk in
 *  a couple of milliseconds, and a bar that flashes on and off for zero real
 *  work is worse than no bar. */
const PROGRESS_MIN_DELAY_MS = 400;

/**
 * Imports a batch of file paths into the media library without blocking the
 * main process: work is split into `CHUNK_SIZE`-file transactions with an
 * event-loop yield between them, so a linked folder with hundreds of
 * presentations never freezes the control window or the projector mid-service.
 *
 * Deliberately does NOT resolve `.ppt`/`.pps` linked audio — see
 * `MediaRepo.upsertFromPath`/`upsertBatch` — that happens lazily, once, the
 * first time each deck is actually opened.
 *
 * `library-changed` is emitted only when something actually changed
 * (`mutated > 0`) and only when the caller asks for it (`emitChanged`,
 * default `true`). `library:listFolder` passes `false`: it already returns
 * the fresh list to its caller, so broadcasting on top of that would let a
 * `library-changed` subscriber re-trigger the very same `listFolder` — the
 * exact loop that used to make the progress bar flicker forever on a large
 * linked folder. A `list*` read must never cause a `list*` re-read.
 */
export async function importPaths(
  candidates: readonly string[],
  kind: AssetKind,
  opts?: { inLibrary?: boolean; emitChanged?: boolean },
): Promise<MediaAsset[]> {
  const paths = candidates.filter((filePath) => importable(filePath, kind));
  if (paths.length === 0) return [];
  const inLibrary = opts?.inLibrary ?? true;
  const emitChanged = opts?.emitChanged ?? true;

  return withImportLock(async () => {
    const repo = getMediaRepo();
    const results: MediaAsset[] = [];
    const startedAt = Date.now();
    const reportProgress = paths.length > PROGRESS_THRESHOLD;
    let lastProgressAt = 0;
    let done = 0;
    let mutated = 0;

    for (const slice of chunk(paths, CHUNK_SIZE)) {
      // One `stat` per file, but asynchronously and all at once per chunk: on
      // a network share a serial `statSync` run is a few milliseconds EACH,
      // and a chunk of 100 would block the main process (and the projection
      // with it) for seconds. A vanished file just isn't in the result —
      // never a reason to fail the batch.
      const stats = await Promise.all(
        slice.map(async (p) => {
          try {
            return { path: p, stat: await fs.promises.stat(p) };
          } catch {
            return null;
          }
        }),
      );
      const files = stats.filter((entry): entry is { path: string; stat: fs.Stats } => entry !== null);

      const batch = repo.upsertBatch(files, kind, inLibrary);
      results.push(...batch.assets);
      mutated += batch.mutated;
      done += slice.length;

      if (reportProgress) {
        const now = Date.now();
        if (now - startedAt >= PROGRESS_MIN_DELAY_MS && now - lastProgressAt >= PROGRESS_MIN_INTERVAL_MS) {
          lastProgressAt = now;
          broadcast("library-import-progress", { kind, done, total: paths.length, status: "running" });
        }
      }

      await yieldToEventLoop();
    }

    // The "done" event is the authoritative close for the progress bar —
    // sent unconditionally (even for a fast/stable import that never showed
    // a "running" event) so the renderer never has to guess whether one is
    // still owed. `library-changed` stays purely a "something to re-read"
    // signal, decoupled from "this specific import finished".
    if (reportProgress) {
      broadcast("library-import-progress", { kind, done, total: paths.length, status: "done" });
    }

    if (emitChanged && mutated > 0) {
      broadcast("library-changed", { kind });
    }

    // Linked-folder browses too (`emitChanged: false`): every video or audio
    // that enters the app is checked and, if Chromium cannot play it,
    // converted in the background — the operator's call (2026-10-18).
    if (mutated > 0 && (kind === "video" || kind === "audio")) notifyMediaChanged();

    // Explicit adds pre-warm in the background — never a linked-folder
    // browse (`inLibrary: false`), which the renderer's "visible tiles"
    // prewarm already covers for whatever the operator actually scrolls to.
    //
    // Capped: an import is one gesture, and dragging in a whole folder must
    // not turn it into hundreds of unrequested conversions (see
    // `PREWARM_EXPLICIT_MAX`). The rest are reachable from "Prepare
    // folder", which asks first and can be stopped.
    if (kind === "ppt" && inLibrary) {
      prewarmExplicit(results.slice(0, PREWARM_EXPLICIT_MAX).map((asset) => asset.id));
    }

    return results;
  });
}
