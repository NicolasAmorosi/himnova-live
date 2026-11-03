import type { SlideTransition } from "./transition";

/**
 * A PowerPoint/Impress deck as a set of images plus whatever audio/timing
 * metadata could be recovered from it: converted once and rasterized, or —
 * for a deck made only of pictures, like the hymnal — read straight from its
 * source file with no copy at all. Replaces the COM-driven live slideshow
 * session — a deck is content, not a remote-controlled process, so main owns
 * a cache instead of a slide cursor.
 */
export type DeckStatus = "converting" | "ready" | "failed" | "stale";

export type DeckSlide = {
  /** 1-based, presentation order (`p:sldIdLst`), not filename order. */
  index: number;
  /** worship://deck/<deckId>/<index> — full-resolution image. */
  url: string;
  /** worship://deck/<deckId>/<index>/thumb — small preview. */
  thumbUrl: string;
  /** worship://deck/<deckId>/<index>/model for a deck drawn from its model
   *  (`SlideView`, a `.pptx`): then `url`/`thumbUrl` are only its identity and
   *  serve no image. `null` for a slide that is an image. */
  modelUrl: string | null;
  /** Auto-advance delay from the .pptx transition timing, in ms. `null` means
   *  this slide only advances manually. */
  advanceAfterMs: number | null;
  /** How this slide enters when the deck moves forward onto it; `null` is a
   *  cut. See `SlideTransition`. */
  transition: SlideTransition | null;
};

export type DeckSoundtrack = {
  url: string;
  durationMs: number | null;
  /** `embedded`/`transition` come from inside the file and live in the deck
   *  cache; `linked` is an external file resolved per media asset (an old
   *  hymnal's sibling .mp3) and served by reference — see `linked-audio.ts`. */
  origin: "embedded" | "transition" | "linked";
  /** File name, for the "Add audio" control to show what's playing. */
  name: string;
};

/** A sound inside the file other than the deck's music: it plays from its
 *  slide to its last one, PowerPoint's «stop after N slides» — `null` being the
 *  end of the deck. Slides are 1-based among the ones the deck shows. */
export type DeckSound = {
  /** `deck_audio.id`: the track's identity on the projector. */
  id: number;
  url: string;
  startSlideIndex: number;
  stopSlideIndex: number | null;
  loop: boolean;
};

/**
 * A rectangle inside the slide, as fractions of the slide's own box (0..1:
 * left, top, width, height).
 *
 * Fractions and not EMU, px or points on purpose: the projector paints the
 * slide with `object-contain`, so the box the video has to land on is whatever
 * the letterboxing left — a number in the source file's own units would have
 * to be converted against that box by every consumer, and every consumer would
 * be a chance to convert it differently.
 */
export type SlideRect = { x: number; y: number; width: number; height: number };

/**
 * A video embedded in one slide of a `.pptx`/`.ppsx`, pulled out of the OOXML
 * into the deck cache and positioned by the rect the file itself declares.
 *
 * Only `.pptx`-family sources produce these today: PowerPoint 97-2003 almost
 * never embedded a video (it linked it by absolute path), and an `.odp`'s
 * clips are not extracted yet.
 *
 * The slide underneath is NOT a hole to patch: its model draws the video's
 * poster frame into exactly this rect, so a deck whose video cannot be
 * extracted or decoded still looks right — it just does not move. That is why
 * an unplayable video is simply absent here rather than reported.
 */
