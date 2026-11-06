import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { hasUnsavedChanges, toUpsertItems } from "@renderer/lib/actions/programs";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useUiStore, type CloseGuardReasons } from "@renderer/stores/ui.store";
import type { ProgramDraft } from "@shared/types/program";

/** Short enough that the work at risk is a keystroke or two, long enough that
 *  dragging a row across a 40-item schedule is one write and not forty. */
const DEBOUNCE_MS = 600;

let timer: number | null = null;
/** What was last handed to main, so a selection change — which fires the
 *  subscription without changing anything a save would persist — does not
 *  write the same row again. */
let lastWritten: string | null = null;

function currentDraft(): ProgramDraft | null {
  // Exactly `hasUnsavedChanges()`, deliberately: a schedule with nothing in it
  // is not work in progress, and persisting one would mean a stale draft
  // offering to restore emptiness over whatever the operator opens next.
  if (!hasUnsavedChanges()) return null;
  const { currentProgramId, currentProgramName, currentProgramNotes, items } =
    useProgramStore.getState();
  return {
    programId: currentProgramId,
    name: currentProgramName,
    notes: currentProgramNotes,
    items: toUpsertItems(items),
    updatedAt: Date.now(),
  };
}

/** Writes whatever is pending right now, skipping the debounce. */
export function flushDraft(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  const draft = currentDraft();
  // `updatedAt` moves on every call, so it is left out of the comparison —
  // otherwise nothing would ever look unchanged.
  const signature = JSON.stringify(draft && { ...draft, updatedAt: 0 });
  if (signature === lastWritten) return;
  lastWritten = signature;
  void api.draft.save(draft).catch((error: unknown) => {
    // One lost autosave is survivable and a toast about it is not — the next
    // change writes again. Cleared so that retry actually happens.
    lastWritten = null;
    console.warn("[draft] autosave failed", error);
  });
}

/** Something the congregation is looking at: closing the app takes the
 *  projector down with it, so an accidental ⌘Q mid-service has to ask even
 *  with nothing left to save. An open projector showing only the resting logo
 *  does not count. BLACK or LOGO put up on purpose does. */
function isOnAir(): boolean {
  const { presentationOpen, base, overlay, livePlates } = useProjectionStore.getState();
  return presentationOpen && (base !== null || overlay !== "none" || livePlates.length > 0);
}

/** Why quitting right now needs the operator's OK, or `null` when nothing is
 *  at risk. Whatever is still debounced goes to disk first, so "close anyway"
 *  really does mean "it will be there next time" — for the schedule; an open
 *  editor's unsaved changes (`unsavedEditors`) have no draft and are lost.
 *  Asked by main's `close-requested` and by «Restart and update», which quits
 *  the same way. */
export function quitRisks(): CloseGuardReasons | null {
  flushDraft();
  const unsaved = hasUnsavedChanges();
  const editor = useUiStore.getState().unsavedEditors > 0;
  const onAir = isOnAir();
  return unsaved || editor || onAir ? { unsaved, editor, onAir } : null;
}

/**
 * Mirrors the unsaved order of service to SQLite as the operator builds it.
 *
 * It was the only user data in the app with no backing store: everything else
 * reaches the database the moment it changes, while the schedule lived purely
 * in `program.store` — so a reload, a window close, a renderer crash or a
 * power cut threw away what is typically 15-40 minutes of work done before the
 * service. `App` reads it back at launch (`restoreDraft`).
 *
 * Also answers main's `close-requested`: main vetoes the close and asks here,
 * because whether unsaved work may be discarded is the control window's
 * decision, not main's (`main/windows/close-guard.ts`).
 */
export function startDraftAutosave(): () => void {
  const unsubscribe = useProgramStore.subscribe(() => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(flushDraft, DEBOUNCE_MS);
  });

  const stopCloseListener = onIpc("close-requested", () => {
    const risks = quitRisks();
    if (!risks) {
      void api.window.closeDecision("close");
      return;
    }
    // "hold" drops main's grace timer without forgetting the close, so the
    // window is never shut out from under a question the operator is still
    // reading — and the answer still knows whether this started as a quit.
    void api.window.closeDecision("hold");
    useUiStore.getState().setCloseGuard(risks);
  });

  return () => {
    unsubscribe();
    stopCloseListener();
    if (timer !== null) window.clearTimeout(timer);
  };
}
