import { useBibleStore } from "@renderer/stores/bible.store";
import { useDeckStore } from "@renderer/stores/deck.store";
import { useLibraryStore } from "@renderer/stores/library.store";
import { usePreviewStore, type PreviewTarget } from "@renderer/stores/preview.store";
import { rowIndexOf, useProgramStore } from "@renderer/stores/program.store";
import type { AssetKind } from "@shared/constants";
import type { ProgramItemDTO } from "@shared/types/program";
import { findSong, resolveSong, themeForSong, useSongStore } from "@renderer/stores/song.store";
import { previewItemVerse } from "@renderer/lib/actions/bible";
import { useSettingsStore } from "@renderer/stores/settings.store";

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

export function previewVerse(verseIndex: number, row?: ProgramItemDTO): void {
  useProgramStore.getState().select(null);
  useLibraryStore.getState().select(null);
  usePreviewStore.getState().setTarget(row ? { kind: "verse", verseIndex, row } : { kind: "verse", verseIndex });
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
    previewVerse(next, target.row);
    return;
  }

  // A Bible row walks out of itself into its chapter, as the Bible tab does.
  const item = target.kind === "scheduleItem" ? previewedScheduleItem() : undefined;
  if (item?.kind === "bible" && item.verseFrom !== null) {
    const verse = direction === 1 ? (item.verseTo ?? item.verseFrom) + 1 : item.verseFrom - 1;
    if (verse >= 1) void previewItemVerse(item, verse);
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

/**
 * What went live leaves PREVIEW (owner, 2026-11-15): with it still there, an extra Enter or a second double click sent
 * it again — the hymn back to its first slide and its music to 0:00 in front of the congregation. Only when PREVIEW
 * still holds `sent`: whatever the operator picked while a deck was being read stays. Not `clearPreview()`, which
 * also drops the live verse's cursor that ←/→ walk on.
 *
 * A schedule `row` leaves the row under it instead, whatever it is (owner, 2026-11-21, `projection.previewNext`, on by
 * default): the next Enter is the next part of the service. Found by id, where the edits made during the wait put it;
 * past the last row, or a row gone, PREVIEW is left empty as before.
 */
export function dropSentPreview(sent: PreviewTarget, row?: ProgramItemDTO): void {
  if (usePreviewStore.getState().target !== sent) return;
  if (row && useSettingsStore.getState().settings["projection.previewNext"]) {
    const at = rowIndexOf(row);
    if (at >= 0 && at + 1 < useProgramStore.getState().items.length) {
      previewScheduleItem(at + 1);
      return;
    }
  }
  useProgramStore.getState().select(null);
  useLibraryStore.getState().select(null);
  usePreviewStore.getState().clear();
}

/** The schedule row PREVIEW holds: the selected one, or the Bible row a verse was walked out of. */
function previewedRow(target: PreviewTarget): ProgramItemDTO | undefined {
  if (target.kind === "scheduleItem") return previewedScheduleItem();
  return target.kind === "verse" ? target.row : undefined;
}

/**
 * «Al terminar: siguiente» sent `sent` on its own after `ended`. A row in PREVIEW from `ended` down to `sent` is behind
 * what is live, and Enter sent it again over it: the hymn from its first slide, or a second background song (owner,
 * 2026-11-22). It goes the way a row sent by hand goes (`dropSentPreview`). A row further down, one above where the
 * chain started (the welcome waiting while the music plays on), or anything else the operator put there, stays.
 */
export function followChain(ended: ProgramItemDTO | undefined, sent: ProgramItemDTO): void {
  const { target } = usePreviewStore.getState();
  const held = target ? previewedRow(target) : undefined;
  if (!target || !held) return;
  const at = rowIndexOf(held);
  const from = ended ? rowIndexOf(ended) : -1;
  const sentAt = rowIndexOf(sent);
  if (at >= 0 && at >= from && sentAt >= 0 && at <= sentAt) dropSentPreview(target, sent);
}

export function clearPreview(): void {
  useProgramStore.getState().select(null);
  useLibraryStore.getState().select(null);
  useBibleStore.getState().setCurrentVerseIndex(null);
  usePreviewStore.getState().clear();
}
