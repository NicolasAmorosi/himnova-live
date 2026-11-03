import type { AssetKind } from "../constants";
import {
  ASSET_KINDS,
  SLIDES_DEFAULT_CACHE_MB,
  SLIDES_DEFAULT_RENDER_WIDTH,
} from "../constants";
import { isBibleStyle, normalizeBibleStyle } from "../bible-style-validators";
import { DEFAULT_BIBLE_STYLE, type BibleStyle } from "./bible-style";
import { MEDIA_SORT_ORDERS, type MediaSortOrder } from "./media";
import { TRANSITION_MAX_DURATION_MS, TRANSITION_STYLES, type TransitionStyle } from "./transition";

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export const LOCALES = ["es", "en", "it", "pt"] as const;
export type Locale = (typeof LOCALES)[number];

export const SLIDE_IMAGE_FORMATS = ["webp", "png"] as const;
export type SlideImageFormat = (typeof SLIDE_IMAGE_FORMATS)[number];

/** The faces a slide can fall back to when it names one this machine lacks:
 *  the open ones Lumina ships (`assets/fonts/slides/`), so the choice looks
 *  the same on every machine a program is opened on. */
export const SLIDE_FALLBACK_FONTS = [
  "Carlito",
  "Caladea",
  "Liberation Sans",
  "Liberation Serif",
  "Liberation Mono",
  "Open Sans",
  "Montserrat",
  "Source Sans Pro",
] as const;
export type SlideFallbackFont = (typeof SLIDE_FALLBACK_FONTS)[number];

export type SettingsMap = {
  "logo.path": string | null;
  /** Where the file picker opens for each kind of asset. `null` means "the
   *  operating system's own folder for this kind" (`systemMediaFolder` in
   *  `main/paths.ts`), which is resolved fresh on every pick: it is looked up
   *  through the OS API, so it follows a moved home directory and is spelled
   *  in whatever language the machine is installed in. Storing the resolved
   *  path instead would freeze both. A non-null value is an explicit override
   *  the operator chose in Settings. */
  "files.defaultFolders": Record<AssetKind, string | null>;
  "projection.displayId": number | null;
  "ui.theme": Theme;
  "ui.locale": Locale;
  "media.volume": number;
  /** How the projector moves between scenes — see `TransitionStyle`. */
  "projection.transition.style": TransitionStyle;
  /** Ignored when the style is "none". */
  "projection.transition.durationMs": number;
  /** Whether the LIVE monitor plays its own moving copy of a live video (the
   *  full-screen one and a slide's). Off, it shows the video's thumbnail and
   *  the control window decodes nothing — the projector is never affected. */
  "monitors.liveVideoMotion": boolean;
  /** The format a PDF's pages are rasterized to. */
  "slides.imageFormat": SlideImageFormat;
  /** The face a `.pptx` drawn from its model falls back to when it names one
   *  this machine lacks (after its metric twins); `null` is the operating
   *  system's own sans-serif. One for every face, serif or not (owner,
   *  2026-10-28). */
  "slides.fallbackFont": SlideFallbackFont | null;
  "slides.cacheMaxMb": number;
  "slides.maxRenderWidth": number;
  /** Internal escape hatch (no UI control): lets a background job rasterizing
   *  a PDF be soft-interrupted when the operator opens something
   *  interactively — set to `false` to degrade to plain priority ordering (no
   *  preemption) without a release. */
  "slides.preemptBackground": boolean;
  /** Folders the operator has linked per asset kind, so a resource tab can
   *  offer "this folder's files" as an alternative to the added-to-library
   *  list. Files inside are registered like any other asset (so preview/
   *  live/drag all work the same) but never marked `inLibrary`. */
  "library.linkedFolders": Record<AssetKind, string[]>;
  /** Which source view (`"recent"` or one of that kind's linked folder
   *  paths) a resource tab was last left on, restored on next launch. */
  "library.activeView": Record<AssetKind, string>;
  /** How each resource tab's grid is ordered. Per kind rather than global:
   *  a folder of hymn decks is browsed by name, a folder of sermon videos by
   *  date, and the operator should not have to re-pick on every switch. */
  "library.sort": Record<AssetKind, MediaSortOrder>;
  /** Whether this database has ever been given the four built-in time scenes
   *  (`defaultUtilityScenes`). A flag and not a row count, deliberately:
   *  re-seeding whenever `utility_scenes` happens to be empty would mean an
   *  operator can never be rid of a scene they deleted — the four would come
   *  back on the next launch. Seeding once is what makes "delete" mean
   *  delete. */
  "utility.seeded": boolean;
  /** How a scripture verse is drawn on the projector — see `BibleStyle`.
   *  A JSON column in all but name, so it is the one settings key with a
   *  normalizer as well as a validator (`SETTINGS_NORMALIZERS`). */
  "bible.style": BibleStyle;
  /** Which version the Bible tab opens on. `null` means "whichever comes
   *  first", which is what the app did before this key existed — an insertion
   *  order nobody chose. Reset to `null` when the version it names is
   *  deleted, by the delete itself: a dangling id would silently fall back
   *  and look like the setting was never saved. */
  "bible.defaultVersionId": number | null;
  /** Whether this database has ever been offered the bundled RV1909.
   *
   *  Exists for exactly the reason `utility.seeded` does, with one extra
   *  wrinkle. `seedBuiltinBibles()` runs on every launch, so without a flag a
   *  deleted RV1909 would reappear at the next one and «delete» would not
   *  mean delete. But the flag must NOT disable seeding outright: the seed is
   *  also the upgrade path — it re-imports when `resources/bibles/rv1909.json`
   *  changes hash, which is how a corrected bundle reaches an existing
   *  install. So the flag is only consulted when the version row is GONE (see
   *  `seedBuiltinBibles`), which is the only case that means the operator
   *  deleted it on purpose. */
  "bible.builtinSeeded": boolean;
  /** Whether the app looks for a new version on its own, once per launch. Off,
   *  it never connects anywhere unless the operator presses «Check now». */
  "updates.autoCheck": boolean;
  /** The last version the launch toast announced, so each one is announced
   *  once and not every morning until it is installed. */
  "updates.announcedVersion": string | null;
};

