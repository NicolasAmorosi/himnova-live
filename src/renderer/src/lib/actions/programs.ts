import { api } from "@renderer/lib/api";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { useProgramStore } from "@renderer/stores/program.store";
import type {
  ProgramDraft,
  ProgramDTO,
  ProgramItemDTO,
  ProgramItemUpsert,
  ProgramSummary,
} from "@shared/types/program";

export type ProgramMetaInput = {
  name: string;
  notes: string | null;
  favorite: boolean;
};

/** True when loading a different program, starting a new one, or deleting the
 *  one that's currently open would throw away work — the guard callers (the
 *  programs screen's «Discard and open», or the TopBar's "New schedule" toast) check
 *  before calling `openProgram`/`newProgram`/`deleteProgram` unconditionally. */
export function hasUnsavedChanges(): boolean {
  const { dirty, items } = useProgramStore.getState();
  return dirty && items.length > 0;
}

/**
 * `ProgramItemDTO` -> `ProgramItemUpsert`: the same row minus `id` and
 * `position`, both of which `ProgramsRepo.save()` reassigns from scratch.
 *
 * An explicit switch, not the rest-spread cast (`as never`) this used to be:
 * `Omit` over a discriminated union collapses it to its shared members, so the
 * cast was papering over a genuine hole in the types at the edge of an IPC
 * channel — in a project that forces exhaustiveness everywhere else. The
 * switch also makes adding an item kind a compile error here, which is the
 * point.
 */
export function toUpsertItems(items: ProgramItemDTO[]): ProgramItemUpsert[] {
  return items.map((item) => {
    switch (item.kind) {
      case "media":
      case "ppt":
        return { kind: item.kind, mediaAssetId: item.mediaAssetId, title: item.title };
      case "utility":
        return { kind: "utility", utilitySceneId: item.utilitySceneId, title: item.title };
      case "plate":
        return { kind: "plate", overlayPlateId: item.overlayPlateId, title: item.title };
      case "song":
        return { kind: "song", songId: item.songId, title: item.title };
      case "bible":
        return {
          kind: "bible",
          bibleVersionId: item.bibleVersionId,
          bibleBookId: item.bibleBookId,
          chapter: item.chapter,
          verseFrom: item.verseFrom,
          verseTo: item.verseTo,
          reference: item.reference,
          text: item.text,
        };
    }
  });
}

/** The schedule as it is about to be sent, and the exact array it came from —
 *  which is how `adoptSaved` tells whether the operator edited it meanwhile:
 *  every edit to the schedule replaces `items` with a new array. */
function draftItems(): { sent: ProgramItemDTO[]; items: ProgramItemUpsert[] } {
  const sent = useProgramStore.getState().items;
  return { sent, items: toUpsertItems(sent) };
}

/**
 * Swaps in the schedule as saved — real ids replace the provisional ones —
 * while the operator stays where they were. A save is not an open: the same
 * row is still selected and previewed, and the rail still marks what is on
 * the projector. `loadProgram` clears both cursors, which is right only for
 * an open. Before a PREVIEW of a schedule row read the selection, a save
 * already dropped the rail; after it, a save would also have blanked PREVIEW.
 */
function adoptSaved(full: ProgramDTO, sent: ProgramItemDTO[]): void {
  const { items, selectedIndex, activeIndex } = useProgramStore.getState();
  if (items !== sent) {
    // Edited during the round trip (a row dropped in, a reorder). Adopting
    // the saved rows would throw that edit away AND mark the schedule saved,
    // so no draft would keep it either. The program is now this saved one —
    // name and id — but the schedule on screen stays, still unsaved.
    useProgramStore.setState({
      currentProgramId: full.id,
      currentProgramName: full.name,
      currentProgramNotes: full.notes,
      dirty: true,
    });
    return;
  }
  useProgramStore.getState().loadProgram(full);
  useProgramStore.setState({ selectedIndex, activeIndex });
}

/** Overwrites the currently loaded program with the schedule as it stands —
 *  requires a program to already be loaded (see `createProgramFromCurrent`
 *  for a brand new one). Re-hydrates the store from the saved row afterwards
 *  so item ids and `dirty` reflect what's actually on disk. */
export async function saveCurrentProgram(): Promise<void> {
  const { currentProgramId, currentProgramName, currentProgramNotes } = useProgramStore.getState();
  if (currentProgramId === null) return;
  try {
    const { sent, items } = draftItems();
    const summary = await api.programs.save({
      id: currentProgramId,
      name: currentProgramName,
      notes: currentProgramNotes,
      // `favorite` is intentionally omitted — this store never tracks it, and
      // ProgramsRepo.save() only writes the field when it's actually present,
      // so the star set from the programs modal survives a quick save.
      items,
    });
    adoptSaved(await api.programs.load(summary.id), sent);
    toast.success(t("programs.saved", { name: summary.name }));
  } catch {
    toast.danger(t("programs.saveError"));
  }
}

/** Creates a new saved program from the schedule currently open — the
 *  programs screen's unsaved-schedule row, which is also where the top bar's
 *  «Save» of a program that was never saved lands. */
export async function createProgramFromCurrent(meta: ProgramMetaInput): Promise<ProgramSummary | null> {
  try {
    const { sent, items } = draftItems();
    const summary = await api.programs.save({ ...meta, items });
    adoptSaved(await api.programs.load(summary.id), sent);
    toast.success(t("programs.saved", { name: summary.name }));
    return summary;
  } catch {
    toast.danger(t("programs.createError"));
    return null;
  }
}

