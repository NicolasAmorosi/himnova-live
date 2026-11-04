import { useEffect, useState, type DragEvent } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Badge, EmptyState, Icon, IconButton, Tooltip } from "@renderer/components/ui";
import { PanelBody, PanelFooter, PanelHeader } from "@renderer/components/shared/panel";
import { useProgramStore } from "@renderer/stores/program.store";
import { useLibraryStore } from "@renderer/stores/library.store";
import { useDeckStore } from "@renderer/stores/deck.store";
import type { DeckStatusSummary } from "@shared/types/deck";
import { api } from "@renderer/lib/api";
import {
  SCHEDULE_INDEX_MIME,
  classifyExt,
  hideDragGhost,
  readBibleVerseDrag,
  readMediaAssetDrag,
  readOsFilesDrag,
  readOverlayPlateDrag,
  readUtilitySceneDrag,
} from "@renderer/lib/dnd";
import { toast } from "@renderer/lib/toast";
import { previewScheduleItem } from "@renderer/lib/actions/preview";
import { goLive } from "@renderer/lib/actions/playback";
import { hasUnsavedChanges } from "@renderer/lib/actions/programs";
import { ScheduleRow } from "./schedule-row";
import type { AssetKind } from "@shared/constants";

/** See the `deck:statuses` effect in `SchedulePanel`. */
const DECK_STATUS_DELAY_MS = 250;

