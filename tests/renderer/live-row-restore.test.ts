/**
 * After a crash (no clean close cleared the mark), the schedule's row that was on air comes back in PREVIEW, as a
 * click on it would put it there, and nothing goes on air by itself (owner, 2026-11-23, DU-6). The mark follows the
 * row on air as it changes; main clears it on a clean close (`tests/main/live-row-mark.test.ts`).
 */
import { beforeEach, expect, test, vi } from "vitest";
import { restoreLiveRow, startOpenProgramMemory } from "@renderer/lib/actions/programs";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { ProgramDTO, ProgramItemDTO } from "@shared/types/program";

const media = (id: number, mediaAssetId: number, title: string): ProgramItemDTO => ({
  id,
  position: 0,
  kind: "media",
  mediaAssetId,
  title,
});

/** The same three rows, with the ids a launch would give them: new ones every time. */
const program = (ids: number[], order = [1, 2, 3]): ProgramDTO =>
  ({
    id: 7,
    name: "Culto",
    notes: null,
    items: order.map((asset, index) => ({ ...media(ids[index]!, asset, `clip ${asset}`), position: index })),
  }) as unknown as ProgramDTO;

const mark = () => useSettingsStore.getState().settings["programs.liveRow"];

beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn(() => Promise.resolve({ ok: true, data: undefined })),
    on: () => () => {},
  };
  usePreviewStore.getState().clear();
  useProgramStore.getState().newProgram();
});

test("the row on air is remembered as it changes, and forgotten once nothing of the schedule is on air", () => {
  const stop = startOpenProgramMemory();
  useProgramStore.getState().loadProgram(program([11, 12, 13]));
  expect(mark(), "nothing on air yet").toBeNull();
  useProgramStore.getState().setActive(1);
  // Fails if the row on air is not kept for the next launch.
  expect(mark()).toEqual({ position: 1, row: JSON.stringify({ kind: "media", mediaAssetId: 2, title: "clip 2" }) });
  useProgramStore.getState().moveUp(1);
  // Fails if a reorder leaves the mark at the row's old place.
  expect(mark()?.position).toBe(0);
  useProgramStore.getState().setActive(null);
  expect(mark()).toBeNull();
  stop();
});

test("at launch the row that was on air is in PREVIEW, selected as a click selects it, and nothing is on air", () => {
  const stop = startOpenProgramMemory();
  useProgramStore.getState().loadProgram(program([11, 12, 13]));
  useProgramStore.getState().setActive(2);
  const left = mark();
  stop();

  // The next launch: the same program, every row with a new id, nothing live.
  useProgramStore.getState().loadProgram(program([21, 22, 23]));
  restoreLiveRow(left);
  // Fails without the restore: PREVIEW stays empty and the operator looks for the row by eye.
  expect(useProgramStore.getState().selectedIndex).toBe(2);
  expect(usePreviewStore.getState().target).toEqual({ kind: "scheduleItem" });
  // Fails if the restore sends anything live.
  expect(useProgramStore.getState().activeIndex).toBeNull();
  expect(useProjectionStore.getState().base).toBeNull();
});

test("a row that moved is found by what it is; two rows alike, or none, choose nothing", () => {
  const row = JSON.stringify({ kind: "media", mediaAssetId: 3, title: "clip 3" });
  useProgramStore.getState().loadProgram(program([21, 22, 23], [3, 1, 2]));
  restoreLiveRow({ position: 2, row });
  expect(useProgramStore.getState().selectedIndex).toBe(0);

  useProgramStore.getState().loadProgram(program([21, 22, 23], [3, 1, 3]));
  restoreLiveRow({ position: 1, row });
  expect(useProgramStore.getState().selectedIndex).toBeNull();

  useProgramStore.getState().loadProgram(program([21, 22, 23], [1, 2, 1]));
  restoreLiveRow({ position: 0, row });
  expect(useProgramStore.getState().selectedIndex).toBeNull();
});
