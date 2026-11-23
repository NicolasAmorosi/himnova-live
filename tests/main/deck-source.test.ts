/**
 * Which reader opens a deck already on record: the source is stat'ed once and its container sniffed at most once,
 * and a ready hymn is answered without opening the file (2026-11-15 audit, X9). The three readers used to stat it
 * one each and sniff it twice for a PDF.
 *
 * And none of it on main's thread: no synchronous stat, open or read of the operator's file to open a deck, ready or
 * not (2026-11-22 audit, RM1). A hymn on a share that stopped answering held main 21 s, and a screen of 32 unread hymns
 * read ahead was one turn of it. The sniff and the picture reader are the hymnal's thread's (`sniffDeck`, faked here).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { buildLegacyPpt } from "../fixtures/legacy-ppt";
import {
  SLIDES_CONVERTER_VERSION,
  SLIDES_FALLBACK_RENDER_WIDTH,
  SLIDES_MODEL_VERSION,
  SLIDES_NATIVE_VERSION,
} from "../../src/shared/constants";

const h = vi.hoisted(() => {
  /** The row each lookup answers, by reader. */
  const rows: Record<string, unknown> = {};
  /** What the hymnal's thread says the file is. */
  const kind = { value: "binary" };
  return { file: "", rows, kind, inserted: 0 };
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
    setContentHash: () => undefined,
  }),
  getSlidesRepo: () => ({
    findSourceDeckByAsset: (_id: number, format: string) => h.rows[format] ?? null,
    findDeckByAsset: () => h.rows["pdf"] ?? null,
    findDeckByAssetContent: () => null,
    touchDeck: () => undefined,
    insertDeck: () => ++h.inserted,
    getDeckById: (id: number) => ({ id, imageFormat: "native" }),
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
/** A hymn the picture reader accepts: one slide, its JPEG edge to edge. */
const HYMN_READ = {
  deck: {
    width: 5760,
    height: 4320,
    slides: [
      {
        autoAdvanceMs: null,
        advanceOnClick: true,
        transition: null,
        layers: [{ type: "jpeg", offset: 0, length: 16, x: 0, y: 0, width: 5760, height: 4320 }],
      },
    ],
  },
};
const sniffDeck = vi.fn((_file: string, native: boolean) =>
  Promise.resolve({ kind: h.kind.value, native: native && h.kind.value === "binary" ? HYMN_READ : undefined }),
);
/** The model reader declines everything here: what reaches it is the point. */
const readPptx = vi.fn(() => Promise.resolve(null));
vi.mock("../../src/main/slides/pptx-deck", () => ({
  extractClips: vi.fn(),
  hurryDeck: vi.fn(),
  readPptx,
  sniffDeck,
  unreadableReason: () => Promise.resolve("NOT_A_PRESENTATION"),
}));
vi.mock("../../src/main/slides/rasterizer", () => ({ readPdfPages: vi.fn(), shutdownRasterizer: vi.fn() }));

const { getDeck, prepareDeck } = await import("../../src/main/slides/deck-service");
const { backgroundStat } = await import("../../src/main/services/background-files");

let dir = "";
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-source-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let assetId = 0;

/** A source of these bytes, on record as `format` (or not at all), that the hymnal's thread sniffs as `kind`; what
 *  opening it costs, on main and on that thread. A new asset each time: an earlier open leaves nothing in flight. */
async function open(
  name: string,
  bytes: Buffer,
  kind: string,
  format: "native" | "model" | "pdf" | null,
  peek: (id: number) => Promise<unknown> = (id) => prepareDeck(id),
) {
  h.file = path.join(dir, name);
  h.kind.value = kind;
  fs.writeFileSync(h.file, bytes);
  const stat = fs.statSync(h.file);
  h.rows = {};
  if (format) {
    h.rows[format] = {
      id: 1,
      imageFormat: format === "pdf" ? "png" : format,
      status: "ready",
      converterVersion: { native: SLIDES_NATIVE_VERSION, model: SLIDES_MODEL_VERSION, pdf: SLIDES_CONVERTER_VERSION }[format],
      sourceSizeBytes: stat.size,
      sourceMtimeMs: Math.trunc(stat.mtimeMs),
      cacheDir: "",
      renderWidth: SLIDES_FALLBACK_RENDER_WIDTH,
    };
  }
  sniffDeck.mockClear();
  const onMain = [vi.spyOn(fs, "statSync"), vi.spyOn(fs, "openSync"), vi.spyOn(fs, "readFileSync")];
  const dto = await peek(++assetId);
  const touched = onMain.flatMap((spy) => spy.mock.calls.map((call) => call[0])).filter((file) => file === h.file).length;
  const cost = { dto, onMain: touched, sniffs: sniffDeck.mock.calls.length };
  vi.restoreAllMocks();
  return cost;
}

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, ...new Array<number>(64).fill(0)]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...new Array<number>(64).fill(0)]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, ...new Array<number>(64).fill(0)]);

test("a ready hymn is answered from its row without opening the file", async () => {
  expect(await open("hymn.pps", OLE, "binary", "native")).toEqual({ dto: { format: "native" }, onMain: 0, sniffs: 0 });
});

test("a ready model deck: one sniff, off main", async () => {
  expect(await open("deck.pptx", ZIP, "ooxml", "model")).toEqual({ dto: { format: "model" }, onMain: 0, sniffs: 1 });
});