/** The service running order — EasyWorship's "Schedule", top-left. */
export function SchedulePanel() {
  const t = useT();
  // One selector per field, never `useProgramStore()` bare: subscribing to the
  // whole store re-rendered this panel — and with it every row, since
  // `ScheduleRow` takes inline callbacks and can't be memoized — on any write
  // at all, including ones it doesn't read (a title edit, a saved-program id).
  // Zustand's action identities are stable, so selecting them costs nothing.
  const activeIndex = useProgramStore((s) => s.activeIndex);
  const items = useProgramStore((s) => s.items);
  const selectedIndex = useProgramStore((s) => s.selectedIndex);
  const moveDown = useProgramStore((s) => s.moveDown);
  const moveUp = useProgramStore((s) => s.moveUp);
  const removeAt = useProgramStore((s) => s.removeAt);
  const reorder = useProgramStore((s) => s.reorder);
  const addItem = useProgramStore((s) => s.addItem);
  const clear = useProgramStore((s) => s.clear);
  const dirty = useProgramStore((s) => s.dirty);
  const refreshLibrary = useLibraryStore((s) => s.refresh);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Where each deck's first slide lives, for the rows' thumbnails: one
  // `deck:statuses` round-trip for the whole schedule, asked again when a deck
  // finishes reading (every deck added here is read in the background). The
  // delay coalesces a library batch, which finishes decks one at a time; the
  // previous answer stays up meanwhile, so nothing flickers.
  const deckIdsKey = items.flatMap((item) => (item.kind === "ppt" ? [item.mediaAssetId] : [])).join(",");
  const readyEpoch = useDeckStore((s) => s.readyEpoch);
  const [deckStatuses, setDeckStatuses] = useState<Record<number, DeckStatusSummary>>({});
  useEffect(() => {
    if (deckIdsKey === "") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.deck
        .statuses(deckIdsKey.split(",").map(Number))
        .then((statuses) => {
          if (!cancelled) setDeckStatuses(statuses);
        })
        // Not worth a toast: the rows keep their icon, and the next finished
        // deck asks again.
        .catch(() => undefined);
    }, DECK_STATUS_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deckIdsKey, readyEpoch]);

  function addAssetItem(assetId: number, kind: AssetKind, insertAt?: number) {
    addItem(
      kind === "ppt"
        ? { kind: "ppt", mediaAssetId: assetId, title: null }
        : { kind: "media", mediaAssetId: assetId, title: null },
      insertAt,
    );
  }

  async function addPaths(paths: string[], kind: AssetKind, insertAt?: number) {
    const assets = await api.library.add(paths, kind);
    await refreshLibrary(kind);
    // Each added asset is inserted right after the previous one, so a
    // multi-file drop lands as a contiguous run at the drop point instead of
    // reversed or collapsed onto a single position.
    let at = insertAt;
    for (const asset of assets) {
      addAssetItem(asset.id, kind, at);
      if (at !== undefined) at += 1;
    }
  }

  /** One dialog, every supported extension at once — each picked file is then
   *  routed to its own kind by extension, same classifier the OS-file drag
   *  uses, so a single selection can mix PPTs, videos, images and audio. */
  /** Same guard as «New schedule» beside it: unsaved work is only thrown
   *  away when the operator says so. A saved program empties at once — it is
   *  still in «Saved schedules». */
  function handleClear() {
    if (hasUnsavedChanges()) {
      toast.warning(t("programs.discardWarning"), { action: { label: t("schedule.discardAndClear"), onClick: clear } });
      return;
    }
    clear();
  }

  async function handleAddAll() {
    try {
      const paths = await api.files.pick("all", true);
      if (paths.length === 0) return;
      const byKind = new Map<AssetKind, string[]>();
      for (const filePath of paths) {
        const ext = filePath.slice(filePath.lastIndexOf(".") + 1);
        const kind = classifyExt(ext);
        if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), filePath]);
      }
      for (const [kind, kindPaths] of byKind) await addPaths(kindPaths, kind);
    } catch (error) {
      // An unreadable drive, a file removed between the dialog and the import,
      // a database write that failed: the schedule is the operator's running
      // order and silently adding nothing is the one outcome they must not be
      // left guessing about.
      console.error("[schedule] add failed", error);
      toast.danger(t("schedule.addError"));
    }
  }

  function dropTargetIndex(e: DragEvent<HTMLDivElement>): number {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-index]");
    return li ? Number(li.dataset.index) : items.length;
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    // `dragover` fires continuously while the pointer moves — dozens of times
    // a second — and only a change of target row is worth anything.
    const next = dropTargetIndex(e);
    setDragOverIndex((current) => (current === next ? current : next));
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    // `dragleave` also fires when the pointer crosses into a *child* of this
    // panel, which between two rows is constantly — so clearing unconditionally
    // made the drop indicator blink off and on all the way down the list.
    const leavingTo = e.relatedTarget as Node | null;
    if (leavingTo && e.currentTarget.contains(leavingTo)) return;
    setDragOverIndex(null);
  }

  async function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const reorderFrom = e.dataTransfer.getData(SCHEDULE_INDEX_MIME);
    const draggedAsset = readMediaAssetDrag(e);
    const draggedVerse = readBibleVerseDrag(e);
    const draggedScene = readUtilitySceneDrag(e);
    const draggedPlate = readOverlayPlateDrag(e);
    const osFiles = readOsFilesDrag(e);
    const targetIndex = dropTargetIndex(e);
    setDragOverIndex(null);

    if (reorderFrom !== "") {
      reorder(Number(reorderFrom), targetIndex);
      return;
    }
    if (draggedAsset) {
      addAssetItem(draggedAsset.assetId, draggedAsset.kind, targetIndex);
      return;
    }
    if (draggedVerse) {
      addItem({ kind: "bible", ...draggedVerse }, targetIndex);
      return;
    }
    if (draggedScene !== null) {
      addItem({ kind: "utility", utilitySceneId: draggedScene, title: null }, targetIndex);
      return;
    }
    if (draggedPlate !== null) {
      addItem({ kind: "plate", overlayPlateId: draggedPlate, title: null }, targetIndex);
      return;
    }
    const byKind = new Map<AssetKind, string[]>();
    for (const file of osFiles) byKind.set(file.kind, [...(byKind.get(file.kind) ?? []), file.path]);
    try {
      // `at` is a position in the list as it stood when the drop landed, and
      // `addPaths` awaits in between — so the schedule may have moved on. That
      // is bounded rather than guarded: `addItem` clamps `insertAt` to the
      // list's real bounds, so the worst case is a row landing at the end
      // instead of at the drop point, never a hole or a crash.
      let at = targetIndex;
      for (const [kind, paths] of byKind) {
        await addPaths(paths, kind, at);
        at += paths.length;
      }
    } catch (error) {
      console.error("[schedule] drop failed", error);
      toast.danger(t("schedule.addError"));
    }
  }

  return (
    <>
      <PanelHeader
        actions={
          <Tooltip content={dirty ? t("schedule.notSavedHint") : t("schedule.savedHint")} floating>
            <Badge variant={dirty ? "neutral" : "success"}>
              {dirty ? t("schedule.notSaved") : t("schedule.saved")}
            </Badge>
          </Tooltip>
        }
        title={t("schedule.title")}
      />
      <PanelBody
        className="p-1.5"
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={(e) => void handleDrop(e)}
      >
        {items.length === 0 ? (
          <EmptyState description={t("schedule.emptyHint")} icon="layers" title={t("schedule.empty")} />
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.map((item, index) => (
              <ScheduleRow
                active={activeIndex === index}
                deckStatus={item.kind === "ppt" ? deckStatuses[item.mediaAssetId] : undefined}
                dragOver={dragOverIndex === index}
                index={index}
                item={item}
                key={item.id}
                onClick={() => previewScheduleItem(index)}
                onDoubleClick={() => {
                  previewScheduleItem(index);
                  void goLive();
                }}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData(SCHEDULE_INDEX_MIME, String(index));
                  // Same as the saved-programs list: the only drop feedback
                  // here is a horizontal indicator, so the browser's
                  // translucent ghost trailing sideways is pure noise.
                  hideDragGhost(e);
                }}
                selected={selectedIndex === index}
              />
            ))}
          </ul>
        )}
      </PanelBody>
      <PanelFooter>
        <Tooltip align="start" content={t("schedule.addAllHint")} placement="top">
          <IconButton aria-label={t("schedule.addAll")} onClick={() => void handleAddAll()} size="sm" variant="success">
            <Icon name="add" />
          </IconButton>
        </Tooltip>
        <Tooltip align="start" content={t("schedule.removeHint")} placement="top">
          <IconButton
            aria-label={t("schedule.remove")}
            disabled={selectedIndex === null}
            onClick={() => selectedIndex !== null && removeAt(selectedIndex)}
            size="sm"
            variant="warning"
          >
            <Icon name="close" />
          </IconButton>
        </Tooltip>
        <Tooltip align="start" content={t("schedule.moveUpHint")} placement="top">
          <IconButton
            aria-label={t("schedule.moveUp")}
            disabled={selectedIndex === null || selectedIndex === 0}
            onClick={() => selectedIndex !== null && moveUp(selectedIndex)}
            size="sm"
          >
            <Icon name="chevronUp" />
          </IconButton>
        </Tooltip>
        <Tooltip align="start" content={t("schedule.moveDownHint")} placement="top">
          <IconButton
            aria-label={t("schedule.moveDown")}
            disabled={selectedIndex === null || selectedIndex === items.length - 1}
            onClick={() => selectedIndex !== null && moveDown(selectedIndex)}
            size="sm"
          >
            <Icon name="chevronDown" />
          </IconButton>
        </Tooltip>
        <Tooltip className="ml-auto" content={t("schedule.clearHint")} placement="top">
          <IconButton
            aria-label={t("schedule.clear")}
            disabled={items.length === 0}
            onClick={handleClear}
            size="sm"
            variant="danger"
          >
            <Icon name="ban" />
          </IconButton>
        </Tooltip>
      </PanelFooter>
    </>
  );
}
