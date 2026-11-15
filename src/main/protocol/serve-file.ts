import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

/* How `worship://` (`worship-protocol.ts`) answers with a local file, Range included. Nothing here imports
 * `electron`, so the contract is tested in `tests/main/serve-file.test.ts`. */

/** Explicit, because responses are now built by hand rather than by `net.fetch`
 *  (which sniffed the type but could not honour Range — see `serveFile`). A
 *  wrong/missing video MIME makes Chromium refuse the stream outright. */
const MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  webm: "video/webm",
  "3gp": "video/3gpp",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  weba: "audio/webm",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/** Undefined for an unrecognized extension, in which case the header is left
 *  off entirely and Chromium sniffs — asserting `application/octet-stream`
 *  would make it refuse to play an otherwise fine media file. Every extension
 *  Chromium can open is covered above; the rest of `ASSET_EXTENSIONS` (WMV,
 *  MPG, WMA…) only ever reaches a player as its converted `.mp4`/`.m4a`. */
function contentTypeFor(filePath: string): string | undefined {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_TYPES[ext];
}

/** `bytes=start-end`, `bytes=start-` and the suffix form `bytes=-lastN`.
 *  Returns null for an absent/unparseable header (serve the whole file) and
 *  "unsatisfiable" for a syntactically valid range outside the file. */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  // Suffix form: the last N bytes.
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * A file descriptor must never outlive its request.
 *
 * Chromium normally cancels the web stream when it is done (a seek abandons the
 * previous range mid-read, and `<video>` issues a lot of those), and cancelling
 * it destroys the Node stream underneath. But that is the *only* thing that was
 * closing these descriptors: nothing was tied to `request.signal`, so a request
 * aborted before the body was consumed left the handle open, and a read error —
 * the USB drive holding a video unplugged mid-service, the exact scenario the
 * media-error notice exists for — was swallowed with no record anywhere.
 */
/** A read the consumer walked away from, not a read that failed. `AbortError`
 *  is what `Readable.toWeb`'s cancel path destroys the stream with;
 *  `ERR_STREAM_PREMATURE_CLOSE` is the same event seen from the other end. */
function isExpectedCancellation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return (
    name === "AbortError" || code === "ABORT_ERR" || code === "ERR_STREAM_PREMATURE_CLOSE"
  );
}

/** Node's default is 64 KiB. A 4K video at 50–100 Mbps is 6–12 MB a second
 *  per element, and the projector and the LIVE monitor each read their own
 *  copy — at 64 KiB that is hundreds of chunks a second crossing from this
 *  process into the renderer's media pipeline, each one a turn of main's
 *  event loop. `Readable.toWeb` sizes its own queue from this value, so it is
 *  the one knob for both. Small files are unaffected as long as the read is
 *  bounded — `fs` never allocates past a range's `end` (see `serveFile`). */
const READ_CHUNK_BYTES = 1024 * 1024;

function streamFile(
  filePath: string,
  signal: AbortSignal | undefined,
  range?: { start: number; end: number },
): ReadableStream {
  const stream = range
    ? fs.createReadStream(filePath, { start: range.start, end: range.end, highWaterMark: READ_CHUNK_BYTES })
    : fs.createReadStream(filePath, { highWaterMark: READ_CHUNK_BYTES });

  // `Readable.toWeb` forwards the error to the web stream, which is what makes
  // the element fire `onerror` — but it writes nothing anywhere, and the log is
  // the only record left once the on-screen notice expires.
  //
  // Everything EXCEPT a cancellation, which is not a failure: cancelling the
  // web stream destroys the Node stream with an `AbortError`, and Chromium
  // cancels constantly — every seek in a video abandons the range it was
  // reading, and so does every scene change. Logging those buried the real
  // read errors (an unplugged drive mid-service) in noise that looked exactly
  // like them.
  stream.on("error", (error) => {
    if (isExpectedCancellation(error)) return;
    console.error(`[worship] read failed: ${filePath}`, error);
  });

  if (signal) {
    if (signal.aborted) stream.destroy();
    else {
      const onAbort = (): void => {
        stream.destroy();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // Symmetric teardown: without this, a long-lived request's signal keeps
      // the closure (and the stream with it) reachable after the file is done.
      stream.once("close", () => signal.removeEventListener("abort", onAbort));
    }
  }

  return Readable.toWeb(stream) as ReadableStream;
}

/**
 * Serves a local file with real HTTP range semantics.
 *
 * This used to delegate to `net.fetch(file://…)`, which silently ignored the
 * request's `Range` header and always answered 200 with the whole file. That is
 * what made `<video>`/`<audio>` report an EMPTY `seekable` range (so the
 * progress bar could never work), and — far worse — it made Chromium's media
 * pipeline read misaligned bytes whenever it re-requested at an offset (after
 * the element was recreated, or once its media cache held only part of a large
 * file). The decoder then got data that did not belong at the offset it asked
 * for and died with `kVTVideoDecoderBadDataErr` (-12909) — the video played for
 * about a second and froze for good, reliably by the third play of a large file.
 */
export async function serveFile(
  request: Request,
  filePath: string | null,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  if (!filePath) return new Response("Not found", { status: 404 });

  let size: number;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return new Response("Gone", { status: 410 });
    size = stat.size;
  } catch {
    return new Response("Gone", { status: 410 });
  }

  const headers = new Headers({
    // Without this Chromium never even attempts a range request, and treats
    // the stream as unseekable.
    "Accept-Ranges": "bytes",
    ...extraHeaders,
  });
  const contentType = contentTypeFor(filePath);
  if (contentType) headers.set("Content-Type", contentType);

  const range = parseRange(request.headers.get("Range"), size);

  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const wantsBody = request.method !== "HEAD";

  if (range) {
    const length = range.end - range.start + 1;
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(length));
    return new Response(wantsBody ? streamFile(filePath, request.signal, range) : null, {
      status: 206,
      headers,
    });
  }

  headers.set("Content-Length", String(size));
  // Bounded even when the whole file was asked for: an open-ended read
  // allocates a full `READ_CHUNK_BYTES` buffer per turn, which for a 40 KB
  // slide thumbnail is 1 MB of garbage per request.
  const whole = size > 0 ? { start: 0, end: size - 1 } : undefined;
  return new Response(wantsBody ? streamFile(filePath, request.signal, whole) : null, {
    status: 200,
    headers,
  });
}
