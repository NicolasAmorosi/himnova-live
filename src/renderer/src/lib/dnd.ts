import type { DragEvent } from "react";
import { ASSET_EXTENSIONS, ASSET_KINDS, type AssetKind } from "@shared/constants";

/** Custom MIME types for the things draggable inside the app: a library asset
 *  or a Bible verse (both dropped anywhere to add them) and a playlist row
 *  (dropped on another row to reorder). Kept distinct so a single `onDrop`
 *  can tell them apart. */
export const MEDIA_ASSET_MIME = "application/x-worship-media-asset";
export const BIBLE_VERSE_MIME = "application/x-worship-bible-verse";
export const SCHEDULE_INDEX_MIME = "application/x-worship-schedule-index";
/** A row of the saved-programs list, dropped on another row to reorder the
 *  list itself. Carries the program's **id**, not its index — the list can be
 *  refreshed mid-drag — and is kept distinct from `SCHEDULE_INDEX_MIME` so a
 *  program row can never be read as a playlist reorder. */
export const PROGRAM_ROW_MIME = "application/x-worship-program-row";
/** A saved time scene: dropped on another row inside the «Scenes» editor to
 *  reorder the list, or onto the order of service to add it there — the same
 *  two jobs `MEDIA_ASSET_MIME` does, and the reason one MIME covers both is
 *  that the editor is a modal: while it is open the schedule cannot be a drop
 *  target, and while it is closed its list does not exist.
 *  Carries the scene's **id** for the same reason the programs one does: the
 *  list is refreshed from main mid-drag, so an index would point at a
 *  different row by the time the drop lands. */
export const UTILITY_SCENE_MIME = "application/x-worship-utility-scene";
/** A saved overlay plate — `UTILITY_SCENE_MIME`'s two jobs for the Overlays
 *  tab: reordering inside the «Overlays» dialog, and adding it to the order of
 *  service from the tab's list. */
export const OVERLAY_PLATE_MIME = "application/x-worship-overlay-plate";
/** A song of the Songs tab, dropped onto the order of service. Its id, for
 *  the programs one's reason. */
export const SONG_MIME = "application/x-worship-song";
/** A row of the installed-bibles list in Settings, dropped on another row to
 *  reorder the list — which is also the order the version picker offers, so
 *  this is an arrangement and not a cosmetic one. Carries the version's **id**
 *  for the same reason the programs one does: the list is reloaded from main
 *  after every write, so an index could point at a different row by the time
 *  the drop lands. */
export const BIBLE_VERSION_MIME = "application/x-worship-bible-version";

let transparentDragImage: HTMLImageElement | null = null;

/** Suppresses the browser's default translucent drag-ghost, which otherwise
 *  trails the cursor in every direction. Used by vertical reorder lists whose
 *  only drop feedback is a `dropBefore` line (see `ListRow`) — with the ghost
 *  gone, nothing appears to move sideways while dragging up/down. */
export function hideDragGhost(e: DragEvent): void {
  transparentDragImage ??= new Image();
  if (!transparentDragImage.src) {
    transparentDragImage.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7";
  }
  e.dataTransfer.setDragImage(transparentDragImage, 0, 0);
}

export type DraggedAsset = { assetId: number; kind: AssetKind };

export type DraggedVerse = {
  bibleVersionId: number;
  bibleBookId: number;
  chapter: number;
  verseFrom: number;
  verseTo: number;
  reference: string;
  text: string;
};

export function setMediaAssetDrag(e: DragEvent, payload: DraggedAsset): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(MEDIA_ASSET_MIME, JSON.stringify(payload));
}

export function readMediaAssetDrag(e: DragEvent): DraggedAsset | null {
  const raw = e.dataTransfer.getData(MEDIA_ASSET_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DraggedAsset;
  } catch {
    return null;
  }
}

export function setBibleVerseDrag(e: DragEvent, payload: DraggedVerse): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(BIBLE_VERSE_MIME, JSON.stringify(payload));
}

export function readBibleVerseDrag(e: DragEvent): DraggedVerse | null {
  const raw = e.dataTransfer.getData(BIBLE_VERSE_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DraggedVerse;
  } catch {
    return null;
  }
}

export function setUtilitySceneDrag(e: DragEvent, sceneId: number): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(UTILITY_SCENE_MIME, String(sceneId));
}

/** The dragged scene's id, or `null` when this drag is something else. A
 *  non-numeric payload reads as "not a scene" rather than as scene `NaN`. */
export function readUtilitySceneDrag(e: DragEvent): number | null {
  const raw = e.dataTransfer.getData(UTILITY_SCENE_MIME);
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

export function setOverlayPlateDrag(e: DragEvent, plateId: number): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(OVERLAY_PLATE_MIME, String(plateId));
}

/** The dragged plate's id, or `null` — same contract as `readUtilitySceneDrag`. */
export function readOverlayPlateDrag(e: DragEvent): number | null {
  const raw = e.dataTransfer.getData(OVERLAY_PLATE_MIME);
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

export function setSongDrag(e: DragEvent, songId: number): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(SONG_MIME, String(songId));
}

/** The dragged song's id, or `null` — `readUtilitySceneDrag`'s contract. */
export function readSongDrag(e: DragEvent): number | null {
  const raw = e.dataTransfer.getData(SONG_MIME);
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

export function classifyExt(ext: string): AssetKind | null {
  const lower = ext.toLowerCase();
  return ASSET_KINDS.find((kind) => ASSET_EXTENSIONS[kind].includes(lower)) ?? null;
}

/** Picked or dropped files, each under the library tab its extension belongs
 *  to; what no tab takes (a `.txt`, a file without an extension) is counted, so
 *  the operator can be told rather than seeing it vanish (owner, 2026-11-06). */
export function sortPathsByKind(paths: readonly string[]): { byKind: Map<AssetKind, string[]>; unsupported: number } {
  const byKind = new Map<AssetKind, string[]>();
  let unsupported = 0;
  for (const path of paths) {
    const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
    const dot = name.lastIndexOf(".");
    const kind = dot === -1 ? null : classifyExt(name.slice(dot + 1));
    if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), path]);
    else unsupported += 1;
  }
  return { byKind, unsupported };
}

/** Resolves OS files dropped from Finder/Explorer to {path, kind}, skipping
 *  extensions we don't recognize — mirrors the legacy `setupDragDrop` filter. */
export function readOsFilesDrag(e: DragEvent): { path: string; kind: AssetKind }[] {
  const out: { path: string; kind: AssetKind }[] = [];
  for (const file of Array.from(e.dataTransfer.files)) {
    const path = window.worship.getPathForFile(file);
    const ext = path.slice(path.lastIndexOf(".") + 1);
    const kind = classifyExt(ext);
    if (kind) out.push({ path, kind });
  }
  return out;
}
