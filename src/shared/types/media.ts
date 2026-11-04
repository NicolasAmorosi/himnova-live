import type { AssetKind } from "../constants";

export type MediaAsset = {
  id: number;
  kind: AssetKind;
  name: string;
  ext: string;
  path: string;
  sizeBytes: number | null;
  /** Last-modified time of the file on disk. Together with `sizeBytes` this is
   *  the identity of the asset's *bytes*, which is what a thumbnail's
   *  cache-buster is keyed on (`assetThumbVersion`) — `updatedAt` is a
   *  property of the row, not of the file, and is wrong for that job. */
  mtimeMs: number | null;
  durationMs: number | null;
  linkedAudioPath: string | null;
  inLibrary: boolean;
  missingSince: number | null;
  createdAt: number;
  updatedAt: number;
};

/** One saved program that still references an asset — surfaced to the
 *  operator when a delete is blocked, so they can see what would break. */
export type MediaAssetUsage = {
  programId: number;
  programName: string;
  itemCount: number;
};

/** Progress of a chunked `library:add`/`library:listFolder` import, pushed
 *  only for batches large enough that the UI needs it (`library-import.ts`).
 *  `status: "done"` is the authoritative end-of-import signal — the renderer
 *  clears its progress bar on this, never on `library-changed` (a `list*`
 *  read can legitimately re-fire that event for unrelated reasons, and used
 *  to be the only thing importPaths() emitted at all). */
export type ImportProgress = {
  kind: AssetKind;
  done: number;
  total: number;
  status: "running" | "done";
};

/**
 * How a resource tab's grid is ordered.
 *
 * Shared vocabulary rather than a renderer-only string: the choice is
 * persisted per asset kind in `settings["library.sort"]`, and main validates
 * what the renderer writes there (`SETTINGS_VALIDATORS`) against this exact
 * list. `date` is the file's own `mtimeMs`, falling back to the row's
 * `createdAt` for an asset that was never stat'd.
 */
export const MEDIA_SORT_ORDERS = [
  "name-asc",
  "name-desc",
  "date-desc",
  "date-asc",
  "size-desc",
  "size-asc",
] as const;
export type MediaSortOrder = (typeof MEDIA_SORT_ORDERS)[number];

/** A library video or audio the media engine started (`engine: true`) or stopped playing
 *  (`main/media/engine-assets.ts`). One it does not play is played by Chromium. */
export type EngineAssetUpdate = { assetId: number; engine: boolean };

/** What only Chromium itself can say about this machine, reported by the
 *  control window at startup: HEVC decoding depends on the GPU. */
export type DecoderSupport = { hevc: boolean; hevcMain10: boolean };
