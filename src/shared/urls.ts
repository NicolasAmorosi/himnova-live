/**
 * URLs are capability tokens, never filesystem paths: `worship://asset/42`
 * resolves through the DB in the main process, so nothing here can
 * path-traverse and a relocated file keeps the same URL (React never has to
 * remount a player because a path changed).
 */
export function assetUrl(mediaAssetId: number): string {
  return `worship://asset/${mediaAssetId}`;
}

/**
 * A library video played by the media engine (`main/media/engine-sessions.ts`)
 * instead of a `<video>`: one Chromium cannot decode, which used to be
 * converted. Nothing fetches it — main resolves it to the file and sends the
 * engine's frames, and a view that sees one mounts a canvas for them. Its own
 * host, so it can never be mistaken for the original or a copy of it.
 */
export function engineAssetUrl(mediaAssetId: number): string {
  return `worship://engine/${mediaAssetId}`;
}

/** The asset an `engineAssetUrl` names, or null for any other url. */
export function engineAssetIdOfUrl(url: string): number | null {
  const match = /^worship:\/\/engine\/(\d+)$/.exec(url);
  return match ? Number(match[1]) : null;
}

/** A clip embedded in a deck (`deck_audio`/`deck_video` row) that the media
 *  engine plays, because Chromium cannot (`media/deck-clips.ts`). */
export function engineClipUrl(kind: "audio" | "video", clipId: number): string {
  return `worship://engine/deck-${kind}/${clipId}`;
}

/** The clip an `engineClipUrl` names, or null for any other url. */
export function engineClipOfUrl(url: string): { kind: "audio" | "video"; id: number } | null {
  const match = /^worship:\/\/engine\/deck-(audio|video)\/(\d+)$/.exec(url);
  return match ? { kind: match[1] as "audio" | "video", id: Number(match[2]) } : null;
}

/** Whether only the media engine plays this url — a library file or a deck clip. */
export function isEngineUrl(url: string): boolean {
  return url.startsWith("worship://engine/");
}

/** The key main sends a live video's frames under — the full-screen one or the
 *  live slide's: by epoch, so a frame of the previous video still in flight
 *  never lands on the next one's canvas. */
export function liveEngineFrameKey(target: "video" | "slideVideo" | "songVideo", epoch: number): string {
  return `${target}:${epoch}`;
}

/** The PREVIEW monitor's: by url, for the same reason — its epoch never moves. */
export function previewEngineFrameKey(url: string): string {
  return `preview:${url}`;
}

/**
 * A small, cached thumbnail of an image or video asset, generated on demand by
 * `main/media/thumbnail-service.ts`. 404 when there is none (an audio file, an
 * unsupported platform, a broken decode) so the renderer paints its own
 * themed fallback instead of a browser-drawn broken image.
 *
 * `version` is NOT optional on purpose. The response is served `immutable`, so
 * a stable URL would pin the first thumbnail ever generated for this id for a
 * year — exactly the bug the logo picker hit
 * (`.claude/knowledge/stable-capability-url-needs-a-cache-buster-to-refresh.md`).
 * Making the argument required turns "I forgot the cache-buster" into a
 * compile error rather than a stale picture nobody can explain.
 *
 * Build it with `assetThumbVersion(asset)` so every call site derives it the
 * same way.
 */
export function assetThumbUrl(mediaAssetId: number, version: string): string {
  return `worship://asset/${mediaAssetId}/thumb?v=${encodeURIComponent(version)}`;
}

/** The identity of an asset's *bytes*, as far as thumbnails care: size + mtime,
 *  the same cheap identity `slide_decks` already trusts for its cache hit.
 *  Deliberately not `updatedAt` — that changes on unrelated DB writes and does
 *  NOT change when the file is edited outside the app, which is precisely
 *  backwards for a cache-buster. */
export function assetThumbVersion(asset: {
  sizeBytes: number | null;
  mtimeMs: number | null;
}): string {
  return `${asset.sizeBytes ?? 0}-${asset.mtimeMs ?? 0}`;
}

