import { create } from "zustand";
import { ASSET_KINDS, type AssetKind } from "@shared/constants";
import type { ImportProgress, MediaAsset } from "@shared/types/media";
import { api } from "@renderer/lib/api";
import { IpcError } from "@shared/ipc/result";
import { t } from "@renderer/lib/i18n/i18n-provider";

/** A resource tab's source view: either the added-to-library list, or one of
 *  its linked folders (see `settings["library.linkedFolders"]`), addressed
 *  by its absolute path. */
// `string & {}` rather than a plain `string`: the union would otherwise
// collapse and the literal would stop being suggested. It is the sentinel that
// carries the meaning here, so losing it from autocomplete loses the type's
// entire documentation value.
export type MediaSourceView = "recent" | (string & {});

export function folderAssetsKey(kind: AssetKind, folderPath: string): string {
  return `${kind}::${folderPath}`;
}

/** Per-view load state, keyed the same way the lists are (`kind` for the
 *  library list, `folderAssetsKey(kind, path)` for a linked folder).
 *
 *  It exists because "no rows" and "no rows YET" are not the same thing and
 *  the grid was showing the empty state for both: a linked folder holding 600
 *  files rendered "no resources" for as long as `library:listFolder` took
 *  to answer, which on a network share is seconds. And a rejected read showed
 *  the same thing — an unhandled rejection with the UI claiming the folder was
 *  empty. */
export type ViewStatus = { error: string | null; loading: boolean };

type LibraryStoreState = {
  activeTab: AssetKind;
  byKind: Record<AssetKind, MediaAsset[]>;
  activeView: Record<AssetKind, MediaSourceView>;
  folderAssets: Record<string, MediaAsset[]>;
  /** Keyed by `kind` (library list) or `folderAssetsKey(...)` (linked folder). */
  viewStatus: Record<string, ViewStatus>;
  selectedId: number | null;
  /** Assets the operator has deleted but whose delete has NOT been sent yet —
   *  see `lib/actions/remove-asset.ts`. They are hidden from every grid while
   *  the undo toast is up, so the removal LOOKS immediate while remaining
   *  free to cancel: nothing is destroyed until the window closes. An array
   *  rather than a Set so the store stays comparable by reference for
   *  Zustand's default equality. */
  pendingRemovalIds: number[];
  /** Only surfaced for a batch big enough that it needs it — see
   *  `library-import.ts`'s `PROGRESS_THRESHOLD` on the main side. */
  imports: ImportProgress | null;
  setActiveTab: (tab: AssetKind) => void;
  refresh: (kind: AssetKind) => Promise<void>;
  addFiles: (paths: string[], kind: AssetKind) => Promise<void>;
  applyImportProgress: (progress: ImportProgress) => void;
  clearImportProgress: () => void;
  beginPendingRemoval: (id: number) => void;
  endPendingRemoval: (id: number) => void;
  select: (id: number | null) => void;
  setActiveView: (kind: AssetKind, view: MediaSourceView) => void;
  refreshFolder: (kind: AssetKind, folderPath: string) => Promise<void>;
  /** Drops a linked folder's cached listing. `folderAssets` had no eviction at
   *  all: every folder ever browsed kept its full `MediaAsset[]` alive for the
   *  session, and unlinking one didn't release it either. */
  forgetFolder: (kind: AssetKind, folderPath: string) => void;
  /** Restores each kind's last-selected view from settings on launch,
   *  dropping a persisted folder that was unlinked (or never existed)
   *  since — that path no longer has a button to select in the bar. */
  hydrateActiveViews: (
    persisted: Record<AssetKind, string>,
    linkedFolders: Record<AssetKind, string[]>,
  ) => void;
};

/** Monotonic request ids per view key. `invoke` has no cancellation, so two
 *  reads of the same view can resolve out of order (the mount's own `refresh`
 *  plus one triggered by `library-changed`, say) and the slower one would win
 *  — leaving a stale list on screen with no way to tell. */
const requestSeq = new Map<string, number>();

function nextSeq(key: string): number {
  const seq = (requestSeq.get(key) ?? 0) + 1;
  requestSeq.set(key, seq);
  return seq;
}

