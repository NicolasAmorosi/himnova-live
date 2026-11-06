/**
 * What is, and is not, an unsaved change. Saving a loaded program's name or
 * notes is written to disk at once, so it never is: «Abrir» right after asked
 * «discard the changes?» (owner, 2026-11-05). Nor is an empty schedule that
 * was never saved, or a row dropped where it already was.
 */
import { expect, test, vi } from "vitest";
import { useProgramStore } from "@renderer/stores/program.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { startOpenProgramMemory } from "@renderer/lib/actions/programs";
import type { ProgramDTO } from "@shared/types/program";

const saved = { id: 7, name: "Culto", notes: null, items: [] } as unknown as ProgramDTO;

test("saved notes leave a clean program clean", () => {
  useProgramStore.getState().loadProgram(saved);
  useProgramStore.getState().setProgramMeta({ name: "Culto", notes: "Traer el himnario" });
  expect(useProgramStore.getState().dirty).toBe(false);
  expect(useProgramStore.getState().currentProgramNotes).toBe("Traer el himnario");
});

test("saved notes leave unsaved rows unsaved", () => {
  useProgramStore.getState().loadProgram(saved);
  useProgramStore.getState().addItem({ kind: "media", mediaAssetId: 1, title: "a" });
  useProgramStore.getState().setProgramMeta({ name: "Culto", notes: "x" });
  expect(useProgramStore.getState().dirty).toBe(true);
});

test("a fresh or new, empty schedule has nothing to save", () => {
  useProgramStore.getState().newProgram();
  expect(useProgramStore.getState().dirty).toBe(false);
  useProgramStore.getState().addItem({ kind: "media", mediaAssetId: 1, title: "a" });
  useProgramStore.getState().clear();
  expect(useProgramStore.getState().dirty).toBe(false);
});

test("a row dropped where it already was is not an edit", () => {
  useProgramStore.getState().loadProgram(saved);
  for (const title of ["a", "b"]) useProgramStore.getState().addItem({ kind: "media", mediaAssetId: 1, title });
  useProgramStore.setState({ dirty: false });
  // On itself, and on the row below it: both land where it was.
  useProgramStore.getState().reorder(0, 0);
  useProgramStore.getState().reorder(0, 1);
  expect(useProgramStore.getState().dirty).toBe(false);
  useProgramStore.getState().reorder(0, 2);
  expect(useProgramStore.getState().dirty).toBe(true);
});

test("the saved program the schedule holds is remembered for the next launch; a new schedule forgets it", () => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn(() => Promise.resolve({ ok: true, data: undefined })),
    on: () => () => {},
  };
  useProgramStore.getState().newProgram();
  const stop = startOpenProgramMemory();
  const openId = () => useSettingsStore.getState().settings["programs.openId"];
  useProgramStore.getState().loadProgram(saved);
  expect(openId()).toBe(7);
  useProgramStore.getState().newProgram();
  expect(openId()).toBeNull();
  stop();
});
