/**
 * Saving a loaded program's name or notes is written to disk at once, so it is
 * never an unsaved change: «Abrir» right after asked «discard the changes?»
 * (owner, 2026-11-05).
 */
import { expect, test } from "vitest";
import { useProgramStore } from "@renderer/stores/program.store";
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