function isCurrent(key: string, seq: number): boolean {
  return requestSeq.get(key) === seq;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useLibraryStore = create<LibraryStoreState>((set, get) => ({
  activeTab: "video",
  byKind: { video: [], image: [], audio: [], ppt: [] },
  activeView: { video: "recent", image: "recent", audio: "recent", ppt: "recent" },
  folderAssets: {},
  viewStatus: {},
  selectedId: null,
  pendingRemovalIds: [],
  imports: null,

  setActiveTab: (activeTab) => set({ activeTab, selectedId: null }),

  refresh: async (kind) => {
    const seq = nextSeq(kind);
    set((state) => ({
      viewStatus: { ...state.viewStatus, [kind]: { error: null, loading: true } },
    }));
    try {
      const assets = await api.library.list(kind);
      if (!isCurrent(kind, seq)) return;
      set((state) => ({
        byKind: { ...state.byKind, [kind]: assets },
        viewStatus: { ...state.viewStatus, [kind]: { error: null, loading: false } },
      }));
    } catch (error) {
      if (!isCurrent(kind, seq)) return;
      set((state) => ({
        viewStatus: { ...state.viewStatus, [kind]: { error: messageOf(error), loading: false } },
      }));
    }
  },

  addFiles: async (paths, kind) => {
    await api.library.add(paths, kind);
    await get().refresh(kind);
  },

  applyImportProgress: (progress) => set({ imports: progress }),
  clearImportProgress: () => set({ imports: null }),


  beginPendingRemoval: (id) =>
    set((state) =>
      state.pendingRemovalIds.includes(id)
        ? state
        : { pendingRemovalIds: [...state.pendingRemovalIds, id] },
    ),

  endPendingRemoval: (id) =>
    set((state) =>
      state.pendingRemovalIds.includes(id)
        ? { pendingRemovalIds: state.pendingRemovalIds.filter((pending) => pending !== id) }
        : state,
    ),

  select: (selectedId) => set({ selectedId }),

  setActiveView: (kind, view) =>
    set((state) => ({ activeView: { ...state.activeView, [kind]: view }, selectedId: null })),

  refreshFolder: async (kind, folderPath) => {
    const key = folderAssetsKey(kind, folderPath);
    const seq = nextSeq(key);
    set((state) => ({
      viewStatus: { ...state.viewStatus, [key]: { error: null, loading: true } },
    }));
    try {
      const assets = await api.library.listFolder(kind, folderPath);
      if (!isCurrent(key, seq)) return;
      set((state) => ({
        folderAssets: { ...state.folderAssets, [key]: assets },
        viewStatus: { ...state.viewStatus, [key]: { error: null, loading: false } },
      }));
    } catch (error) {
      if (!isCurrent(key, seq)) return;
      const message =
        error instanceof IpcError && error.code === "FOLDER_MISSING" ? t("library.folderMissing") : messageOf(error);
      // The old listing goes with the failed read: kept, a folder gone from
      // the disk went on showing its files — pickable, sendable, savable into
      // a program — and the grid, which says why only when it has nothing to
      // show, never said it.
      set((state) => {
        const { [key]: _stale, ...folderAssets } = state.folderAssets;
        return { folderAssets, viewStatus: { ...state.viewStatus, [key]: { error: message, loading: false } } };
      });
    }
  },

  forgetFolder: (kind, folderPath) => {
    const key = folderAssetsKey(kind, folderPath);
    requestSeq.delete(key);
    set((state) => {
      if (!(key in state.folderAssets) && !(key in state.viewStatus)) return state;
      const folderAssets = { ...state.folderAssets };
      const viewStatus = { ...state.viewStatus };
      delete folderAssets[key];
      delete viewStatus[key];
      return { folderAssets, viewStatus };
    });
  },

  hydrateActiveViews: (persisted, linkedFolders) =>
    set((state) => {
      const activeView = { ...state.activeView };
      for (const kind of ASSET_KINDS) {
        const saved = persisted[kind];
        activeView[kind] = saved === "recent" || linkedFolders[kind].includes(saved) ? saved : "recent";
      }
      return { activeView };
    }),
}));
