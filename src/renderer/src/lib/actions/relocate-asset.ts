import { api } from "@renderer/lib/api";
import { forgetMediaAsset } from "@renderer/lib/hooks/use-media-asset";
import { loadPlates } from "@renderer/lib/actions/overlays";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { useLibraryStore } from "@renderer/stores/library.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { loadSongs, refreshSongFolder, songView } from "@renderer/lib/actions/songs";
import { ASSET_KINDS } from "@shared/constants";
import type { MergedAsset } from "@shared/types/media";

/**
 * Points a library row at the file the operator moved, keeping its id, and
 * everything else the same move left behind (owner, 2026-11-13: one «Locate…»
 * for a whole moved folder, drive or computer; `services/relocate-move.ts`).
 *
 * The whole point of repairing rather than re-importing: the id is what the
 * saved programs, the unsaved order of service and the linked audio track all
 * reference. A re-import would be a different asset and would leave every one
 * of those pointing at a row that is still missing.
 *
 * The file picker itself lives in main (`library:relocate`) — it is the only
 * side that can open one, and it is also where the choice is checked against
 * the row's kind. `null` means the operator closed the dialog, which is not an
 * outcome worth a toast.
 *
 * The toast is raised here, from the gesture, rather than in whichever panel
 * offered the button: the same rule `F1` established — a panel can be mounted
 * more than once, an operator gesture happens once.
 */
export async function relocateAsset(assetId: number): Promise<void> {
  try {
    const result = await api.library.relocate(assetId);
    if (result === null) return;
    followMerges(result.merged);
    // The grids reload from main's own `library-changed` broadcast; this cache
    // is module-level and nobody else invalidates it.
    forgetMediaAsset(assetId);
    if (result.more > 0) await followMovedFolders();
    const name = result.asset.name;
    toast.success(
      result.more > 0 ? t("library.relocatedMore", { name, count: result.more }) : t("library.relocated", { name }),
    );
  } catch (error) {
    console.error("[library] relocate failed", error);
    toast.danger(t("library.relocateFailed"));
  }
}

/** A linked folder (Media's or Songs') that is gone, found where the operator
 *  picks: it, and everything else the same move left behind. */
export async function relocateFolder(folder: string): Promise<void> {
  try {
    const result = await api.library.relocateFolder(folder);
    if (result === null) return;
    followMerges(result.merged);
    await followMovedFolders();
    toast.success(t("library.folderRelocated", { name: result.name, count: result.more }));
  } catch (error) {
    console.error("[library] relocate folder failed", error);
    toast.danger(t("library.relocateFolderFailed"));
  }
}

/**
 * Rows main merged into their twins are gone: what pointed at one points at its twin now, the open order of service
 * (and with it its draft), PREVIEW, the library's selection and the saved plates (main moved their pictures). Left on
 * the dead id, «Guardar» failed on its foreign key, the draft dropped those rows at the next launch and they showed
 * as «…», and saving a plate whose picture was the twin failed too (2026-11-15 audit, D4). What is on the air keeps
 * the id it went out with: nothing the room sees may move because the operator relocated a file.
 */
export function followMerges(merged: readonly MergedAsset[]): void {
  for (const { from, to } of merged) {
    useProgramStore.getState().remapMediaAsset(from, to);
    const { target } = usePreviewStore.getState();
    if (target?.kind === "asset" && target.assetId === from) usePreviewStore.setState({ target: { ...target, assetId: to } });
    if (useLibraryStore.getState().selectedId === from) useLibraryStore.getState().select(to);
  }
  if (merged.length > 0) void loadPlates();
}

/** Main moved linked folders, and the views open on them, in settings: read
 *  them again, and read the open folders again, moved or back where they were. */
async function followMovedFolders(): Promise<void> {
  await useSettingsStore.getState().load();
  const { settings } = useSettingsStore.getState();
  const library = useLibraryStore.getState();
  library.hydrateActiveViews(settings["library.activeView"], settings["library.linkedFolders"]);
  const { activeView } = useLibraryStore.getState();
  for (const kind of ASSET_KINDS) if (activeView[kind] !== "recent") void library.refreshFolder(kind, activeView[kind]);
  const view = songView();
  if (view !== "library") void refreshSongFolder(view);
  await loadSongs();
}
