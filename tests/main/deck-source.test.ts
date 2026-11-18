/**
 * Which reader opens a deck already on record: the source is stat'ed once and its container sniffed at most once,
 * and a ready hymn is answered without opening the file (2026-11-15 audit, X9). The three readers used to stat it
 * one each and sniff it twice for a PDF.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  SLIDES_CONVERTER_VERSION,
  SLIDES_FALLBACK_RENDER_WIDTH,
  SLIDES_MODEL_VERSION,
  SLIDES_NATIVE_VERSION,
} from "../../src/shared/constants";

const h = vi.hoisted(() => {
  /** The row each lookup answers, by reader. */
  const rows: Record<string, unknown> = {};
  return { file: "", rows };
});

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  screen: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, on: () => undefined },
}));
vi.mock("../../src/main/services/repos", () => ({
  getMediaRepo: () => ({
    getPathById: () => h.file,
    ensureLinkedAudio: () => undefined,
    linkedAudioPathById: () => null,
    refreshStat: () => undefined,
  }),
  getSlidesRepo: () => ({
    findSourceDeckByAsset: (_id: number, format: string) => h.rows[format] ?? null,
    findDeckByAsset: () => h.rows["pdf"] ?? null,
    findDeckByAssetContent: () => null,
    touchDeck: () => undefined,
    toDTO: (row: { imageFormat: string }) => ({ format: row.imageFormat }),
  }),
  getSettingsRepo: () => ({ get: () => null }),
}));
vi.mock("../../src/main/services/broadcast", () => ({ broadcast: () => undefined }));
vi.mock("../../src/main/media/deck-clips", () => ({
  healDeckClips: () => undefined,
  isEngineClip: () => false,
  revertPlayableCopies: () => undefined,
}));
vi.mock("../../src/main/slides/pptx-deck", () => ({ extractClips: vi.fn(), hurryDeck: vi.fn(), readPptx: vi.fn() }));
vi.mock("../../src/main/slides/rasterizer", () => ({ readPdfPages: vi.fn(), shutdownRasterizer: vi.fn() }));

const { prepareDeck } = await import("../../src/main/slides/deck-service");

let dir = "";
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-source-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A source of these magic bytes, on record as `format`; what opening it costs. */
async function open(name: string, magic: number[], format: "native" | "model" | "pdf") {
  h.file = path.join(dir, name);
  fs.writeFileSync(h.file, Buffer.from([...magic, ...new Array<number>(64).fill(0)]));
  const stat = fs.statSync(h.file);
  h.rows = {
    [format]: {
      id: 1,
      imageFormat: format === "pdf" ? "png" : format,
      status: "ready",
      converterVersion: { native: SLIDES_NATIVE_VERSION, model: SLIDES_MODEL_VERSION, pdf: SLIDES_CONVERTER_VERSION }[format],
      sourceSizeBytes: stat.size,
      sourceMtimeMs: Math.trunc(stat.mtimeMs),
      cacheDir: "",
      renderWidth: SLIDES_FALLBACK_RENDER_WIDTH,
    },
  };
  const stats = vi.spyOn(fs, "statSync");
  const opens = vi.spyOn(fs, "openSync");
  const dto = await prepareDeck(1);
  const count = (spy: typeof stats | typeof opens) => spy.mock.calls.filter(([file]) => file === h.file).length;
  const cost = { dto, stats: count(stats), opens: count(opens) };
  vi.restoreAllMocks();
  return cost;
}

test("a ready hymn is answered from its row without opening the file", async () => {
  expect(await open("hymn.pps", [0xd0, 0xcf, 0x11, 0xe0], "native")).toEqual({ dto: { format: "native" }, stats: 1, opens: 0 });
});

test("a ready model deck: one stat and one sniff", async () => {
  expect(await open("deck.pptx", [0x50, 0x4b, 0x03, 0x04], "model")).toEqual({ dto: { format: "model" }, stats: 1, opens: 1 });
});

test("a ready PDF: one stat and one sniff", async () => {
  expect(await open("deck.pdf", [0x25, 0x50, 0x44, 0x46], "pdf")).toEqual({ dto: { format: "png" }, stats: 1, opens: 1 });
});
