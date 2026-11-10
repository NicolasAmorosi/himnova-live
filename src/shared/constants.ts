/** Cross-cutting constants shared by main and renderer. */

export const ASSET_KINDS = ["video", "image", "audio", "ppt"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** `pptm`/`ppsx`/`ppsm` are the same OOXML zip as `pptx`; `pps` is the legacy
 *  binary format like `ppt` (the v1 vanilla app accepted both and the TS
 *  migration dropped them); `odp` is OpenDocument. Each is read by the app
 *  itself into a model per slide — what the bytes are decides which reader,
 *  never the extension (`containerKind`).
 *
 *  `pdf` is deliberately a `ppt`, not an `AssetKind` of its own: everywhere in
 *  the renderer `kind === "ppt"` already means "this is a deck" (the tile's
 *  deck badge, the deck store, pre-warming, the `ppt` `ProgramItemKind` and
 *  its CHECK constraint), and a PDF is a deck whose pages happen to be
 *  rendered already. Listing the extension here is what gives it the file
 *  dialog's filter, drag & drop, folder import, the content-addressed cache
 *  and "Prepare folder" without a single branch. */
export const ASSET_EXTENSIONS: Record<AssetKind, readonly string[]> = {
  // Everything past the first six is played by the media engine
  // (`main/media/engine-assets.ts`) — and so can the first six be, when what
  // is inside them is a codec Chromium cannot decode.
  video: [
    ...["mp4", "m4v", "mov", "mkv", "webm", "3gp"],
    ...["avi", "wmv", "asf", "flv", "f4v", "mpg", "mpeg", "m2v", "vob", "ts", "mts", "m2ts"],
    ...["ogv", "divx", "mxf", "dv", "3g2"],
  ],
  image: ["jpg", "jpeg", "png", "gif", "webp", "bmp"],
  audio: [
    ...["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus", "oga", "weba"],
    ...["wma", "aiff", "aif", "ac3", "mka", "mp2", "amr"],
  ],
  ppt: ["ppt", "pptx", "pptm", "pps", "ppsx", "ppsm", "odp", "pdf"],
};

/** The audio Chromium plays as it is: a deck's linked music in any other format (a `.wma`, an AIFF)
 *  is played by the media engine (`engineLinkedAudioUrl`). */
export const CHROMIUM_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus", "oga", "weba"]);

// A `text` kind used to live here too: schema column, DTO, repo mapping,
// preview, projector output — everything except a way to create one. It was
// removed in 0009 rather than finished; an announcement is a PPT slide in
// this church's workflow, and a half-wired kind is worse than no kind.
// `utility` (a saved time scene) joined them in F3 of the Functions plan: it
// is full-screen base content like any other, so it is a row of the order of
// service like any other. `plate` (a saved overlay plate) followed on
// 2026-09-24: not base content, but the operator plans «the pastor's name
// before the sermon» into the order of service like everything else.
export const PROGRAM_ITEM_KINDS = ["media", "ppt", "bible", "utility", "plate", "song"] as const;
export type ProgramItemKind = (typeof PROGRAM_ITEM_KINDS)[number];

/** Bump to read every PDF deck again (its page sizes) when the way its pages
 *  are fitted changes. 4: pages drawn when asked for, nothing rasterized to
 *  disk (2026-11-03). Reading one costs ~25 ms, so a bump is free. */
export const SLIDES_CONVERTER_VERSION = 4;

/** The same role for a deck read straight from its source (`image_format =
 *  'native'`, `ppt-binary.ts`): bump when the rules for which pictures make up
 *  a slide change, so every native deck is read again. Reading one costs
 *  milliseconds and writes nothing to disk, so a bump is free. */
export const SLIDES_NATIVE_VERSION = 1;

/** The same for a deck drawn from its model (`image_format = 'model'`, a
 *  `.pptx` read by `src/main/slides/pptx/`): bump when the reader changes what
 *  it puts in a `SlideModel` or what a model deck records, so every such deck
 *  is read again. 2: speaker icons «hidden during show» left out, and each
 *  sound placed on its own slides. 3: tab stops, sized line breaks, fill
 *  overlays, SmartArt (cached drawings found, the rest laid out) and the
 *  charts that were refused. */
export const SLIDES_MODEL_VERSION = 3;

/** Bump to force every non-manual `media_assets` row to re-run
 *  `resolveLinkedAudio` once, next time its deck is opened, even though a
 *  cached result (including a cached "no match") is normally trusted as-is
 *  for performance — resolving a linked audio means reading the whole
 *  source folder and, for legacy binaries, the whole presentation file, so
 *  it must not run on every switch between decks. Bump this whenever the
 *  matching rules in `linked-audio.ts` change, so assets linked under the
 *  old rules (see .claude/knowledge/linked-audio-single-file-fallback-and-manual-override.md)
 *  self-correct without the operator touching each one by hand. 2: a `.mid`/`.midi` is no longer
 *  taken (2026-11-10). */
export const LINKED_AUDIO_RESOLVER_VERSION = 2;
export const SLIDES_THUMB_WIDTH = 320;

/** Bump to invalidate every cached media thumbnail at once when the way they
 *  are generated changes (a different width, a different encoder setting).
 *  Same role `SLIDES_CONVERTER_VERSION` plays for decks: it is part of the
 *  cache key, so a bump simply makes every existing file a miss instead of
 *  requiring anyone to delete a directory by hand. */
export const MEDIA_THUMB_VERSION = 1;
/** Width of a generated library thumbnail, in px. Two-ish times the ~120px a
 *  tile occupies, so it still looks right on a HiDPI screen without keeping a
 *  full-resolution decode of every visible image alive. */
export const MEDIA_THUMB_WIDTH = 320;
/** JPEG quality for generated thumbnails — deliberately not PNG: a tile is a
 *  photo or a video frame, and a lossless encode of one costs an order of
 *  magnitude more bytes for no visible gain at this size. */
export const MEDIA_THUMB_QUALITY = 80;
/** Thumbnails untouched for this long are pruned at startup. `size+mtime` is
 *  part of the cache key, so editing a file orphans its old thumbnail
 *  forever; this is what eventually collects those. Regenerating one is
 *  cheap, so erring on the short side costs nothing but a redraw. */
export const MEDIA_THUMB_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
/** Hard ceiling on the thumbnail directory, enforced oldest-first after the
 *  age pass. Age alone never bounded it: a church that adds a few hundred
 *  photos every week keeps every one of those thumbnails "fresh" and the
 *  directory only grows. At ~12 KB a thumbnail this is roughly 20.000 of
 *  them — far more than any real library shows in two months. */
export const MEDIA_THUMB_MAX_BYTES = 256 * 1024 * 1024;
/** A PDF page is drawn at the projector's own width, held between these two:
 *  up to a 4K screen, no knob (owner, 2026-11-05 — the setting only ever
 *  mattered for 4K). Before the screens are known, the 1080p width. */
export const SLIDES_FALLBACK_RENDER_WIDTH = 1920;
export const SLIDES_MIN_RENDER_WIDTH = 1280;
export const SLIDES_MAX_RENDER_WIDTH = 3840;
/** What the slide cache — the audio and video taken out of a `.pptx` — may
 *  hold before the oldest decks go. Fixed since 2026-11-05: a church's real
 *  use is a few megabytes, and the cap was a setting nobody reached. */
export const SLIDES_CACHE_MAX_MB = 4096;
/** PowerPoint permits a 0 ms auto-advance; without a floor a whole deck would
 *  fly past in a single frame. */
export const SLIDES_MIN_ADVANCE_MS = 250;
/** A prewarm automatic "visible" set is capped at this many decks. Now that
 *  the library grid is virtualized, "visible" is a real viewport range rather
 *  than "this whole linked folder's current view", so this is a backstop
 *  rather than the main defence: a very tall window at a very small tile size
 *  could still mount more tiles than a background queue should be handed at
 *  once. Anything beyond it is reachable through the manual "Prepare
 *  folder" button. */
export const PREWARM_VISIBLE_MAX = 32;
/** How many of an explicit import's presentations are converted automatically.
 *
 *  Dropping a folder of 600 `.pps` onto the library used to enqueue 600
 *  conversions — no confirmation, no progress bar, no way to stop it — which
 *  is precisely the "never 600 automatic decks" case the tracked, cancelable
 *  "Prepare folder" button exists for. Importing a handful and having them
 *  ready by the time you scroll to them is the behaviour worth keeping, and
 *  that is what this preserves; everything past it stays a deliberate act.
 *  Nothing is lost either way — an unconverted deck still converts on demand
 *  the moment it is previewed. */
export const PREWARM_EXPLICIT_MAX = 20;
export const SLIDES_RASTER_PAGE_TIMEOUT_MS = 30_000;

export const DEFAULT_MEDIA_VOLUME = 0.5;

/** The bundled bible's identity, NOT its edition: the text has always been the Reina-Valera
 *  1909 (public domain), shipped as «Reina-Valera 1960» through 2.2.0-beta.3. `bible_favorites`
 *  rows point at this code and the seed re-imports against it, so it never changes — same rule as
 *  the `worship-app` package name. The file and the name are what say 1909. */
export const BUILTIN_BIBLE_CODE = "rv1960";
