import { useLibraryStore } from "@renderer/stores/library.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import type { BaseContent } from "@shared/types/projection";
import type { ProgramItemDTO } from "@shared/types/program";
import { api } from "@renderer/lib/api";
import { removeAsset } from "./remove-asset";
import { previewScheduleItem } from "./preview";
import { newProgram } from "./programs";

/** Whether `base` is what `item` puts on the projector. A plate never is: it
 *  goes up over the content and never claims the rail. */
function showsItem(base: BaseContent | null, item: ProgramItemDTO): boolean {
  switch (item.kind) {
    case "ppt":
      return base?.kind === "deck" && base.assetId === item.mediaAssetId;
    case "media":
      return (base?.kind === "video" || base?.kind === "image") && base.assetId === item.mediaAssetId;
    case "bible":
      return base?.kind === "bible" && base.text === item.text && base.reference === item.reference;
    case "utility":
      return base?.kind === "utility" && base.sceneId === item.utilitySceneId;
    case "song":
      return base?.kind === "song" && base.songId === item.songId;
    case "plate":
      return false;
  }
}

/**
 * A toast whose «Deshacer» puts the schedule back, alive only while nothing
 * else has changed it: after «Nuevo programa», opening another one or any
 * other edit — another removal included —, «Deshacer» would put the rows into
 * a different list, so that edit takes the toast down with it (owner,
 * 2026-11-06: a stale one still offered «Deshacer» and did nothing).
 */
function offerScheduleUndo(message: string, undo: () => void): void {
  const after = useProgramStore.getState().items;
  const id = toast.info(message, {
    action: {
      label: t("common.undo"),
      onClick: () => {
        if (useProgramStore.getState().items === after) undo();
      },
    },
  });
  const stop = useProgramStore.subscribe((state) => {
    if (state.items === after) return;
    stop();
    toast.dismiss(id);
  });
}

/** Takes a row out of the order of service and offers it back for a few
 *  seconds (owner, 2026-11-05): Backspace is the key pressed believing a text
 *  field has focus, and it used to remove the row for good. The row comes back
 *  where it was, chosen again — and on air again if it still is: not when
 *  another row went live meanwhile, nor after «Sacar del aire», where a rail
 *  put back would claim a projector that shows something else. */
export function removeScheduleItem(index: number): void {
  const program = useProgramStore.getState();
  const item = program.items[index];
  if (!item) return;
  const wasActive = program.activeIndex === index;
  const wasDirty = program.dirty;
  program.removeAt(index);
  offerScheduleUndo(t("schedule.removed"), () => {
    const store = useProgramStore.getState();
    const onAir = wasActive && store.activeIndex === null && showsItem(useProjectionStore.getState().base, item);
    store.addItem(item, index);
    // Back as it was saved: a newer edit would have taken this offer down.
    if (!wasDirty) useProgramStore.setState({ dirty: false });
    // Chosen the way a click chooses it, so whatever the operator picked
    // since — a library file in PREVIEW — is let go, not left selected too.
    previewScheduleItem(index);
    if (onAir) store.setActive(index);
  });
}

/**
 * «Vaciar»: a NEW, unsaved program (owner, 2026-11-06). Emptying a saved one
 * in place left it the open program, so the next «Guardar» silently wrote
 * the new schedule over it. Offered back like a removed row: the program,
 * its rows, whether it had changes, and the rail if its row is still what the
 * projector shows. Unsaved work is asked about before (`SchedulePanel`).
 */
export function clearSchedule(): void {
  const before = useProgramStore.getState();
  newProgram();
  offerScheduleUndo(t("schedule.cleared"), () => {
    const live = before.activeIndex === null ? undefined : before.items[before.activeIndex];
    useProgramStore.setState({
      currentProgramId: before.currentProgramId,
      currentProgramName: before.currentProgramName,
      currentProgramNotes: before.currentProgramNotes,
      items: before.items,
      dirty: before.dirty,
      selectedIndex: null,
      activeIndex: live && showsItem(useProjectionStore.getState().base, live) ? before.activeIndex : null,
    });
    // Main follows the open program too: history and the decks' pins.
    if (before.currentProgramId !== null) void api.programs.load(before.currentProgramId).catch(() => undefined);
  });
}

/** Delete/Backspace target, same priority as the legacy app: a library
 *  selection wins over a playlist selection. Nothing in a linked folder's
 *  view, where «Quitar» is hidden: its files are the computer's, and removing
 *  one's library row left a dead tile that then failed a program's save. */
export function removeSelected(): void {
  const library = useLibraryStore.getState();
  if (library.selectedId !== null) {
    if (library.activeView[library.activeTab] === "recent") void removeAsset(library.selectedId);
    return;
  }
  const program = useProgramStore.getState();
  if (program.selectedIndex !== null) removeScheduleItem(program.selectedIndex);
}
