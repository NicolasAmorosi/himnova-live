import { useLibraryStore } from "@renderer/stores/library.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { removeAsset } from "./remove-asset";

/** Takes a row out of the order of service and offers it back for a few
 *  seconds (owner, 2026-11-05): Backspace is the key pressed believing a text
 *  field has focus, and it used to remove the row for good. The row comes back
 *  where it was, chosen again — and on air again if it was. Only while nothing
 *  else has changed the schedule: after «Nuevo programa», opening another one
 *  or any other edit, «Deshacer» would put the row into a different list. */
export function removeScheduleItem(index: number): void {
  const program = useProgramStore.getState();
  const item = program.items[index];
  if (!item) return;
  const wasActive = program.activeIndex === index;
  program.removeAt(index);
  const after = useProgramStore.getState().items;
  toast.info(t("schedule.removed"), {
    action: {
      label: t("common.undo"),
      onClick: () => {
        const store = useProgramStore.getState();
        if (store.items !== after) return;
        store.addItem(item, index);
        useProgramStore.setState({ selectedIndex: index, ...(wasActive ? { activeIndex: index } : {}) });
      },
    },
  });
}

/** Delete/Backspace target, same priority as the legacy app: a library
 *  selection wins over a playlist selection. */
export function removeSelected(): void {
  const library = useLibraryStore.getState();
  if (library.selectedId !== null) {
    void removeAsset(library.selectedId);
    return;
  }
  const program = useProgramStore.getState();
  if (program.selectedIndex !== null) removeScheduleItem(program.selectedIndex);
}
