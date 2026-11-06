/**
 * A previewed schedule row stays previewed while the schedule is edited around
 * it. It used to be a stored position: moving the row up left PREVIEW (and
 * Enter) on whatever slid into its old place.
 */
import { beforeEach, expect, test } from "vitest";
import { useProgramStore } from "@renderer/stores/program.store";
import { previewScheduleItem, previewedScheduleItem } from "@renderer/lib/actions/preview";

const title = () => {
  const item = previewedScheduleItem();
  return item && "title" in item ? item.title : undefined;
};

beforeEach(() => {
  const { newProgram, addItem } = useProgramStore.getState();
  newProgram();
  for (const name of ["a", "b", "c"]) addItem({ kind: "media", mediaAssetId: 1, title: name });
  previewScheduleItem(2);
});

test("moving the previewed row keeps it previewed", () => {
  useProgramStore.getState().moveUp(2);
  expect(title()).toBe("c");
});

test("dragging another row past it keeps it previewed", () => {
  // SchedulePanel's drop: `reorder(from, targetIndex)`, «a» dropped at the end.
  useProgramStore.getState().reorder(0, 3);
  expect(title()).toBe("c");
});

test("inserting a row above it keeps it previewed", () => {
  useProgramStore.getState().addItem({ kind: "media", mediaAssetId: 1, title: "new" }, 0);
  expect(title()).toBe("c");
});

test("removing the previewed row empties the preview instead of picking a neighbour", () => {
  useProgramStore.getState().removeAt(2);
  expect(previewedScheduleItem()).toBeUndefined();
});
