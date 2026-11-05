import { useBibleStore } from "@renderer/stores/bible.store";
import { useDeckStore } from "@renderer/stores/deck.store";
import { useLibraryStore } from "@renderer/stores/library.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import type { AssetKind } from "@shared/constants";
import type { ProgramItemDTO } from "@shared/types/program";
import { findSong, resolveSong, themeForSong, useSongStore } from "@renderer/stores/song.store";

/**
 * Selecting something only ever previews it — nothing here touches
 * `projection.store`. Sending it to the projector is `goLive()`'s job
 * (lib/actions/playback.ts), which is the whole point of the two-stage flow.
 *
 * These live in the actions layer because a selection spans stores: the panel
 * that owns the highlight, the panels that must drop theirs, and the preview
 * cursor.
 */

export function previewScheduleItem(index: number): void {
  useProgramStore.getState().select(index);
  useLibraryStore.getState().select(null);
  usePreviewStore.getState().setTarget({ kind: "scheduleItem" });
}

export function previewVerse(verseIndex: number): void {
  useProgramStore.getState().select(null);
  useLibraryStore.getState().select(null);
  usePreviewStore.getState().setTarget({ kind: "verse", verseIndex });
}

export function previewAsset(assetId: number, assetKind: AssetKind): void {
  useProgramStore.getState().select(null);
  useLibraryStore.getState().select(assetId);
  usePreviewStore.getState().setTarget({ kind: "asset", assetId, assetKind });
}

/** A saved utility scene. Deliberately does NOT arm or start its timer:
 *  selecting is never acting, and a countdown that started because somebody
 *  clicked a row is a countdown nobody asked for. Starting it is the
 *  transport's job, or `goLive()`'s. */
export function previewUtilityScene(sceneId: number): void {
  useProgramStore.getState().select(null);
  useLibraryStore.getState().select(null);
  usePreviewStore.getState().setTarget({ kind: "utility", sceneId });
}

/** A saved overlay plate. Putting it up is `goLive()`'s job, like everything
 *  else — see `goLiveWithPlate`. */
export function previewPlate(plateId: number): void {
  useProgramStore.getState().select(null);
  useLibraryStore.getState().select(null);
  usePreviewStore.getState().setTarget({ kind: "plate", plateId });
}

/** A song from the Songs tab. */
export function previewSong(songId: number): void {
  useProgramStore.getState().select(null);
  useLibraryStore.getState().select(null);
  usePreviewStore.getState().setTarget({ kind: "song", songId });
}

/** The song behind the preview target, from the Songs tab or a schedule row. */
export function previewSongId(): number | null {
  const target = usePreviewStore.getState().target;
  if (target?.kind === "song") return target.songId;
  if (target?.kind !== "scheduleItem") return null;
  const item = previewedScheduleItem();
  return item?.kind === "song" ? item.songId : null;
}

export function setPreviewSlide(index: number): void {
  usePreviewStore.getState().setSlideIndex(index);
}

/**
 * The deck behind the current preview target, whether it came from the
 * schedule or straight from the library. Shared by the cursor logic and the
 * preview position readout so "which deck am I previewing" has one answer.
 */
export function previewDeckAssetId(): number | null {
  const target = usePreviewStore.getState().target;
  if (target?.kind === "asset") return target.assetKind === "ppt" ? target.assetId : null;
  if (target?.kind !== "scheduleItem") return null;
  const item = previewedScheduleItem();
  return item?.kind === "ppt" ? item.mediaAssetId : null;
}

/** The schedule row a `scheduleItem` preview target points at: the selected
 *  one, wherever the program's edits have moved it. */
export function previewedScheduleItem(): ProgramItemDTO | undefined {
  const { items, selectedIndex } = useProgramStore.getState();
  return selectedIndex === null ? undefined : items[selectedIndex];
}

/** Moves the preview cursor — a deck slide or a verse — without touching the
 *  projector. Bound to the preview monitor's arrows and to ↑/↓. */
export function advancePreview(direction: 1 | -1): void {
  const { setSlideIndex, slideIndex, target } = usePreviewStore.getState();
  if (!target) return;

  if (target.kind === "verse") {
    const next = target.verseIndex + direction;
    if (next < 0 || next >= useBibleStore.getState().verses.length) return;
    previewVerse(next);
    return;
  }

  const songId = previewSongId();
  const song = songId === null ? null : findSong(useSongStore.getState().songs, songId);
  const assetId = previewDeckAssetId();
  if (!song && assetId === null) return;
  const total = song
    ? resolveSong(song, themeForSong(song, useSongStore.getState().themes)).slides.length
    : (useDeckStore.getState().byAssetId[assetId ?? -1]?.deck?.slides.length ?? 0);
  const next = slideIndex + direction;
  if (next < 1 || next > total) return;
  setSlideIndex(next);
}

export function clearPreview(): void {
  useProgramStore.getState().select(null);
  useLibraryStore.getState().select(null);
  useBibleStore.getState().setCurrentVerseIndex(null);
  usePreviewStore.getState().clear();
}
