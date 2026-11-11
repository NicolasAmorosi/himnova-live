import { protocol } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { MediaRepo } from "../db/repositories/media.repo";
import { getSettingsRepo, getSlidesRepo, isDatabaseOpen } from "../services/repos";
import { liveDeckDir, slidesCacheDir } from "../paths";
import { pdfPageImage, resolveRasterPdf } from "../slides/rasterizer";
import { renderNativeSlide } from "../slides/native-deck";
import { decodeEmbeddedFont } from "../slides/pptx/embedded-font";
import { metafileToSvg } from "../slides/pptx/metafile";
import { readBinaryPart } from "../slides/ppt/parts";
import { containerKind } from "../slides/pptx-metadata";
import { readZipEntries } from "../slides/zip-reader";
import { ensureThumbnail } from "../media/thumbnail-service";
import { serveFile } from "./serve-file";

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
  // The copies of a previous run's deck on air.
  void fs.promises.rm(liveDeckDir, { recursive: true, force: true }).catch(() => {});
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
            if (!model || !(await readableSource(model))) return new Response("Gone", { status: 410 });
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
          const sourcePath = await readableSource(image);
          if (!sourcePath) return new Response("Gone", { status: 410 });
          let slide: { body: Buffer; contentType: string } | null;
          if (image.kind === "pdf") {
            const body = await pdfPageImage({ ...image, sourcePath }, image.page, image.variant).catch((error: unknown) => {
              console.warn(`[slides] couldn't draw page ${image.page} of ${sourcePath}`, error);
              return null;
            });
            slide = body ? { body, contentType: `image/${image.imageFormat}` } : null;
          } else {
            slide = renderNativeSlide(sourcePath, image.layers, image.variant);
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
type DeckSource = { sourcePath: string; sourceSizeBytes: number; sourceMtimeMs: number };

async function sourceUnchanged(source: DeckSource): Promise<boolean> {
  const stat = await fs.promises.stat(source.sourcePath).catch(() => null);
  return !!stat && stat.size === source.sourceSizeBytes && Math.trunc(stat.mtimeMs) === source.sourceMtimeMs;
}

/**
 * The deck on air goes on if its file goes — a USB stick pulled out, a network folder down, a synced
 * folder that moves it. Every slide of a native deck (the hymnal), every page of a PDF and every
 * picture of a model deck is read from the source when asked for, so the next slide came back 410
 * and the projector went black with the hymn still singing (2026-11-10 review, agent5-02). A copy is
 * taken in the profile as the deck goes live (`keepLiveDeckSource`, from `projection:show`), in the
 * background, and read only once the original is gone or changed. One deck at a time.
 */
let liveCopy: { deckId: number; path: string; source: DeckSource } | null = null;
let copyingDeckId: number | null = null;

/** Where to read the deck's bytes from: its own file while it is still the one read, else the copy
 *  of it taken when it went live, else nowhere (410). */
async function readableSource(source: DeckSource): Promise<string | null> {
  if (await sourceUnchanged(source)) return source.sourcePath;
  const copy = liveCopy;
  const same =
    copy !== null &&
    copy.source.sourcePath === source.sourcePath &&
    copy.source.sourceSizeBytes === source.sourceSizeBytes &&
    copy.source.sourceMtimeMs === source.sourceMtimeMs;
  return same ? copy.path : null;
}

/** The deck `deckId` is on air: copies its source aside unless it already is. Never blocks main. */
export function keepLiveDeckSource(deckId: number): void {
  if (liveCopy?.deckId === deckId || copyingDeckId === deckId) return;
  const row = getSlidesRepo().getDeckById(deckId);
  if (!row) return;
  const source: DeckSource = { sourcePath: row.sourcePath, sourceSizeBytes: row.sourceSizeBytes, sourceMtimeMs: row.sourceMtimeMs };
  copyingDeckId = deckId;
  const dest = path.join(liveDeckDir, `${deckId}${path.extname(source.sourcePath)}`);
  void (async () => {
    try {
      await fs.promises.mkdir(liveDeckDir, { recursive: true });
      if (!(await sourceUnchanged(source))) return;
      await fs.promises.copyFile(source.sourcePath, dest);
      if ((await fs.promises.stat(dest)).size !== source.sourceSizeBytes || copyingDeckId !== deckId) {
        await fs.promises.rm(dest, { force: true });
        return;
      }
      const previous = liveCopy;
      liveCopy = { deckId, path: dest, source };
      if (previous && previous.path !== dest) await fs.promises.rm(previous.path, { force: true });
    } catch (error) {
      console.warn(`[slides] could not keep a copy of the deck on air (${source.sourcePath})`, error);
    } finally {
      if (copyingDeckId === deckId) copyingDeckId = null;
    }
  })();
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
  const sourcePath = source && (await readableSource(source));
  if (!sourcePath) return new Response("Gone", { status: 410 });
  // A legacy binary's parts are ranges of its OLE streams (`ppt/parts.ts`);
  // a `.pptx`'s and an `.odp`'s, zip entries.
  const raw =
    containerKind(sourcePath) === "binary"
      ? (readBinaryPart(sourcePath, part) ?? undefined)
      : readZipEntries(sourcePath, (name) => name === part)[part];
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