/** Creates a brand new, empty program — used by the programs list's "+"
 *  button, independent of whatever schedule happens to be open. Loads it into
 *  the schedule only when `openAfter` is true; the caller is responsible for
 *  checking `hasUnsavedChanges()` first when it intends to pass `true`. */
export async function createProgram(meta: ProgramMetaInput, openAfter: boolean): Promise<ProgramSummary | null> {
  try {
    const summary = await api.programs.save({ ...meta, items: [] });
    if (openAfter) {
      const full = await api.programs.load(summary.id);
      useProgramStore.getState().loadProgram(full);
    }
    toast.success(t("programs.saved", { name: summary.name }));
    return summary;
  } catch {
    toast.danger(t("programs.createError"));
    return null;
  }
}

/** Renames/edits a program's metadata without touching its items or loading
 *  it — works on any saved program, not just the one currently open. */
export async function updateProgramMeta(id: number, meta: ProgramMetaInput): Promise<ProgramSummary | null> {
  try {
    const summary = await api.programs.updateMeta({ id, ...meta });
    if (id === useProgramStore.getState().currentProgramId) {
      useProgramStore.getState().setProgramMeta(meta);
    }
    toast.success(t("programs.updated", { name: summary.name }));
    return summary;
  } catch {
    toast.danger(t("programs.updateError"));
    return null;
  }
}

/** Copies a program's header + items under the given metadata — chosen by the
 *  user from the programs screen's «⋯ › Duplicate», prefilled with a "(copy)"
 *  name suggestion and the source's own notes/favorite. Never touches the
 *  currently loaded program. */
export async function duplicateProgram(id: number, meta: ProgramMetaInput): Promise<ProgramSummary | null> {
  try {
    const summary = await api.programs.duplicate({ id, ...meta });
    toast.success(t("programs.saved", { name: summary.name }));
    return summary;
  } catch {
    toast.danger(t("programs.duplicateError"));
    return null;
  }
}

/** Flips a saved program's favorite flag from the programs list — no success
 *  toast, since the star itself is the feedback; only a failure needs one. */
export async function setProgramFavorite(id: number, favorite: boolean): Promise<ProgramSummary | null> {
  try {
    return await api.programs.setFavorite({ id, favorite });
  } catch {
    toast.danger(t("programs.favoriteError"));
    return null;
  }
}

/** Persists the manual list order after a drag. `ids` is the whole list in
 *  its new order; the returned list is what actually got stored, so the caller
 *  can replace its optimistic state with it (or `null` on failure, meaning the
 *  caller should re-read the list rather than keep a lie on screen). */
export async function reorderPrograms(ids: number[]): Promise<ProgramSummary[] | null> {
  try {
    return await api.programs.reorder(ids);
  } catch {
    toast.danger(t("programs.reorderError"));
    return null;
  }
}

/** Loads a saved program into the schedule. Callers must check
 *  `hasUnsavedChanges()` first — this never asks on its own. */
export async function openProgram(id: number): Promise<void> {
  try {
    const full = await api.programs.load(id);
    useProgramStore.getState().loadProgram(full);
  } catch {
    toast.danger(t("programs.loadError"));
  }
}

/** Deletes a saved program. If it was the one currently open, the schedule
 *  resets to a new, unsaved program instead of pointing at a row that no
 *  longer exists. */
export async function deleteProgram(id: number): Promise<void> {
  try {
    const wasCurrent = id === useProgramStore.getState().currentProgramId;
    await api.programs.delete(id);
    if (wasCurrent) useProgramStore.getState().newProgram();
    toast.success(t("programs.deleted"));
  } catch {
    toast.danger(t("programs.deleteError"));
  }
}

/**
 * Puts back the schedule the operator was editing when the app last went away.
 *
 * A draft of a SAVED program has to adopt it in main as well, or the restored
 * service looks right and behaves like a program nobody opened: its decks lose
 * the anti-eviction pin and every `projection_history` row written from there
 * on goes unattributed. The items then come from the draft, not from disk —
 * that is the whole point of restoring one.
 */
export async function restoreDraft(draft: ProgramDraft): Promise<void> {
  if (draft.programId !== null) {
    await api.programs.load(draft.programId).catch(() => null);
  }
  useProgramStore.getState().restoreDraft(draft);
  // Announced from here rather than from `App`, for the same reason as the
  // removal toast: a message belongs with the action that earns it, not with
  // whichever component happened to call it.
  toast.info(t("schedule.draftRestored"));
}

/** Starts a brand new, unsaved program. Callers must check
 *  `hasUnsavedChanges()` first — this never asks on its own. */
export function newProgram(): void {
  useProgramStore.getState().newProgram();
  // Main keeps its own notion of "the current program" for history attribution
  // and deck pinning, and nothing used to tell it the schedule had been reset:
  // every verse and slide sent live afterwards was recorded against the
  // previous service. Deliberately not surfaced to the operator — a failure
  // here misfiles a history row, which is not worth a toast over the schedule
  // they just cleared.
  void api.programs.releaseCurrent().catch((error: unknown) => {
    console.error("[programs] releaseCurrent failed", error);
  });
}
