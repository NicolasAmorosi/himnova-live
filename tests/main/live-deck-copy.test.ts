/**
 * The copy of the deck on air (`keepLiveDeckSource`) is what its slides are read from once its file is gone (a pen
 * drive pulled). Deck A on air, GO LIVE of B whose copy is slow, then back to A before it ends: B's copy used to land
 * anyway, replacing A's and deleting it, so A on air had no copy (2026-11-15 audit, A47).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ dir: "", decks: new Map<number, { sourcePath: string; sourceSizeBytes: number; sourceMtimeMs: number }>() }));
h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-deck-"));
const LIVE = path.join(h.dir, "live-deck");

vi.mock("electron", () => ({ protocol: {} }));
vi.mock("../../src/main/paths", () => ({ liveDeckDir: LIVE, pdfjsWasmDir: h.dir, slidesCacheDir: h.dir }));
vi.mock("../../src/main/services/repos", () => ({
  getSettingsRepo: () => ({}),
  getSlidesRepo: () => ({ getDeckById: (id: number) => h.decks.get(id) ?? null }),
  isDatabaseOpen: () => true,
}));
vi.mock("../../src/main/slides/rasterizer", () => ({}));
vi.mock("../../src/main/slides/native-deck", () => ({}));
vi.mock("../../src/main/media/thumbnail-service", () => ({}));

function deck(id: number): void {
  const sourcePath = path.join(h.dir, `deck-${id}.pptx`);
  fs.writeFileSync(sourcePath, `deck ${id}`);
  const stat = fs.statSync(sourcePath);
  h.decks.set(id, { sourcePath, sourceSizeBytes: stat.size, sourceMtimeMs: Math.trunc(stat.mtimeMs) });
}
const kept = () => (fs.existsSync(LIVE) ? fs.readdirSync(LIVE).sort() : []);

test("back to the deck on air before another deck's copy ends, the copy kept is still the deck on air's", async () => {
  const { keepLiveDeckSource } = await import("../../src/main/protocol/worship-protocol");
  deck(1);
  deck(2);
  deck(3);
  keepLiveDeckSource(1);
  await vi.waitFor(() => expect(kept()).toEqual(["1.pptx"]));
  await new Promise((resolve) => setTimeout(resolve, 20));

  // B's copy waits until released: a slow pen drive.
  const realCopy = fs.promises.copyFile.bind(fs.promises);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const copyFile = vi.spyOn(fs.promises, "copyFile").mockImplementation(async (from, to) => {
    await gate;
    return realCopy(from, to);
  });
  keepLiveDeckSource(2);
  await vi.waitFor(() => expect(copyFile).toHaveBeenCalledTimes(1));
  keepLiveDeckSource(1);
  release();
  // Settled: the gated copy written and then either kept or dropped.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(kept()).toEqual(["1.pptx"]);
  copyFile.mockRestore();

  // A deck shown again while its own copy is under way (every slide is a show) still gets it.
  keepLiveDeckSource(3);
  keepLiveDeckSource(3);
  await vi.waitFor(() => expect(kept()).toEqual(["3.pptx"]));
});