export const DEFAULT_SETTINGS: SettingsMap = {
  "logo.path": null,
  "files.defaultFolders": { video: null, image: null, audio: null, ppt: null },
  "projection.displayId": null,
  "ui.theme": "dark",
  "ui.locale": "es",
  // Full. Anything sent live is meant to be heard, and a level the operator
  // never set is a level nobody can explain from the booth — halfway up just
  // looks like the file is quiet. Balancing down is one drag away, per track,
  // in the Live panel.
  "media.volume": 1,
  "projection.transition.style": "crossfade",
  "projection.transition.durationMs": 300,
  "slides.imageFormat": "webp",
  "slides.fallbackFont": null,
  "slides.cacheMaxMb": SLIDES_DEFAULT_CACHE_MB,
  "slides.maxRenderWidth": SLIDES_DEFAULT_RENDER_WIDTH,
  "slides.preemptBackground": true,
  "monitors.liveVideoMotion": true,
  "library.linkedFolders": { video: [], image: [], audio: [], ppt: [] },
  "library.activeView": { video: "recent", image: "recent", audio: "recent", ppt: "recent" },
  "library.sort": { video: "name-asc", image: "name-asc", audio: "name-asc", ppt: "name-asc" },
  "utility.seeded": false,
  "bible.style": DEFAULT_BIBLE_STYLE,
  "bible.defaultVersionId": null,
  "bible.builtinSeeded": false,
  "updates.autoCheck": true,
  "updates.announcedVersion": null,
};

/* -------------------------------------------------------------------------
 * Runtime validation
 *
 * `SettingsMap` is erased at build time, and `registerHandlers` casts the IPC
 * request from `unknown` to the declared type without checking anything. The
 * renderer is another process: a stale bundle after a partial update, or a
 * `Record` built wrong, writes a durable row no migration will ever clean up.
 * `"ui.theme": "purple"` persists, is read at startup, lands in
 * `document.documentElement.dataset.theme` and leaves the app with NO theme
 * applied until someone edits the database by hand.
 *
 * One predicate per key, next to the defaults so a new setting cannot be added
 * without one — `Record<keyof SettingsMap, ...>` makes a missing entry a
 * compile error. No new dependency: the key list already exists right above.
 * ---------------------------------------------------------------------- */

