import { protocol } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { MediaRepo } from "../db/repositories/media.repo";
import { getSettingsRepo, getSlidesRepo, isDatabaseOpen } from "../services/repos";
import { slidesCacheDir } from "../paths";
import { pdfPageImage, resolveRasterPdf } from "../slides/rasterizer";
import { renderNativeSlide } from "../slides/native-deck";
import { decodeEmbeddedFont } from "../slides/pptx/embedded-font";
import { metafileToSvg } from "../slides/pptx/metafile";
import { readBinaryPart } from "../slides/ppt/parts";
import { containerKind } from "../slides/pptx-metadata";
import { readZipEntries } from "../slides/zip-reader";
import { ensureThumbnail } from "../media/thumbnail-service";

/** Must run before app.whenReady(). `standard: true` gives worship:// URLs a
 *  hostname + pathname like http, which is what the parsing below relies on. */
export function registerWorshipScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "worship",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: false,
      },
    },
  ]);
}

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
async function serveFile(
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

/** The file a deck clip url names (`?f=`, see `deckVideoUrl`), next to the row's
 *  current one: the file the url was built for, even after the row was pointed
 *  at another one (`media/deck-clips.ts`). A name that is not
 *  bare, or not there, falls back to the row's — and `withinCache` still has
 *  the last word on what leaves the process. */
function clipFile(current: string | null, url: URL): string | null {
  const named = url.searchParams.get("f");
  if (!current || !named || path.basename(named) !== named) return current;
  const candidate = path.join(path.dirname(current), named);
  return fs.existsSync(candidate) ? candidate : current;
}

/** Defence in depth: these paths are already capability-derived (a DB row, not
 *  user input), so traversal isn't reachable — this asserts and documents that
 *  invariant at the point where bytes actually leave the process. */
function withinCache(filePath: string | null): string | null {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  return resolved.startsWith(slidesCacheDir + path.sep) ? resolved : null;
}

/**
 * Serves local files by CAPABILITY (a DB id or a job id), never by raw
 * filesystem path — the URL can never path-traverse, and relocating a file in
 * the library keeps the exact same `worship://asset/<id>` URL, so React never
 * needs to remount a player because a path changed. `stream: true` on the
 * scheme plus `serveFile`'s own Range handling is what lets `<video>` and
 * `<audio>` seek.
 */
export function registerWorshipProtocolHandler(mediaRepo: MediaRepo): void {
  protocol.handle("worship", async (request) => {
    const url = new URL(request.url);
    const resource = url.hostname; // worship://asset/42 -> hostname "asset"
    const segments = url.pathname.split("/").filter(Boolean); // "/42" -> ["42"]

    try {
      switch (resource) {
        case "asset": {
          const id = Number(segments[0]);
          if (!Number.isFinite(id)) return new Response("Not found", { status: 404 });

          // worship://asset/<id>/thumb?v=<size>-<mtime> — a small cached
          // preview, generated on demand. No IPC channel precedes it: with a
          // virtualized grid, an <img> asking for the bytes IS the signal
          // that this tile is on screen right now.
          if (segments[1] === "thumb") {
            const asset = mediaRepo.getById(id);
            // The signal is what retires a queued generation whose tile has
            // scrolled away: Chromium aborts the <img> request when the
            // virtualized grid unmounts it, and there is no point stalling the
            // main thread to decode something nobody can see any more.
            const thumbPath = asset ? await ensureThumbnail(asset, request.signal) : null;
            // 404 rather than a placeholder image: the renderer owns the
            // fallback, so it can paint it with its own theme tokens instead
            // of us baking a colour into a JPEG. Explicitly uncached, so an
            // asset that gains a thumbnail later isn't pinned to this answer.
            if (!thumbPath) {
              return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
            }
            // Safe to serve immutably: `?v=` carries the file's size+mtime, so
            // editing the source yields a different URL. Omitting that buster
            // is impossible by construction — `assetThumbUrl` requires it.
            return serveFile(request, thumbPath, {
              "Cache-Control": "public, max-age=31536000, immutable",
            });
          }

          return serveFile(request, mediaRepo.getPathById(id));
        }
        case "logo": {
          return serveFile(request, getSettingsRepo().get("logo.path"));
        }
        case "deck": {
          // worship://deck/<deckId>/part/<part> and …/font/<part>: a picture
          // or an embedded font of a deck drawn from its model, read from the
          // source package itself.
          if (segments[1] === "part" || segments[1] === "font") {
            return serveDeckPart(request, Number(segments[0]), segments[1], decodeURIComponent(segments.slice(2).join("/")));
          }
          // worship://deck/<deckId>/<slideIndex>/model — a slide's `SlideModel`.
          if (segments[2] === "model") {
            const model = getSlidesRepo().getSlideModel(Number(segments[0]), Number(segments[1]));
            if (!model || !(await sourceUnchanged(model))) return new Response("Gone", { status: 410 });
            return new Response(request.method === "HEAD" ? null : model.json, {
              status: 200,
              headers: { "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "application/json" },
            });
          }
          // worship://deck/<deckId>/<slideIndex>[/thumb]
          const deckId = Number(segments[0]);
          const slideIndex = Number(segments[1]);
          if (!Number.isFinite(deckId) || !Number.isFinite(slideIndex)) {
            return new Response("Not found", { status: 404 });
          }
          const variant = segments[2] === "thumb" ? "thumb" : "full";
          const image = getSlidesRepo().getSlideImage(deckId, slideIndex, variant);
          // A (deckId, slideIndex) pair is immutable by construction: changing
          // the source file yields a different content hash and therefore a
          // different deck id. Without this header Chromium re-reads every
          // image on each <img> swap — during a live service.
          const immutable = { "Cache-Control": "public, max-age=31536000, immutable" };
          if (!image) return new Response("Not found", { status: 404 });
          // Built from the source itself, so it has to still BE the file the
          // deck was read from: a deck edited in place would hand out bytes
          // from the wrong offsets, or another page. Gone, not a guess — the
          // deck is read again the next time it is opened.
          if (!(await sourceUnchanged(image))) return new Response("Gone", { status: 410 });
          let slide: { body: Buffer; contentType: string } | null;
          if (image.kind === "pdf") {
            const body = await pdfPageImage(image, image.page, image.variant).catch((error: unknown) => {
              console.warn(`[slides] couldn't draw page ${image.page} of ${image.sourcePath}`, error);
              return null;
            });
            slide = body ? { body, contentType: `image/${image.imageFormat}` } : null;
          } else {
            slide = renderNativeSlide(image.sourcePath, image.layers, image.variant);
          }
          if (!slide) return new Response("Gone", { status: 410 });
          return new Response(request.method === "HEAD" ? null : new Uint8Array(slide.body), {
            status: 200,
            headers: {
              ...immutable,
              "Content-Type": slide.contentType,
              "Content-Length": String(slide.body.length),
            },
          });
        }
        case "deck-audio": {
          const audioId = Number(segments[0]);
          if (!Number.isFinite(audioId)) return new Response("Not found", { status: 404 });
          // No immutable header: a soundtrack is seeked through, not swapped.
          return serveFile(request, withinCache(clipFile(getSlidesRepo().getAudioPath(audioId), url)));
        }
        case "deck-video": {
          // worship://deck-video/<id> — a clip pulled out of a .pptx, living
          // in the same cache as the deck's own audio. `serveFile` honours
          // Range, which is not optional for a `<video>`: without it the
          // element gets an empty `seekable` range and playback dies with
          // `PIPELINE_ERROR_DECODE`.
          const videoId = Number(segments[0]);
          if (!Number.isFinite(videoId)) return new Response("Not found", { status: 404 });
          return serveFile(request, withinCache(clipFile(getSlidesRepo().getVideoPath(videoId), url)));
        }
        case "linked-audio": {
          // worship://linked-audio/<mediaAssetId> — an external file the
          // source .pps/.pptx points at (or sits next to), resolved per media
          // asset (`linked-audio.ts`), not part of the content-addressed
          // slides cache. Same trust model as "asset": the id is DB-derived,
          // never a path from the URL, so no `withinCache` restriction to an
          // arbitrary library location.
          const assetId = Number(segments[0]);
          if (!Number.isFinite(assetId)) return new Response("Not found", { status: 404 });
          return serveFile(request, mediaRepo.linkedAudioPathById(assetId));
        }
        case "raster": {
          // Short-lived capability handed to the offscreen rasterizer window so
          // it can read the in-flight PDF without any filesystem access.
          const jobId = segments[0];
          const pdfPath = jobId ? resolveRasterPdf(jobId) : null;
          if (!pdfPath) return new Response("Not found", { status: 404 });
          // The only PDF rasterized is a deck's own source, straight from
          // wherever the operator keeps it: a library row (a PDF being opened,
          // no deck yet) or a deck row (every deck was read from a library
          // file) is the positive assertion. Both, because two copies of one
          // PDF share one deck whose source is the copy opened last: taking
          // THAT copy out of the library left the other — on air — blank.
          const resolved = path.resolve(pdfPath);
          if (!mediaRepo.hasPath(resolved) && !getSlidesRepo().isDeckSource(pdfPath)) {
            return new Response("Forbidden", { status: 403 });
          }
          return serveFile(request, resolved);
        }
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      // A request still in flight when the app quit: not a bug, and not worth
      // a line in the main.log the operator sends when something IS wrong.
      if (!isDatabaseOpen()) return new Response("Shutting down", { status: 503 });
      // A mute 500 is indistinguishable from a black slide. Everything reaching
      // here is a bug (a repo throwing, a thumbnail that failed to generate),
      // so it has to leave a trace even though the renderer only sees a status.
      console.error(`[worship] handler failed: ${request.url}`, error);
      return new Response("Internal error", { status: 500 });
    }
  });
}

/** A deck read from its source hands out bytes from that file: it has to still
 *  BE the file it was read from, or a deck edited in place would serve parts
 *  from the wrong offsets. Gone, not a guess — it is read again on next use. */
async function sourceUnchanged(source: { sourcePath: string; sourceSizeBytes: number; sourceMtimeMs: number }): Promise<boolean> {
  const stat = await fs.promises.stat(source.sourcePath).catch(() => null);
  return !!stat && stat.size === source.sourceSizeBytes && Math.trunc(stat.mtimeMs) === source.sourceMtimeMs;
}

const PART_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", gif: "image/gif", bmp: "image/bmp",
  svg: "image/svg+xml", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", ico: "image/x-icon",
};

/**
 * A part of a model deck's package: a picture as is, a metafile (EMF/WMF,
 * which Chromium can't decode) as the SVG `metafileToSvg` makes of it, a font
 * as the TrueType `decodeEmbeddedFont` rebuilds. Immutable like everything
 * under a deck id.
 */
async function serveDeckPart(request: Request, deckId: number, kind: "part" | "font", part: string): Promise<Response> {
  const source = Number.isFinite(deckId) ? getSlidesRepo().getDeckSource(deckId) : null;
  if (!source || !(await sourceUnchanged(source))) return new Response("Gone", { status: 410 });
  // A legacy binary's parts are ranges of its OLE streams (`ppt/parts.ts`);
  // a `.pptx`'s and an `.odp`'s, zip entries.
  const raw =
    containerKind(source.sourcePath) === "binary"
      ? (readBinaryPart(source.sourcePath, part) ?? undefined)
      : readZipEntries(source.sourcePath, (name) => name === part)[part];
  if (!raw) return new Response("Not found", { status: 404 });
  const ext = part.slice(part.lastIndexOf(".") + 1).toLowerCase();
  let body: Uint8Array | string | null = raw;
  let type = PART_TYPES[ext] ?? "application/octet-stream";
  if (kind === "font") {
    body = decodeEmbeddedFont(raw);
    type = "font/ttf";
  } else if (ext === "emf" || ext === "wmf" || ext === "emz" || ext === "wmz") {
    body = metafileToSvg(raw, ext.startsWith("w") ? "wmf" : "emf");
    type = "image/svg+xml";
  }
  if (body === null) return new Response("Unreadable", { status: 415 });
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), {
    status: 200,
    headers: { "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": type, "Content-Length": String(bytes.length) },
  });
}