/**
 * Slide images are addressed by deck id + index and resolved against
 * `deck_slides`. A (deckId, slideIndex) pair is immutable by construction —
 * changing the source file yields a different content hash and therefore a
 * different deck id — which is what lets the protocol handler serve them with
 * a long immutable Cache-Control.
 *
 * Built by main when assembling a `DeckDTO`; the renderer reads `slide.url`.
 */
export function slideUrl(deckId: number, slideIndex: number): string {
  return `worship://deck/${deckId}/${slideIndex}`;
}

export function slideThumbUrl(deckId: number, slideIndex: number): string {
  return `worship://deck/${deckId}/${slideIndex}/thumb`;
}

/** A slide of a deck drawn from its model (`SlideView`, image_format
 *  'model'): the `SlideModel` JSON, immutable like the slide images. */
export function slideModelUrl(deckId: number, slideIndex: number): string {
  return `worship://deck/${deckId}/${slideIndex}/model`;
}

/** A part of the deck's own source package — a picture a slide model names —
 *  served straight from the file, never extracted. A metafile (EMF/WMF) comes
 *  back as SVG. */
export function deckPartUrl(deckId: number, part: string): string {
  return `worship://deck/${deckId}/part/${encodeURIComponent(part)}`;
}

/** A font embedded in the deck, decoded to the TrueType a `FontFace` takes. */
export function deckFontUrl(deckId: number, part: string): string {
  return `worship://deck/${deckId}/font/${encodeURIComponent(part)}`;
}

/** The deck id in any `worship://deck/<id>/…` url, so a slide model's parts
 *  resolve against the deck its url names. */
export function deckIdOfUrl(url: string): number | null {
  const match = /^worship:\/\/deck\/(\d+)\//.exec(url);
  return match ? Number(match[1]) : null;
}

/** `file` is the clip's file name inside the deck's cache. It changes when
 *  `media/deck-clips.ts` replaces an unplayable clip with a converted one, so
 *  the url changes with the bytes — which Chromium's media cache requires —
 *  and an element still on the old url keeps reading the old file. */
export function deckAudioUrl(audioId: number, file: string): string {
  return `worship://deck-audio/${audioId}?f=${encodeURIComponent(file)}`;
}

/** A video embedded in one slide, extracted into the same content-addressed
 *  deck cache as `deckAudioUrl`'s audio and addressed the same way: by row id,
 *  never by a path (`file` is a bare name, see `deckAudioUrl`). */
export function deckVideoUrl(videoId: number, file: string): string {
  return `worship://deck-video/${videoId}?f=${encodeURIComponent(file)}`;
}

/** A deck's *linked* soundtrack — an external file the source presentation
 *  points at (or sits next to), resolved per media asset rather than baked
 *  into the content-addressed deck cache. See `linked-audio.ts`. */
export function linkedAudioUrl(mediaAssetId: number): string {
  return `worship://linked-audio/${mediaAssetId}`;
}

/** The deck asset a `linkedAudioUrl` names, or null for any other url. */
export function linkedAudioAssetIdOfUrl(url: string): number | null {
  const match = /^worship:\/\/linked-audio\/(\d+)$/.exec(url);
  return match ? Number(match[1]) : null;
}

/**
 * A deck's music as PREVIEW's media engine can open it (owner, 2026-11-05:
 * PREVIEW sounds, at its own volume): an embedded clip by its row, whatever
 * its codec, and a linked file as it is. `null` for anything else.
 */
export function previewSoundtrackUrl(url: string): string | null {
  if (engineClipOfUrl(url) || linkedAudioAssetIdOfUrl(url) !== null) return url;
  const clip = /^worship:\/\/(?:engine\/)?deck-audio\/(\d+)/.exec(url);
  return clip ? engineClipUrl("audio", Number(clip[1])) : null;
}

export const LOGO_URL = "worship://logo";