const isString = (v: unknown): boolean => typeof v === "string";
const isBoolean = (v: unknown): boolean => typeof v === "boolean";
const isNullOr =
  (inner: (v: unknown) => boolean) =>
  (v: unknown): boolean =>
    v === null || inner(v);
const isOneOf =
  (values: readonly string[]) =>
  (v: unknown): boolean =>
    typeof v === "string" && values.includes(v);

/** Finite on purpose: `NaN` and `Infinity` are numbers, survive
 *  `JSON.stringify` as `null`, and come back as a default-shaped hole. */
const isNumberIn =
  (min: number, max: number) =>
  (v: unknown): boolean =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** A display id is an OS handle, not a measurement: it only has to be a
 *  positive integer for `screen.getAllDisplays()` to ever match it. The string
 *  `"2"` that a mis-built form would send never equals any `d.id`, and the
 *  projector silently falls back to the default screen forever. */
const isDisplayId = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);

const isRecordOfKinds =
  (valueOk: (v: unknown) => boolean) =>
  (v: unknown): boolean => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const record = v as Record<string, unknown>;
    // Exactly the four kinds: an extra key is a caller that has drifted from
    // `AssetKind`, and a missing one is a `Record` that will read `undefined`
    // on the tab it forgot.
    if (Object.keys(record).length !== ASSET_KINDS.length) return false;
    return ASSET_KINDS.every((kind) => kind in record && valueOk(record[kind]));
  };

const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every(isString);

export const SETTINGS_VALIDATORS: Record<keyof SettingsMap, (value: unknown) => boolean> = {
  "logo.path": isNullOr(isString),
  "files.defaultFolders": isRecordOfKinds(isNullOr(isString)),
  "projection.displayId": isDisplayId,
  "ui.theme": isOneOf(THEMES),
  "ui.locale": isOneOf(LOCALES),
  "media.volume": isNumberIn(0, 1),
  "projection.transition.style": isOneOf(TRANSITION_STYLES),
  "projection.transition.durationMs": isNumberIn(0, TRANSITION_MAX_DURATION_MS),
  "slides.imageFormat": isOneOf(SLIDE_IMAGE_FORMATS),
  "slides.fallbackFont": isNullOr(isOneOf(SLIDE_FALLBACK_FONTS)),
  "slides.cacheMaxMb": isNumberIn(1, 1_000_000),
  "slides.maxRenderWidth": isNumberIn(320, 16_384),
  "slides.preemptBackground": isBoolean,
  "monitors.liveVideoMotion": isBoolean,
  "library.linkedFolders": isRecordOfKinds(isStringArray),
  "library.activeView": isRecordOfKinds(isString),
  "library.sort": isRecordOfKinds(isOneOf(MEDIA_SORT_ORDERS)),
  "utility.seeded": isBoolean,
  "bible.style": isBibleStyle,
  "bible.defaultVersionId": (v) => v === null || (typeof v === "number" && Number.isInteger(v) && v > 0),
  "bible.builtinSeeded": isBoolean,
  "updates.autoCheck": isBoolean,
  "updates.announcedVersion": isNullOr(isString),
};

export function isSettingsKey(key: string): key is keyof SettingsMap {
  return Object.hasOwn(SETTINGS_VALIDATORS, key);
}

/**
 * The keys whose stored value is a STRUCTURE rather than a scalar, and what to
 * make of one that no longer matches this build's idea of it.
 *
 * The rule `CLAUDE.md` states for a JSON column — validate on write, normalize
 * FIELD BY FIELD on read — has had no place to live in `settings` until now,
 * because every key here was a scalar or a `Record` of them: a bad one falls
 * back to its default and nothing is lost but that one value. `bible.style` is
 * the first key where all-or-nothing would be wrong, for the same reason
 * `utility_scenes.style_json` normalizes: a style whose gradient lost one
 * colour must come back with the operator's own typography and a default
 * background, not as a stranger — and a launch must never fail over it.
 *
 * `Partial` and not `Record`, deliberately: a scalar key needs nothing here,
 * and requiring an entry per key would mean fifteen identity functions.
 * `SettingsRepo.load` applies whatever it finds and leaves the rest alone.
 */
export const SETTINGS_NORMALIZERS: {
  [K in keyof SettingsMap]?: (value: unknown) => SettingsMap[K];
} = {
  "bible.style": normalizeBibleStyle,
};