test("a ready PDF: one sniff, off main", async () => {
  expect(await open("deck.pdf", PDF, "pdf", "pdf")).toEqual({ dto: { format: "png" }, onMain: 0, sniffs: 1 });
});

test("a hymn never read is sniffed and read as pictures in one trip off main, and recorded", async () => {
  const inserted = h.inserted;
  const cost = await open("new-hymn.pps", buildLegacyPpt(), "binary", null);
  expect(cost).toEqual({ dto: { format: "native" }, onMain: 0, sniffs: 1 });
  expect(sniffDeck.mock.calls[0]?.[1]).toBe(true);
  expect(h.inserted).toBe(inserted + 1);
});

test("the preview and GO LIVE asking for the same unread hymn at once record it once", async () => {
  const inserted = h.inserted;
  const cost = await open("twice.pps", buildLegacyPpt(), "binary", null, (id) =>
    Promise.all([prepareDeck(id), prepareDeck(id, { priority: "background" }), prepareDeck(id)]),
  );
  expect(cost.onMain).toBe(0);
  expect(cost.sniffs).toBe(1);
  expect(h.inserted).toBe(inserted + 1);
});

test("peeking at a deck reads nothing of its file on main, read or not", async () => {
  expect(await open("peek.pps", OLE, "binary", "native", getDeck)).toEqual({ dto: { format: "native" }, onMain: 0, sniffs: 0 });
  expect(await open("unread.pps", OLE, "binary", null, getDeck)).toEqual({ dto: null, onMain: 0, sniffs: 0 });
  expect(await open("peek.pdf", PDF, "pdf", "pdf", getDeck)).toEqual({ dto: { format: "png" }, onMain: 0, sniffs: 1 });
});

test("a hymn the picture reader refuses, or whose thread stops on it, goes whole to the model reader", async () => {
  for (const [name, answer] of [
    ["refused.pps", { kind: "binary", native: { unsupported: "embedded sound" } }],
    ["killer.pps", null],
  ] as const) {
    h.file = path.join(dir, name);
    h.kind.value = "binary";
    h.rows = {};
    fs.writeFileSync(h.file, buildLegacyPpt());
    readPptx.mockClear();
    sniffDeck.mockImplementationOnce(() => Promise.resolve(answer as never));
    const inserted = h.inserted;
    await expect(prepareDeck(++assetId)).rejects.toMatchObject({ slideCode: "NOT_A_PRESENTATION" });
    expect(readPptx.mock.calls.map((call: unknown[]) => call[0])).toEqual([h.file]);
    expect(h.inserted).toBe(inserted);
  }
});

test("reading ahead takes one of the background's two threads, never a third", async () => {
  // A dead share with the hymns on screen: the sweep's two stats, the read-ahead's and GO LIVE's held five of libuv's
  // four threads, and the projector's own reads waited behind them (2026-11-22 review, RN-6).
  h.file = path.join(dir, "read-ahead.pps");
  fs.writeFileSync(h.file, OLE);
  h.rows = {};
  const real = fs.promises.stat;
  const held: (() => void)[] = [];
  const stats = vi.spyOn(fs.promises, "stat").mockImplementation((file) =>
    String(file).startsWith("sweep-") ? new Promise((resolve) => held.push(() => resolve({} as fs.Stats))) : real(file),
  );
  const sweep = [backgroundStat("sweep-1"), backgroundStat("sweep-2")];
  const ahead = prepareDeck(++assetId, { priority: "background" }).catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  expect(stats.mock.calls.map(([file]) => file)).toEqual(["sweep-1", "sweep-2"]);
  held.shift()!();
  await ahead;
  expect(stats.mock.calls.map(([file]) => file)).toContain(h.file);
  held.shift()!();
  await Promise.all(sweep);
  vi.restoreAllMocks();
});

test("a source slow to answer its stat is waited for, and gone only when the stat fails, asked once", async () => {
  // A disk slow to wake that lost a race of a second was a file that is gone: «El archivo ya no está disponible»,
  // and GO LIVE refused (2026-11-22 review, RN-2). A peek still gives up after a second: its `null` means «ensure it».
  vi.useFakeTimers();
  h.file = path.join(dir, "slow-to-wake.pps");
  fs.writeFileSync(h.file, OLE);
  h.rows = {};
  const real = fs.statSync(h.file);
  const answers: ((stat: fs.Stats | Error) => void)[] = [];
  const stats = vi.spyOn(fs.promises, "stat").mockImplementation(
    () => new Promise((resolve, reject) => answers.push((stat) => (stat instanceof Error ? reject(stat) : resolve(stat)))),
  );
  try {
    const peek = getDeck(++assetId);
    let ensured: unknown = "pending";
    const ensure = prepareDeck(assetId).then((dto) => (ensured = dto));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await peek).toBeNull();
    expect(ensured).toBe("pending");
    answers[0]!(real);
    expect(await ensure).toEqual({ format: "native" });
    expect(stats.mock.calls.filter(([file]) => file === h.file)).toHaveLength(1);

    const gone = expect(prepareDeck(++assetId)).rejects.toMatchObject({ slideCode: "SOURCE_MISSING" });
    await vi.advanceTimersByTimeAsync(5000);
    answers[1]!(new Error("ENOENT"));
    await gone;
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
