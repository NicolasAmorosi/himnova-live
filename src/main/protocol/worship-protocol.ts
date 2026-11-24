import { protocol } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { MediaRepo } from "../db/repositories/media.repo";
import { getSettingsRepo, getSlidesRepo, isDatabaseOpen } from "../services/repos";
import { liveDeckDir, pdfjsWasmDir, slidesCacheDir } from "../paths";
import { pdfPageImage, resolveRasterPdf } from "../slides/rasterizer";
import { renderNativeSlide } from "../slides/native-deck";
import { readDeckPart, type DeckPart } from "../slides/pptx-deck";
import { ensureThumbnail } from "../media/thumbnail-service";
import { byteLru } from "./byte-lru";
import { serveFile } from "./serve-file";
import { renameWithRetry } from "../fs-retry";

/** What `worship://wasm/` serves: the decoders `pdfjs.getDocument` fetches from its `wasmUrl`. */
const PDFJS_WASM = new Set(["openjpeg.wasm", "jbig2.wasm", "qcms_bg.wasm"]);

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
            const asset = mediaRepo.getById(mediaRepo.survivingId(id));
            // The signal would retire a queued generation whose tile has
            // scrolled away, but Electron never aborts it (measured on 44 and
            // 45): `ThumbSlots` serves the newest ask first instead.
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

          return serveFile(request, mediaRepo.getPathById(mediaRepo.survivingId(id)));
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
          const music = mediaRepo.linkedAudioPathById(mediaRepo.survivingId(assetId));
          return serveFile(request, music && (await liveMusicFile(music)));
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
          // THAT copy out of the library left the other — on air — blank. And the copy of the deck on air
          // (`liveCopy`), which is what a page is drawn from once its pendrive is pulled: refused here, the projector
          // froze on the last page drawn ahead (2026-11-15 audit, A6).
          const resolved = path.resolve(pdfPath);
          const isLiveCopy = liveCopy !== null && path.resolve(liveCopy.path) === resolved;
          if (!isLiveCopy && !mediaRepo.hasPath(resolved) && !getSlidesRepo().isDeckSource(pdfPath)) {
            return new Response("Forbidden", { status: 403 });
          }
          return serveFile(request, resolved);
        }
        case "wasm": {
          // pdf.js's decoders, for the rasterizer (its CSP connects to `worship:` only): by name, from a fixed list.
          const name = segments[0] ?? "";
          if (!PDFJS_WASM.has(name)) return new Response("Not found", { status: 404 });
          return serveFile(request, path.join(pdfjsWasmDir, name));
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

const sameStamp = (a: DeckSource, b: DeckSource): boolean =>
  a.sourcePath === b.sourcePath && a.sourceSizeBytes === b.sourceSizeBytes && a.sourceMtimeMs === b.sourceMtimeMs;

/**
 * The deck on air goes on if its file goes: a USB stick pulled out, a network folder down, a synced
 * folder that moves it. Every slide of a native deck (the hymnal), every page of a PDF and every
 * picture of a model deck is read from the source when asked for, so the next slide came back 410
 * and the projector went black with the hymn still singing (2026-11-10 review, agent5-02). A copy is
 * taken in the profile as the deck goes live (`keepLiveDeckSource`, from `projection:show`), in the
 * background, and read first once it has landed: its file is not looked at again, so a network folder that stopped
 * answering no longer holds each slide until the system gives up (2026-11-22 audit, RM3). One deck at a time.
 */
type LiveCopy = { deckId: number; path: string; source: DeckSource; music: { path: string; source: DeckSource } | null };
let liveCopy: LiveCopy | null = null;
let copyingDeckId: number | null = null;
/** The kept deck whose music is being copied: one copy at a time. */
let keepingMusicOf: LiveCopy | null = null;
/** The deck asked for last: the one on air. A copy that lands for another one is dropped. */
let wantedDeckId: number | null = null;
let liveCopySeq = 0;
/** The epoch of the last playback of a deck's music (`liveMusicPlays`), and the look at its file that settles where
 *  that playback reads from: its bytes wait for it. */
let musicEpoch: number | null = null;
let musicLook: Promise<void> = Promise.resolve();
/** How long a playback's bytes wait for that look: a share that stopped answering held the `stat` 21 s on Windows,
 *  and for good on a `hard` NFS mount. Past it the playback reads the copy it has, as GO LIVE of a video waits for its
 *  file (2026-11-22 audit, RV-3). */
const MUSIC_LOOK_MS = 1000;

/** Where to read the deck's bytes from: the copy taken when it went live, when it is a copy of the file the deck was
 *  read from (by the stamp the deck was read with, without asking the file); else its own file while it is still the
 *  one read; else nowhere (410). A copy still being written is not `liveCopy`: it is kept once renamed into place. */
async function readableSource(source: DeckSource): Promise<string | null> {
  const copy = liveCopy;
  if (copy !== null && sameStamp(copy.source, source)) return copy.path;
  return (await sourceUnchanged(source)) ? source.sourcePath : null;
}

/** A hymn's music file (`linked-audio.ts`) taken aside with its deck goes up to this size. Real ones are an MP3 or
 *  a WMA of 2 to 10 MB, and 200 MB is still an hour of MP3 at 320 kbps or 20 minutes of WAV; a bigger file is not a
 *  hymn's music, and copying it off a pen drive would hold the drive for a minute while the room reads from it. */
const LIVE_MUSIC_MAX_BYTES = 200 * 1024 * 1024;

/** Where to read the music of a deck on air from (`worship://linked-audio`, and the engine for a `.wma`): the copy
 *  taken with the deck, first, as its slides; the file itself while there is none. A hymn whose pen drive was pulled
 *  went silent as soon as the player asked for more bytes, or at once when anything mounted it again (2026-11-22
 *  audit, RV-4). The copy changes only as a playback begins (`liveMusicPlays`), so the `Range` reads of one playback
 *  never get bytes of two files: an MP3 replaced mid-hymn played on in its new bytes at the old one's offsets (review
 *  of the night 2, RN2-6), and plays new from the next playback of the hymn. */
export async function liveMusicFile(file: string): Promise<string> {
  if (liveCopy?.music?.source.sourcePath === file) await musicLook;
  const music = liveCopy?.music;
  return music && music.source.sourcePath === file ? music.path : file;
}

/** The deck music `file` plays under the epoch of its track (`projection:setAudioTracks`), or none does (`null`).
 *  Another epoch is another playback: the hymn sent live again (`goLiveWithDeck`). If it is the kept deck's and the
 *  file changed since its copy, that playback reads the file itself until a copy of it as it is now lands; unreadable
 *  (its pen drive pulled), it reads the copy it has. A push of the same epoch (a slide, a volume, BLACK, a restart or a
 *  seek, a reopened projector) is the same playback. */
export function liveMusicPlays(file: string | null, epoch: number | null): void {
  if (epoch === musicEpoch) return;
  musicEpoch = epoch;
  const kept = liveCopy;
  if (file === null || kept?.music?.source.sourcePath !== file) return;
  // A look past its time is dropped whatever it finds: this playback is reading the copy by then, and the file
  // changed would send its next `Range` reads to another file. The next playback looks again.
  const look = { late: false };
  let timer: NodeJS.Timeout | undefined;
  musicLook = Promise.race([
    keepLiveMusic(kept, file, look),
    new Promise<void>((resolve) => (timer = setTimeout(() => ((look.late = true), resolve()), MUSIC_LOOK_MS))),
  ]).finally(() => clearTimeout(timer));
}

/** Copies the music of the kept deck `kept` aside, unless the copy it has is of this file as it is now. Resolves once
 *  where its playback reads from is settled; the copy runs on. Unreadable, the copy it has stays: it is what the room
 *  hears now. Changed, the file itself is read until the new copy lands (none past the size cap). */
async function keepLiveMusic(kept: LiveCopy, musicPath: string, look: { late: boolean }): Promise<void> {
  const stat = await fs.promises.stat(musicPath).catch(() => null);
  if (look.late || !stat || liveCopy !== kept || keepingMusicOf === kept) return;
  const music = { sourcePath: musicPath, sourceSizeBytes: stat.size, sourceMtimeMs: Math.trunc(stat.mtimeMs) };
  const old = kept.music;
  if (old && sameStamp(old.source, music)) return;
  kept.music = null;
  if (stat.size > LIVE_MUSIC_MAX_BYTES) return;
  keepingMusicOf = kept;
  void (async () => {
    const musicDest = `${kept.path}.music${path.extname(musicPath)}`;
    const musicPartial = `${musicDest}.${++liveCopySeq}.partial`;
    try {
      await fs.promises.copyFile(musicPath, musicPartial);
      if ((await fs.promises.stat(musicPartial)).size !== stat.size || liveCopy !== kept) {
        await fs.promises.rm(musicPartial, { force: true });
        return;
      }
      await renameWithRetry(musicPartial, musicDest);
      // Kept again meanwhile (D, E, D), the copy under way for it lands in this same place.
      if (liveCopy === kept) {
        kept.music = { path: musicDest, source: music };
        if (old && old.path !== musicDest) await fs.promises.rm(old.path, { force: true });
      } else if (liveCopy?.deckId !== kept.deckId) await fs.promises.rm(musicDest, { force: true });
    } catch (error) {
      await fs.promises.rm(musicPartial, { force: true }).catch(() => undefined);
      console.warn(`[slides] could not keep a copy of the music on air (${musicPath})`, error);
    } finally {
      if (keepingMusicOf === kept) keepingMusicOf = null;
    }
  })();
}

/** The deck `deckId` is on air, `musicPath` its linked music if it has one: copies them aside unless they already
 *  are. Never blocks main. A deck shown again (every slide is a show) leaves its music copy as it is: a playback reads
 *  one file from start to end (`liveMusicPlays`). */
export function keepLiveDeckSource(deckId: number, musicPath: string | null = null): void {
  // Asked even when it returns here: back to the deck already kept, a copy of another one still under way is no
  // longer the deck on air, and landing it replaced this one's copy and deleted it (2026-11-15 audit, A47).
  wantedDeckId = deckId;
  if (liveCopy?.deckId === deckId || copyingDeckId === deckId) return;
  const row = getSlidesRepo().getDeckById(deckId);
  if (!row) return;
  const source: DeckSource = { sourcePath: row.sourcePath, sourceSizeBytes: row.sourceSizeBytes, sourceMtimeMs: row.sourceMtimeMs };
  copyingDeckId = deckId;
  const dest = path.join(liveDeckDir, `${deckId}${path.extname(source.sourcePath)}`);
  // Each copy writes its own file and lands by a rename: two copies of one deck can be under way (D, E, D again inside
  // D's copy), and one that failed mid-write spoiled the file the other had landed (final pass of the audit, A47).
  const partial = `${dest}.${++liveCopySeq}.partial`;
  void (async () => {
    try {
      await fs.promises.mkdir(liveDeckDir, { recursive: true });
      if (!(await sourceUnchanged(source))) return;
      try {
        await fs.promises.copyFile(source.sourcePath, partial);
        if ((await fs.promises.stat(partial)).size !== source.sourceSizeBytes || wantedDeckId !== deckId) {
          await fs.promises.rm(partial, { force: true });
          return;
        }
        await renameWithRetry(partial, dest);
      } catch (error) {
        await fs.promises.rm(partial, { force: true }).catch(() => undefined);
        throw error;
      }
      const previous = liveCopy;
      const kept = { deckId, path: dest, source, music: previous?.deckId === deckId ? previous.music : null };
      liveCopy = kept;
      if (previous && previous.path !== dest) await fs.promises.rm(previous.path, { force: true });
      if (previous?.music && previous.music !== kept.music) await fs.promises.rm(previous.music.path, { force: true });
      // Its music after its slides, which matter first; dropped like the deck's if another deck is kept meanwhile.
      if (musicPath) await keepLiveMusic(kept, musicPath, { late: false });
    } catch (error) {
      console.warn(`[slides] could not keep a copy of the deck on air (${source.sourcePath})`, error);
    } finally {
      if (copyingDeckId === deckId) copyingDeckId = null;
    }
  })();
}

/** Parts already read, by the file's stamp: every window drawing a deck (control, projector, stage, NDI) asks for
 *  the same fonts and pictures, and each was read and converted on main again, 70 to 104 ms a font and up to 460 ms
 *  a metafile, over a video of the engine on air (2026-11-15 audit, A11). Read on their own thread now (SE1), a part
 *  already read is still answered from here at once. A 415 is kept (the same bytes never convert, or killed the
 *  parts' thread). A 404 never is, sized past the budget (a part that ran out of its thread's clock answers 404 too): the readers answer a read error (a pen drive that
 *  hiccups) as a missing part, and kept it was a missing picture for the session (review follow-up). */
const deckParts = byteLru<DeckPart>(64 * 1024 * 1024, (found) =>
  found === 404 ? Number.POSITIVE_INFINITY : found === 415 ? 0 : found.body.byteLength,
);

/**
 * A part of a model deck's package: a picture as is, a metafile (EMF/WMF,
 * which Chromium can't decode) as the SVG `metafileToSvg` makes of it, a font
 * as the TrueType `decodeEmbeddedFont` rebuilds, all read on the parts' thread
 * (`readDeckPart`), never on main. Immutable like everything under a deck id.
 */
async function serveDeckPart(request: Request, deckId: number, kind: "part" | "font", part: string): Promise<Response> {
  const source = Number.isFinite(deckId) ? getSlidesRepo().getDeckSource(deckId) : null;
  const sourcePath = source && (await readableSource(source));
  if (!source || !sourcePath) return new Response("Gone", { status: 410 });
  // The four windows' asks meet in the cache, or in the one read still under way.
  const key = [source.sourcePath, source.sourceSizeBytes, source.sourceMtimeMs, kind, part].join("\n");
  const found = await deckParts(key, () => readDeckPart(sourcePath, kind, part));
  if (found === 404) return new Response("Not found", { status: 404 });
  if (found === 415) return new Response("Unreadable", { status: 415 });
  return new Response(request.method === "HEAD" ? null : new Uint8Array(found.body), {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": found.type,
      "Content-Length": String(found.body.length),
    },
  });
}
