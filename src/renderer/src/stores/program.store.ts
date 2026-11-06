import { create } from "zustand";
import type {
  ProgramDraft,
  ProgramDTO,
  ProgramItemDTO,
  ProgramItemUpsert,
} from "@shared/types/program";
import { api } from "@renderer/lib/api";

type ProgramMeta = {
  name: string;
  notes: string | null;
};

type ProgramStoreState = {
  currentProgramId: number | null;
  currentProgramName: string;
  currentProgramNotes: string | null;
  items: ProgramItemDTO[];
  selectedIndex: number | null;
  activeIndex: number | null;
  /** True once the schedule diverges from what's on disk — new/removed/
   *  reordered items since the last load or save. The name and notes are
   *  saved the moment they are edited (`setProgramMeta`).
   *  Selection/live cursors don't count: they don't change what a save would
   *  persist. Nor does an empty schedule that was never saved: there is
   *  nothing on disk for it to diverge from (`editedDirty`). */
  dirty: boolean;

  loadProgram: (program: ProgramDTO) => void;
  /** Puts back the schedule the operator was editing when the window last
   *  went away. Unlike `loadProgram` this leaves `dirty` true: a draft is by
   *  definition work that was never saved. */
  restoreDraft: (draft: ProgramDraft) => void;
  newProgram: () => void;
  /** The name and notes main has just saved: the loaded program's mirror, not an edit. */
  setProgramMeta: (meta: ProgramMeta) => void;
  /** `insertAt` places the item before that position; omitted (or past the end)
   *  appends — the default every non-drop caller wants. */
  addItem: (item: ProgramItemUpsert, insertAt?: number) => void;
  removeAt: (index: number) => void;
  removeByMediaAsset: (assetId: number) => void;
  removeByUtilityScene: (sceneId: number) => void;
  removeByPlate: (plateId: number) => void;
  removeBySong: (songId: number) => void;
  /** A Bible version deleted from Settings: its verses stay, with their text
   *  and reference, and lose only the ids — what the `set null` FK did to the
   *  saved rows. Sent back on «Guardar», the dead ids failed that FK. */
  forgetBibleVersion: (versionId: number) => void;
  moveUp: (index: number) => void;
  moveDown: (index: number) => void;
  reorder: (from: number, to: number) => void;
  clear: () => void;
  select: (index: number | null) => void;
  setActive: (index: number | null) => void;
};

function reindex(items: ProgramItemDTO[]): ProgramItemDTO[] {
  return items.map((item, position) => ({ ...item, position }));
}

/**
 * Provisional id for a row that hasn't been saved yet.
 *
 * Monotonic, NOT derived from `items.length`. Deriving it collided: add A(-1)
 * and B(-2), remove A, add C → C is handed `-2` as well (the length is 1
 * again), and both rows then answer to the same React `key`. React reuses the
 * wrong DOM node for them, the async label from `useMediaAsset` sticks to the
 * wrong row, and the `data-index` the drop target reads stops matching the
 * row under the cursor. `ProgramsRepo.save()` renumbers everything from
 * position 0, so this only ever has to be unique within a session.
 */
let provisionalId = 0;
function nextProvisionalId(): number {
  provisionalId += 1;
  return -provisionalId;
}

/** `dirty` after an edit that left `items`: a never-saved schedule emptied
 *  again is back to what «Nuevo programa» starts from, with nothing to save. */
function editedDirty(currentProgramId: number | null, items: readonly ProgramItemDTO[]): boolean {
  return currentProgramId !== null || items.length > 0;
}

/**
 * Drops every item `isTarget` matches, wherever it sits, and remaps both
 * cursors to the survivors' new positions instead of just clearing them — an
 * unrelated selection must not jump to null because something else was
 * deleted. Shared by the two "the thing this row pointed at is gone" paths.
 */
function removeWhere(state: ProgramStoreState, isTarget: (item: ProgramItemDTO) => boolean) {
  const remap = new Map<number, number>();
  const survivors: ProgramItemDTO[] = [];
  state.items.forEach((item, oldIndex) => {
    if (isTarget(item)) return;
    remap.set(oldIndex, survivors.length);
    survivors.push(item);
  });
  // Nothing of the schedule pointed at it: nothing changed. Deleting a library
  // file no row uses marked the schedule «No guardado».
  if (survivors.length === state.items.length) return state;
  const remapIndex = (index: number | null) => (index === null ? null : (remap.get(index) ?? null));
  return {
    items: reindex(survivors),
    selectedIndex: remapIndex(state.selectedIndex),
    activeIndex: remapIndex(state.activeIndex),
    dirty: editedDirty(state.currentProgramId, survivors),
  };
}

