import { api } from "@renderer/lib/api";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { rememberSavedRowIds, useProgramStore } from "@renderer/stores/program.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { previewScheduleItem } from "@renderer/lib/actions/preview";
import type { LiveRowMark } from "@shared/types/settings";
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
function adoptSaved(full: ProgramDTO, sent: ProgramItemDTO[], savedFrom: number | null): void {
  const { currentProgramId, items, selectedIndex, activeIndex } = useProgramStore.getState();
  // Another program opened, or a new one started («Vaciar», «Nuevo programa»)
  // during the round trip: the save landed, but the schedule on screen is not
  // that program and must not take its id — the next «Guardar» would write
  // over it. ponytail: an unsaved schedule replaced by another unsaved one
  // still looks the same (both `null`); a store generation counter if it matters.
  if (currentProgramId !== savedFrom) return;
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
  rememberSavedRowIds(sent, useProgramStore.getState().items);
}

/** Overwrites the currently loaded program with the schedule as it stands —
 *  requires a program to already be loaded (see `createProgramFromCurrent`
 *  for a brand new one). Re-hydrates the store from the saved row afterwards
 *  so item ids and `dirty` reflect what's actually on disk. Says whether
 *  nothing is left unsaved — what a «Guardar y…» prompt (`ConfirmModal`'s
 *  `onSave`) needs before it goes on: a failure, or an edit made during the
 *  round trip, keeps the prompt open. */
export async function saveCurrentProgram(): Promise<boolean> {
  const { currentProgramId, currentProgramName, currentProgramNotes } = useProgramStore.getState();
  if (currentProgramId === null) return false;
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
    adoptSaved(await api.programs.load(summary.id), sent, currentProgramId);
    toast.success(t("programs.saved", { name: summary.name }));
    return !useProgramStore.getState().dirty;
  } catch {
    toast.danger(t("programs.saveError"));
    return false;
  }
}

/** Creates a new saved program from the schedule currently open — the
 *  programs screen's unsaved-schedule row, which is also where the top bar's
 *  «Save» of a program that was never saved lands. With `into`, the schedule
 *  replaces that saved program instead (one of the same name, U13). */
export async function createProgramFromCurrent(meta: ProgramMetaInput, into?: number): Promise<ProgramSummary | null> {
  try {
    const savedFrom = useProgramStore.getState().currentProgramId;
    const { sent, items } = draftItems();
    const summary = await api.programs.save({ ...meta, ...(into === undefined ? {} : { id: into }), items });
    adoptSaved(await api.programs.load(summary.id), sent, savedFrom);
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
 * the anti-eviction pin. The items then come from the draft, not from disk:
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

/**
 * Opens again, at launch, the saved program the schedule held when the app
 * last went away with nothing unsaved — so no draft to restore (owner,
 * 2026-11-06: a restart mid-service left the schedule empty). Silent: the
 * schedule's header names it. A program deleted since leaves the schedule
 * empty and is forgotten, or every launch would try again.
 */
export async function reopenProgram(id: number): Promise<void> {
  try {
    useProgramStore.getState().loadProgram(await api.programs.load(id));
  } catch (error) {
    console.warn("[programs] reopen failed", error);
    void useSettingsStore.getState().update({ "programs.openId": null }).catch(() => undefined);
  }
}

/** Keeps `programs.openId` on the program the schedule holds, for
 *  `reopenProgram` at the next launch, and `programs.liveRow` on the row on air, for `restoreLiveRow`. */
export function startOpenProgramMemory(): () => void {
  // Against what was last written, not the previous state: a save clears the cursor and sets it back
  // (`adoptSaved`), and a reorder moves it without the row changing.
  let written = JSON.stringify(liveRowOf());
  return useProgramStore.subscribe((state, previous) => {
    const mark = liveRowOf();
    if (JSON.stringify(mark) !== written) {
      written = JSON.stringify(mark);
      void useSettingsStore.getState().update({ "programs.liveRow": mark }).catch(() => undefined);
    }
    if (state.currentProgramId === previous.currentProgramId) return;
    void useSettingsStore.getState().update({ "programs.openId": state.currentProgramId }).catch(() => undefined);
  });
}

/** The row each schedule row is, by what a save would send: provisional ids change at every restore and save. */
const rowKeys = (): string[] => toUpsertItems(useProgramStore.getState().items).map((row) => JSON.stringify(row));

/** Only the row on air is turned into its key: this runs on every change of the schedule store, a click included. */
function liveRowOf(): LiveRowMark | null {
  const { activeIndex, items } = useProgramStore.getState();
  const item = activeIndex === null ? undefined : items[activeIndex];
  return activeIndex === null || item === undefined
    ? null
    : { position: activeIndex, row: JSON.stringify(toUpsertItems([item])[0]) };
}

/**
 * At launch, after the schedule is back: a row still marked on air means the app did not close (a crash, a killed
 * process, a power cut, a hung window closed by the grace; a clean close clears it, `forgetLiveRow`). That row goes to
 * PREVIEW exactly as a click on it puts it there, and a GO LIVE takes it back; nothing goes on air by itself (owner,
 * 2026-11-23, DU-6). Found at its place, else as the only row of its kind and content; otherwise nothing is chosen.
 */
export function restoreLiveRow(mark: LiveRowMark | null): void {
  if (mark === null) return;
  const rows = rowKeys();
  const at = rows[mark.position] === mark.row ? mark.position : rows.indexOf(mark.row);
  if (at < 0 || (at !== mark.position && rows.lastIndexOf(mark.row) !== at)) return;
  previewScheduleItem(at);
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