export type DeckSlideVideo = {
  /** 1-based, and the SAME index space as `DeckSlide.index`: page order, with
   *  hidden slides already dropped. The OOXML's own slide numbering counts
   *  hidden slides and is mapped away in `deck-service.ts` before it ever
   *  reaches this type. */
  slideIndex: number;
  /** worship://deck-video/<id> */
  url: string;
  rect: SlideRect;
  /** Width/height of the RASTERIZED slide this rect was measured against.
   *  The projector paints the slide with `object-contain`, so it has to
   *  rebuild that letterboxed box before it can place `rect` inside it — and
   *  taking the ratio from the rendered page rather than from the source's
   *  `p:sldSz` makes it exact by construction: it is literally the image the
   *  `<img>` beside the video is showing. */
  aspectRatio: number;
  /** From the slide's `p:cMediaNode` — PowerPoint's own "repeat until I move
   *  on" flag. */
  loop: boolean;
  /** 0..1, the level the source file declares, or `null` when it declares
   *  none — the app's own default then applies. The operator's level lives in
   *  `projection.store` and overrides both. */
  volume: number | null;
  /** The file name inside the cache, for the media panel's row. */
  name: string;
};

export type DeckDTO = {
  /** media_assets.id of the .pptx/.ppt — the only handle the renderer needs. */
  assetId: number;
  deckId: number;
  status: DeckStatus;
  slideCount: number;
  /** Empty while converting. */
  slides: DeckSlide[];
  /** The music under the whole deck, from its first slide: the clock a deck
   *  that advances by itself follows (`deck-autoplay.ts`). */
  soundtrack: DeckSoundtrack | null;
  /** Every other sound in the file, each on its own slides (`deck-sounds.ts`). */
  sounds: DeckSound[];
  /** One entry per slide that carries a playable embedded video. Almost always
   *  empty, and never longer than `slides` — a slide with two videos keeps the
   *  first, since `ProjectionOutput` sustains one at a time. */
  videos: DeckSlideVideo[];
  /** True iff any slide carries an advanceAfterMs — drives whether autoplay
   *  starts automatically when the deck is presented. */
  autoAdvance: boolean;
  /** Which reading of the file the timings came from. "none" means the
   *  deck's own timings couldn't be read or didn't line up with the slides
   *  drawn — auto-advance was disabled on purpose, not lost by accident — or
   *  that it has none (a PDF). */
  timingsSource: "ooxml" | "binary" | "odf" | "none";
  sourceMtimeMs: number;
  convertedAt: number;
  error: string | null;
};

/** What one library tile needs to know about a deck without asking for the
 *  whole `DeckDTO`: whether it still needs converting, and where its
 *  first-slide thumbnail lives. Answered for a whole grid in one round-trip
 *  (`deck:statuses`) — an asset with no deck row at all simply has no entry.
 *
 *  `thumbUrl` is non-null only for a `ready` deck, and points into the
 *  content-addressed deck cache (`worship://deck/<deckId>/1/thumb`), which is
 *  the authoritative rendering of that slide. A PPT never goes through the
 *  generated media-thumbnail cache. */
export type DeckStatusSummary = {
  status: DeckStatus;
  thumbUrl: string | null;
  /** The first slide's model, for a deck drawn from its model: the tile draws
   *  it with `SlideView` instead of an image. */
  modelUrl: string | null;
};

export type DeckProgress = {
  assetId: number;
  status: DeckStatus;
  done: number;
  total: number;
  error: string | null;
};

/** Aggregate progress of one "Prepare folder/view" batch — a single event
 *  stream so pre-warming hundreds of decks in the background doesn't turn
 *  into hundreds of per-asset store entries and re-renders. Per-tile progress
 *  still comes from `DeckProgress`/`deck-progress` for whichever one is
 *  actually converting right now. */
export type PrewarmProgress = {
  jobId: string;
  /** What to show the operator — e.g. the folder or tab name. */
  label: string;
  total: number;
  done: number;
  /** Already had a ready deck when the batch started. */
  skipped: number;
  failed: number;
  currentAssetId: number | null;
  status: "running" | "done" | "canceled" | "cache-full";
};

/** What the slide cache costs right now, for the one screen that exposes it.
 *  `maxBytes` is `slides.cacheMaxMb` resolved — the budget eviction enforces,
 *  not a hard ceiling: a single deck larger than the budget is still kept. */
export type DeckCacheStats = {
  deckCount: number;
  bytesOnDisk: number;
  maxBytes: number;
};
