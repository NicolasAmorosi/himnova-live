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
   *  reordered items, or a name/notes/date edit, since the last load or save.
   *  Selection/live cursors don't count: they don't change what a save would
   *  persist. */
  dirty: boolean;

  loadProgram: (program: ProgramDTO) => void;
  /** Puts back the schedule the operator was editing when the window last
   *  went away. Unlike `loadProgram` this leaves `dirty` true: a draft is by
   *  definition work that was never saved. */
  restoreDraft: (draft: ProgramDraft) => void;
  newProgram: () => void;
  setProgramMeta: (meta: ProgramMeta) => void;
  /** `insertAt` places the item before that position; omitted (or past the end)
   *  appends — the default every non-drop caller wants. */
  addItem: (item: ProgramItemUpsert, insertAt?: number) => void;
  removeAt: (index: number) => void;
  removeByMediaAsset: (assetId: number) => void;
  removeByUtilityScene: (sceneId: number) => void;
  removeByPlate: (plateId: number) => void;
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

/**
 * Drops every item `isTarget` matches, wherever it sits, and remaps both
 * cursors to the survivors' new positions instead of just clearing them — an
 * unrelated selection must not jump to null because something else was
 * deleted. Shared by the two "the thing this row pointed at is gone" paths.
 */
function removeWhere(
  state: { items: ProgramItemDTO[]; selectedIndex: number | null; activeIndex: number | null },
  isTarget: (item: ProgramItemDTO) => boolean,
) {
  const remap = new Map<number, number>();
  const survivors: ProgramItemDTO[] = [];
  state.items.forEach((item, oldIndex) => {
    if (isTarget(item)) return;
    remap.set(oldIndex, survivors.length);
    survivors.push(item);
  });
  const remapIndex = (index: number | null) => (index === null ? null : (remap.get(index) ?? null));
  return {
    items: reindex(survivors),
    selectedIndex: remapIndex(state.selectedIndex),
    activeIndex: remapIndex(state.activeIndex),
    dirty: true,
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
  dirty: true,

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
      dirty: true,
    }),

  setProgramMeta: ({ name, notes }) =>
    set({
      currentProgramName: name,
      currentProgramNotes: notes,
      dirty: true,
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
        dirty: true,
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
    if (from === to) return;
    const state = get();
    const items = [...state.items];
    const moved = items[from];
    if (!moved) return;
    items.splice(from, 1);
    // `to` was computed against the pre-removal array; shift it back by one
    // once the dragged item is spliced out from before that position.
    const insertAt = to > from ? to - 1 : to;
    items.splice(insertAt, 0, moved);
    set({
      items: reindex(items),
      selectedIndex: insertAt,
      activeIndex: shiftForMove(state.activeIndex, from, insertAt),
      dirty: true,
    });
  },

  clear: () => set({ items: [], selectedIndex: null, activeIndex: null, dirty: true }),
  select: (selectedIndex) => set({ selectedIndex }),
  setActive: (activeIndex) => set({ activeIndex }),
}));
