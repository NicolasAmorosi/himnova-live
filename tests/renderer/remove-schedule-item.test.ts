/**
 * «Deshacer» of a row taken out of the order of service puts it back where it
 * was, chosen again — and on air again only if it still is. Neither the rail
 * nor the selection may come back claiming something the operator has since
 * replaced: the rail would name a row the projector no longer shows, and a
 * second selection is a Delete that lands where nobody is looking.
 */
import { beforeEach, expect, test, vi } from "vitest";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useLibraryStore } from "@renderer/stores/library.store";
import { useToastStore } from "@renderer/stores/toast.store";
import { clearSchedule, removeScheduleItem } from "@renderer/lib/actions/remove-selected";
import { clearBaseContent } from "@renderer/lib/actions/playback";
import { previewAsset, previewScheduleItem } from "@renderer/lib/actions/preview";
import type { ProgramDTO } from "@shared/types/program";

const initialProjection = useProjectionStore.getState();

beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn(() => Promise.resolve({ ok: true, data: [] })),
    on: () => () => {},
  };
  useProjectionStore.setState(initialProjection, true);
  useToastStore.setState({ toasts: [] });
  const { newProgram, addItem } = useProgramStore.getState();
  newProgram();
  addItem({ kind: "media", mediaAssetId: 1, title: "clip" });
  addItem({ kind: "media", mediaAssetId: 2, title: "photo" });
  addItem({ kind: "media", mediaAssetId: 3, title: "song" });
});

const liveTitle = () => {
  const { activeIndex, items } = useProgramStore.getState();
  const item = activeIndex === null ? undefined : items[activeIndex];
  return item && "title" in item ? item.title : null;
};

const titles = () => useProgramStore.getState().items.map((i) => ("title" in i ? i.title : null));

function clickUndo(): void {
  const action = useToastStore.getState().toasts.at(-1)?.action;
  if (!action) throw new Error("no «Deshacer» toast");
  action.onClick();
}

test("the live row comes back on air while it still is", () => {
  useProjectionStore.getState().setBase({ kind: "image", assetId: 2 });
  useProgramStore.getState().setActive(1);
  removeScheduleItem(1);
  clickUndo();
  expect(liveTitle()).toBe("photo");
});

test("after another row went live, the rail stays on the row that is live", () => {
  useProgramStore.getState().setActive(1);
  removeScheduleItem(1);
  // What `goLiveWithScheduleItem` does to the rail.
  useProgramStore.getState().setActive(0);
  clickUndo();
  expect(useProgramStore.getState().items.map((i) => ("title" in i ? i.title : null))).toEqual(["clip", "photo", "song"]);
  expect(liveTitle()).toBe("clip");
});

test("after «Sacar del aire», the rail does not light up over a cleared stage", () => {
  useProjectionStore.getState().setBase({ kind: "image", assetId: 2 });
  useProgramStore.getState().setActive(1);
  removeScheduleItem(1);
  clearBaseContent();
  clickUndo();
  expect(useProgramStore.getState().activeIndex).toBeNull();
});

test("after a library file was picked, the row comes back as the one selection", () => {
  previewScheduleItem(1);
  removeScheduleItem(1);
  previewAsset(7, "image");
  clickUndo();
  expect(useProgramStore.getState().selectedIndex).toBe(1);
  expect(useLibraryStore.getState().selectedId).toBeNull();
});

test("a newer edit takes the older «Deshacer» down: it would put the row into a different list", () => {
  removeScheduleItem(0);
  const first = useToastStore.getState().toasts.at(-1);
  removeScheduleItem(0);
  expect(useToastStore.getState().toasts.find((t) => t.id === first?.id)?.exiting).toBe(true);
  // The newer one still undoes its own removal.
  clickUndo();
  expect(titles()).toEqual(["photo", "song"]);
});

test("«Vaciar» on a saved program starts a new one, so «Guardar» cannot write over it; «Deshacer» brings it back", () => {
  const { items } = useProgramStore.getState();
  useProgramStore.getState().loadProgram({ id: 7, name: "Culto", notes: null, items } as unknown as ProgramDTO);
  useProjectionStore.getState().setBase({ kind: "image", assetId: 2 });
  useProgramStore.getState().setActive(1);
  clearSchedule();
  expect(useProgramStore.getState()).toMatchObject({ currentProgramId: null, items: [], dirty: false });
  clickUndo();
  expect(useProgramStore.getState()).toMatchObject({ currentProgramId: 7, currentProgramName: "Culto", dirty: false });
  expect(titles()).toEqual(["clip", "photo", "song"]);
  // Its row is still what the projector shows: the rail comes back with it.
  expect(liveTitle()).toBe("photo");
});

test("a row of a saved program taken out and put back leaves it saved", () => {
  useProgramStore.setState({ currentProgramId: 7, currentProgramName: "Culto", dirty: false });
  removeScheduleItem(1);
  expect(useProgramStore.getState().dirty).toBe(true);
  clickUndo();
  expect(titles()).toEqual(["clip", "photo", "song"]);
  expect(useProgramStore.getState().dirty).toBe(false);
});
