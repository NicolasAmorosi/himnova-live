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
import mainEs from "../../src/main/i18n/messages/es";
import {
  SLIDES_CONVERTER_VERSION,
  SLIDES_FALLBACK_RENDER_WIDTH,
  SLIDES_MODEL_VERSION,
  SLIDES_NATIVE_VERSION,
  SLIDES_SOURCE_STAT_TIMEOUT_MS,
} from "../../src/shared/constants";

const h = vi.hoisted(() => {
  /** The row each lookup answers, by reader. */
  const rows: Record<string, unknown> = {};
  /** What the hymnal's thread says the file is. */
  const kind = { value: "binary" };
  /** Every `deck-progress` main pushed. */
  const progress: { status: string }[] = [];
  /** What the next `insertDeck` throws, once. */
  const insert = { error: null as Error | null };
  return { file: "", rows, kind, inserted: 0, progress, insert };
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
    insertDeck: () => {
      const error = h.insert.error;
      h.insert.error = null;
      if (error) throw error;
      return ++h.inserted;
    },
    getDeckById: (id: number) => ({ id, imageFormat: "native" }),
    toDTO: (row: { imageFormat: string }) => ({ format: row.imageFormat }),
  }),
  getSettingsRepo: () => ({ get: () => null }),
}));
vi.mock("../../src/main/services/broadcast", () => ({
  broadcast: (_channel: string, payload: { status: string }) => void h.progress.push(payload),
}));
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
const { readPdfPages } = await import("../../src/main/slides/rasterizer");
const { rasterReplyError } = await import("../../src/main/slides/errors");
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

test("a sniff the hymnal's clock stopped is asked again by the operator, and a deck already read opens from its row", async () => {
  // Five seconds for a millisecond's work is mostly the disk or the share: a hymn kept as too slow stayed failed until
  // «Reintentar», and a ready deck on air turned failed under GO LIVE's own ensure (2026-11-22 review, RN-7).
  const slowOnce = () => sniffDeck.mockImplementationOnce(() => Promise.resolve("too-slow" as never));
  h.file = path.join(dir, "slow-share.pps");
  h.kind.value = "binary";
  h.rows = {};
  fs.writeFileSync(h.file, buildLegacyPpt());
  const id = ++assetId;
  slowOnce();
  await expect(prepareDeck(id)).rejects.toMatchObject({ slideCode: "DECK_TOO_SLOW" });
  expect(readPptx).not.toHaveBeenCalledWith(h.file, expect.anything());
  // Read ahead it is not asked again, so a file that always hangs does not hold the thread at every pass of its tile;
  // the operator's ask asks it again (owner, 2026-11-17).
  sniffDeck.mockClear();
  await expect(prepareDeck(id, { priority: "background" })).rejects.toMatchObject({ slideCode: "DECK_TOO_SLOW" });
  expect(sniffDeck).not.toHaveBeenCalled();
  expect(await prepareDeck(id)).toEqual({ format: "native" });

  for (const [name, bytes, kind, format, dto] of [
    ["ready.pptx", ZIP, "ooxml", "model", { format: "model" }],
    ["ready.pdf", PDF, "pdf", "pdf", { format: "png" }],
  ] as const) {
    const slow = await open(name, bytes, kind, format, (next) => (slowOnce(), prepareDeck(next)));
    expect(slow.dto).toEqual(dto);
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
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(stats.mock.calls.map(([file]) => file)).toEqual(["sweep-1", "sweep-2"]);
    held.shift()!();
    await ahead;
    expect(stats.mock.calls.map(([file]) => file)).toContain(h.file);
  } finally {
    // Even after a failed assertion: a stat still held keeps a background thread taken for the rest of the file.
    while (held.length) held.shift()!();
    await Promise.all([...sweep, ahead]);
    vi.restoreAllMocks();
  }
});

