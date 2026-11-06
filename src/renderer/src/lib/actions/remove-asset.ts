import { api } from "@renderer/lib/api";
import { IpcError } from "@shared/ipc/result";
import type { MediaAsset, MediaAssetUsage } from "@shared/types/media";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { forgetMediaAsset } from "@renderer/lib/hooks/use-media-asset";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useLibraryStore } from "@renderer/stores/library.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useUiStore } from "@renderer/stores/ui.store";
import { clearBaseContent } from "./playback";
import { clearPreview } from "./preview";
import { TOAST_DURATION_MS } from "@renderer/stores/toast.store";

/** How long the operator has to take a removal back: the toast's own life, so
 *  every toast lasts the same (owner, 2026-11-05). */
const UNDO_WINDOW_MS = TOAST_DURATION_MS;

/**
 * A deleted asset can be referenced by five independent stores (the open
 * schedule, what's on the projector, the preview target, a live audio track,
 * and the id->MediaAsset cache behind schedule-row labels) — none of which
 * `library:remove` itself knows about. This runs after ANY successful
 * delete, forced or not, so nothing keeps pointing at a row that's gone.
 */
function purgeAsset(id: number): void {
  useProgramStore.getState().removeByMediaAsset(id);

  const base = useProjectionStore.getState().base;
  if (base && "assetId" in base && base.assetId === id) clearBaseContent();

  const target = usePreviewStore.getState().target;
  if (target?.kind === "asset" && target.assetId === id) clearPreview();

  for (const track of useAudioStore.getState().tracks) {
    if (track.assetId === id) useAudioStore.getState().removeTrack(track.trackId);
  }

  forgetMediaAsset(id);
}

/**
 * The "a saved program still uses this" rejection, raised from the action
 * rather than from a component.
 *
 * It used to be handed to the UI as `library.blockedAssetId` and consumed in a
 * `useEffect` inside `MediaBrowser` — correct while exactly one `MediaBrowser`
 * existed, which stopped being true when the resource tabs started staying
 * mounted once visited (`M43`, media-chain audit). A one-shot event parked in
 * global state fires once per mounted consumer: the operator saw this toast
 * four times, and four toasts pushed in one commit empty the whole stack
 * (`MAX_TOASTS = 4`, oldest evicted) — taking with them whatever warning was
 * already on screen, typically "this file will not play", which is the one
 * that can least afford to disappear mid-service.
 *
 * Raised here it fires exactly once per operator gesture by construction, no
 * matter how many panels are mounted. The general rule, which holds for the
 * whole renderer: a one-shot event kept in a global store cannot be consumed
 * in the effect of a component that may be mounted more than once.
 */
function offerForcedRemoval(id: number): void {
  toast.danger(t("library.removeBlocked"), {
    action: {
      label: t("library.removeAnyway"),
      onClick: () => useUiStore.getState().setRemoveAssetConfirmId(id),
    },
  });
}

/**
 * Removals the operator has asked for but that have NOT been sent to main yet.
 *
 * The undo is a real undo because nothing has happened: `library:remove` is
 * only invoked when the window closes. Restoring a deleted row instead —
 * re-importing by path — would hand back a DIFFERENT asset: a new id, and with
 * it the linked audio track, the `inLibrary` flag and the row's place in the
 * unsaved service order all gone. A toast that offers "Undo" has to mean
 * it.
 *
 * The one thing deferral moves rather than removes: if the asset is on the
 * projector, it comes down when the window closes rather than instantly. For
 * the case this exists for — Delete pressed with the wrong panel selected —
 * that is the point: undo within the window and the projector never flinches.
 */
type PendingRemoval = { timer: number; toastId: string };
const pending = new Map<number, PendingRemoval>();

function clearPending(id: number): void {
  const entry = pending.get(id);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  pending.delete(id);
  toast.dismiss(entry.toastId);
}

function undoRemoval(id: number): void {
  clearPending(id);
  const library = useLibraryStore.getState();
  library.endPendingRemoval(id);
  // Back exactly where it was, selection included — the operator was pointing
  // at it a second ago and is most likely about to do something else with it.
  library.select(id);
}

async function commitRemoval(id: number): Promise<void> {
  pending.delete(id);
  try {
    await api.library.remove(id);
  } catch (error) {
    // The undo window is long enough for the operator to have saved a program
    // that references this asset in the meantime, so the in-use rejection is
    // still reachable here and still has to surface as the "remove
    // anyway" offer rather than as an unhandled rejection. The row comes
    // back to the grid: it was never deleted.
    useLibraryStore.getState().endPendingRemoval(id);
    if (error instanceof IpcError && error.code === "MEDIA_ASSET_IN_USE") {
      offerForcedRemoval(id);
      return;
    }
    throw error;
  }
  purgeAsset(id);
  // Refresh BEFORE dropping the id: `byKind` still holds the deleted row until
  // the fresh list lands, so unhiding first would flash it back onto the grid
  // for a frame. And `activeTab` is re-read rather than captured — the operator
  // can change tabs during the round-trip.
  const library = useLibraryStore.getState();
  await library.refresh(library.activeTab);
  useLibraryStore.getState().endPendingRemoval(id);
}

/** The library "remove" button and the Delete/Backspace shortcut both call
 *  this. An asset a saved program still uses goes straight to the existing
 *  forced-confirm flow (`offerForcedRemoval` -> `RemoveAssetConfirm`), because
 *  that one really does need a decision. Everything else disappears from the
 *  grid at once and is only actually deleted `UNDO_WINDOW_MS` later. */
export async function removeAsset(id: number): Promise<void> {
  if (pending.has(id)) return;

  // Asked of main rather than read off the grid: the Delete shortcut fires on
  // whatever the library has selected, which in a linked-folder view is a row
  // that was never in `byKind` at all.
  let usages: MediaAssetUsage[];
  let asset: MediaAsset | null;
  try {
    [usages, asset] = await Promise.all([api.library.usages(id), api.library.get(id)]);
  } catch {
    // Can't tell whether it's in use: fall back to letting main decide, which
    // is what the non-deferred path always did.
    usages = [];
    asset = null;
  }

  const library = useLibraryStore.getState();
  if (usages.length > 0) {
    offerForcedRemoval(id);
    return;
  }

  library.beginPendingRemoval(id);
  library.select(null);

  const toastId = toast.info(
    asset ? t("library.removeUndo", { name: asset.name }) : t("library.removeUndoGeneric"),
    {
      action: { label: t("common.undo"), onClick: () => undoRemoval(id) },
      durationMs: UNDO_WINDOW_MS,
    },
  );
  const timer = window.setTimeout(() => {
    // A pointer resting on the toast holds its count, not this timer: once the
    // file is gone, a «Deshacer» left on screen would undo nothing.
    toast.dismiss(toastId);
    void commitRemoval(id);
  }, UNDO_WINDOW_MS);
  pending.set(id, { timer, toastId });
}

/** The "Remove anyway" escape hatch — same cleanup as `removeAsset`,
 *  but bypasses the in-use guard by also deleting the referencing
 *  `program_items` (main-side, in one transaction — see
 *  `main/services/media-asset-removal.ts`). Not deferred: the operator has
 *  just read a list of the programs this breaks and confirmed anyway, so a
 *  second chance to take it back would only be noise. */
export async function forceRemoveAsset(id: number): Promise<void> {
  clearPending(id);
  await api.library.remove(id, true);
  purgeAsset(id);
  useLibraryStore.getState().endPendingRemoval(id);
  await useLibraryStore.getState().refresh(useLibraryStore.getState().activeTab);
  useLibraryStore.getState().select(null);
}