/** Shifts a cursor to follow its row through an insertion at `at`. */
function shiftForInsert(index: number | null, at: number): number | null {
  if (index === null) return null;
  return index >= at ? index + 1 : index;
}

/** Shifts a cursor to follow its row through the removal of `at`; `null` when
 *  the removed row IS the one the cursor pointed at. */
function shiftForRemoval(index: number | null, at: number): number | null {
  if (index === null) return null;
  if (index === at) return null;
  return index > at ? index - 1 : index;
}

/** Follows a cursor through a move of `from` → `insertAt` (post-removal
 *  coordinates, i.e. what `reorder` computes). */
function shiftForMove(index: number | null, from: number, insertAt: number): number | null {
  if (index === null) return null;
  if (index === from) return insertAt;
  const afterRemoval = index > from ? index - 1 : index;
  return afterRemoval >= insertAt ? afterRemoval + 1 : afterRemoval;
}

export const useProgramStore = create<ProgramStoreState>((set, get) => ({
  currentProgramId: null,
  currentProgramName: "",
  currentProgramNotes: null,
  items: [],
  selectedIndex: null,
  activeIndex: null,
  dirty: false,

  loadProgram: (program) => {
    // Opening a saved service is the strongest signal there is about which
    // decks are going to be needed, and the operator usually does it well
    // before the service starts — so every deck in it not read yet is read in
    // the background now.
    const deckIds = program.items.filter((item) => item.kind === "ppt").map((item) => item.mediaAssetId);
    if (deckIds.length > 0) void api.deck.prewarm(deckIds);

    set({
      currentProgramId: program.id,
      currentProgramName: program.name,
      currentProgramNotes: program.notes,
      items: program.items,
      selectedIndex: null,
      activeIndex: null,
      dirty: false,
    });
  },

  restoreDraft: (draft) => {
    // Same reasoning as `loadProgram`: the decks in a restored schedule are
    // the ones about to be needed, and the operator has just reopened the app
    // — usually well before the service.
    const deckIds = draft.items.flatMap((item) => (item.kind === "ppt" ? [item.mediaAssetId] : []));
    if (deckIds.length > 0) void api.deck.prewarm(deckIds);

    set({
      currentProgramId: draft.programId,
      currentProgramName: draft.name,
      currentProgramNotes: draft.notes,
      // Fresh provisional ids: the ones from the previous session were negative
      // counters that only ever had to be unique within that session, and the
      // draft deliberately does not carry them (see `ProgramDraft`).
      items: reindex(draft.items.map((item) => ({ ...item, id: nextProvisionalId() }) as ProgramItemDTO)),
      selectedIndex: null,
      activeIndex: null,
      dirty: true,
    });
  },

  newProgram: () =>
    set({
      currentProgramId: null,
      currentProgramName: "",
      currentProgramNotes: null,
      items: [],
      selectedIndex: null,
      activeIndex: null,
      dirty: false,
    }),

  // Its only caller writes the meta to disk first (`updateProgramMeta`), so it
  // is never a pending change: marking the schedule dirty here made «Abrir» ask
  // about unsaved changes right after the notes were saved (owner, 2026-11-05).
  setProgramMeta: ({ name, notes }) =>
    set({
      currentProgramName: name,
      currentProgramNotes: notes,
    }),

  addItem: (item, insertAt) => {
    // Added to the schedule counts as an explicit intent to eventually show
    // this — read its deck in the background rather than waiting for the
    // operator to click it into preview.
    if (item.kind === "ppt") void api.deck.prewarm([item.mediaAssetId]);

    set((state) => {
      // Negative ids mark not-yet-persisted rows — see `nextProvisionalId`.
      const newItem = { ...item, id: nextProvisionalId() } as ProgramItemDTO;
      const items = [...state.items];
      const at = insertAt === undefined ? items.length : Math.min(Math.max(insertAt, 0), items.length);
      items.splice(at, 0, newItem);
      return {
        items: reindex(items),
        selectedIndex: shiftForInsert(state.selectedIndex, at),
        activeIndex: shiftForInsert(state.activeIndex, at),
        dirty: true,
      };
    });
  },

  removeAt: (index) =>
    set((state) => {
      const items = reindex(state.items.filter((_, i) => i !== index));
      // Both cursors, not just the selection: `activeIndex` drives the on-air
      // rail, and leaving it on a raw position after the list shifted made a
      // monitor claim a DIFFERENT row was on the projector — the one thing
      // the on-air treatment is never allowed to get wrong.
      return {
        items,
        selectedIndex: shiftForRemoval(state.selectedIndex, index),
        activeIndex: shiftForRemoval(state.activeIndex, index),
        dirty: editedDirty(state.currentProgramId, items),
      };
    }),

  /** Used when a media/ppt asset is force-deleted from the library: every item
   *  pointing at it must go, wherever it sits in the schedule — unlike
   *  `removeAt`, which only ever removes one row by position and (as a known,
   *  separate bug) doesn't remap `selectedIndex`/`activeIndex` either. */
  removeByMediaAsset: (assetId) =>
    set((state) =>
      removeWhere(
        state,
        (item) => (item.kind === "media" || item.kind === "ppt") && item.mediaAssetId === assetId,
      ),
    ),

  /** The same thing for a time scene force-deleted from the «Scenes» editor.
   *  The unsaved schedule is the one place main's `ON DELETE restrict` cannot
   *  reach — it is not a row, it is a draft — so the renderer has to drop the
   *  items itself, exactly as it does for an asset. */
  removeByUtilityScene: (sceneId) =>
    set((state) => removeWhere(state, (item) => item.kind === "utility" && item.utilitySceneId === sceneId)),

  /** And for a plate force-deleted from the «Overlays» editor. */
  removeByPlate: (plateId) =>
    set((state) => removeWhere(state, (item) => item.kind === "plate" && item.overlayPlateId === plateId)),

  /** And for a song force-deleted from its editor. */
  removeBySong: (songId) =>
    set((state) => removeWhere(state, (item) => item.kind === "song" && item.songId === songId)),

  // `dirty` untouched: a saved row lost the same ids in the same delete.
  forgetBibleVersion: (versionId) =>
    set((state) =>
      state.items.some((item) => item.kind === "bible" && item.bibleVersionId === versionId)
        ? {
            items: state.items.map((item) =>
              item.kind === "bible" && item.bibleVersionId === versionId
                ? { ...item, bibleVersionId: null, bibleBookId: null }
                : item,
            ),
          }
        : state,
    ),

  moveUp: (index) => {
    if (index <= 0) return;
    const state = get();
    const items = [...state.items];
    const [prev, current] = [items[index - 1]!, items[index]!];
    items[index - 1] = current;
    items[index] = prev;
    set({
      items: reindex(items),
      selectedIndex: index - 1,
      activeIndex: shiftForMove(state.activeIndex, index, index - 1),
      dirty: true,
    });
  },

  moveDown: (index) => {
    const state = get();
    const items = [...state.items];
    if (index >= items.length - 1) return;
    const [current, next] = [items[index]!, items[index + 1]!];
    items[index] = next;
    items[index + 1] = current;
    set({
      items: reindex(items),
      selectedIndex: index + 1,
      activeIndex: shiftForMove(state.activeIndex, index, index + 1),
      dirty: true,
    });
  },

  reorder: (from, to) => {
    const state = get();
    const items = [...state.items];
    const moved = items[from];
    // `to` was computed against the pre-removal array; shift it back by one
    // once the dragged item is spliced out from before that position.
    const insertAt = to > from ? to - 1 : to;
    // Dropped where it already was (on itself or on the row below it): no
    // edit, nothing to save.
    if (!moved || insertAt === from) return;
    items.splice(from, 1);
    items.splice(insertAt, 0, moved);
    set({
      items: reindex(items),
      // The selection follows ITS row, like the rail: PREVIEW is the selected
      // row, so dragging another one past it must not change what Enter sends.
      selectedIndex: shiftForMove(state.selectedIndex, from, insertAt),
      activeIndex: shiftForMove(state.activeIndex, from, insertAt),
      dirty: true,
    });
  },

  clear: () =>
    set((state) => ({
      items: [],
      selectedIndex: null,
      activeIndex: null,
      dirty: editedDirty(state.currentProgramId, []),
    })),
  select: (selectedIndex) => set({ selectedIndex }),
  setActive: (activeIndex) => set({ activeIndex }),
}));