test("a deck read ahead takes the next free thread, ahead of a sweep's whole queue", async () => {
  // With a dead share in the library, a sweep's chunk of 200 stats went two at a time, 21 s each on Windows, and the
  // hymns of the service were read ahead only when it emptied: GO LIVE read them on the spot (review, RN2-3).
  h.file = path.join(dir, "ahead-of-sweep.pps");
  fs.writeFileSync(h.file, OLE);
  h.kind.value = "binary";
  h.rows = {};
  const real = fs.promises.stat;
  const held: (() => void)[] = [];
  let hanging = true;
  const stats = vi.spyOn(fs.promises, "stat").mockImplementation((file) => {
    if (!String(file).startsWith("dead-")) return real(file);
    return hanging ? new Promise((resolve) => held.push(() => resolve({} as fs.Stats))) : Promise.resolve({} as fs.Stats);
  });
  const sweep = Array.from({ length: 10 }, (_, i) => backgroundStat(`dead-${i}`));
  const ahead = prepareDeck(++assetId, { priority: "background" }).catch(() => undefined);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(stats.mock.calls.map(([file]) => file)).toEqual(["dead-0", "dead-1"]);
    // The first dead stat gives up: its thread goes to the hymn, not to the third dead one.
    held.shift()!();
    await vi.waitFor(() => expect(stats.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(stats.mock.calls[2]?.[0]).toBe(h.file);
  } finally {
    hanging = false;
    while (held.length) held.shift()!();
    await Promise.all([...sweep, ahead]);
    vi.restoreAllMocks();
  }
});

test("a source slow to answer its stat is waited for, and gone only when the stat fails, asked once", async () => {
  // A disk slow to wake that lost a race of a second was a file that is gone: «El archivo ya no está disponible»,
  // and GO LIVE refused (2026-11-22 review, RN-2). A peek still gives up after a second: its `null` means «ensure it».
  vi.useFakeTimers();
  h.file = path.join(dir, "slow-to-wake.pps");
  fs.writeFileSync(h.file, OLE);
  h.kind.value = "binary";
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

test("a stat of the operator's that never answers does not hold «Reintentar» once the share is back", async () => {
  // «Reintentar» and a new GO LIVE joined the stat that began while the share was down: a mount that never answers left
  // the deck «Convirtiendo» until a restart, and one back since answered only when the system gave up (review, RN2-1).
  vi.useFakeTimers();
  h.file = path.join(dir, "share-back.pps");
  fs.writeFileSync(h.file, OLE);
  h.kind.value = "binary";
  h.rows = {};
  const real = fs.promises.stat;
  let down = true;
  const stats = vi
    .spyOn(fs.promises, "stat")
    .mockImplementation((file) => (down && file === h.file ? new Promise(() => undefined) : real(file)));
  try {
    const id = ++assetId;
    let first: unknown = "pending";
    void prepareDeck(id).then((dto) => (first = dto), (error: unknown) => (first = error));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(first).toMatchObject({ slideCode: "SOURCE_NOT_RESPONDING" });
    down = false;
    let retried: unknown = "pending";
    void prepareDeck(id, { force: true }).then((dto) => (retried = dto), (error: unknown) => (retried = error));
    await vi.waitFor(() => expect(retried).toEqual({ format: "native" }));
    expect(stats.mock.calls.filter(([file]) => file === h.file)).toHaveLength(2);
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

test("a source that never answers fails at its cap as one that does not answer, and nothing is kept of the file", async () => {
  // Waited for without end since RN-2: a mount that never answers left the deck «Convirtiendo» until a restart. Past
  // the cap it is neither a file that is gone nor a deck that won't open (2026-11-22 review, RN2-1).
  vi.useFakeTimers();
  h.file = path.join(dir, "silent-share.pps");
  fs.writeFileSync(h.file, OLE);
  h.kind.value = "binary";
  h.rows = {};
  h.progress.length = 0;
  const real = fs.promises.stat;
  let down = true;
  vi.spyOn(fs.promises, "stat").mockImplementation((file) => (down && file === h.file ? new Promise(() => undefined) : real(file)));
  try {
    const id = ++assetId;
    let opened: unknown = "pending";
    void prepareDeck(id).then((dto) => (opened = dto), (error: unknown) => (opened = error));
    await vi.advanceTimersByTimeAsync(SLIDES_SOURCE_STAT_TIMEOUT_MS - 100);
    expect(opened).toBe("pending");
    await vi.advanceTimersByTimeAsync(100);
    expect(opened).toMatchObject({ slideCode: "SOURCE_NOT_RESPONDING", message: mainEs.slides.sourceNotResponding });
    expect(h.progress.filter((p) => p.status === "failed")).toEqual([]);
    // The read ahead is not capped: it waits the stat out, as the sweep does.
    let ahead: unknown = "pending";
    void prepareDeck(++assetId, { priority: "background" }).then((dto) => (ahead = dto), (error: unknown) => (ahead = error));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ahead).toBe("pending");
    // Back: the same deck opens, no «Reintentar» needed.
    down = false;
    let again: unknown = "pending";
    void prepareDeck(id).then((dto) => (again = dto), (error: unknown) => (again = error));
    await vi.waitFor(() => expect(again).toEqual({ format: "native" }));
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

test("a PDF pdf.js cannot open is told in the operator's words, never in pdf.js's", async () => {
  // «Invalid PDF structure.» in English reached the deck's panel, PREVIEW and the GO LIVE toast (2026-11-22, EC-1).
  vi.mocked(readPdfPages).mockRejectedValueOnce(new Error("Invalid PDF structure."));
  const { dto } = await open("damaged.pdf", PDF, "pdf", null, (id) => prepareDeck(id).catch((error: unknown) => error));
  expect(dto).toMatchObject({ code: "RASTER_FAILED", slideCode: "RASTER_FAILED", message: mainEs.slides.pdfUnreadable });
});

test("a PDF that fails to be recorded for another cause is not told as a damaged file", async () => {
  // A full disk under SQLite, or the file gone while it was hashed, asked the operator to export a sound PDF again
  // (2026-11-22 review, RN3-5).
  vi.mocked(readPdfPages).mockResolvedValueOnce([{ widthPx: 1920, heightPx: 1080 }]);
  h.insert.error = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { dto } = await open("full-disk.pdf", PDF, "pdf", null, (id) => prepareDeck(id).catch((error: unknown) => error));
  warn.mockRestore();
  expect(dto).toMatchObject({ slideCode: "RASTER_FAILED", message: mainEs.slides.pdfNotRecorded });
});

test("what the rasterizer window says of a PDF reaches the operator in their words, a password apart", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(rasterReplyError({ kind: "unknown", message: "Couldn't read the PDF (404)" })).toMatchObject({
    slideCode: "RASTER_FAILED",
    message: mainEs.slides.pdfUnreadable,
  });
  expect(rasterReplyError({ kind: "password", message: "No password given" })).toMatchObject({
    slideCode: "PDF_PASSWORD",
    message: mainEs.slides.pdfPassword,
  });
  warn.mockRestore();
});
