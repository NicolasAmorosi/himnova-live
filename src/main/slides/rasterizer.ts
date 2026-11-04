import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SLIDES_RASTER_PAGE_TIMEOUT_MS, SLIDES_THUMB_WIDTH } from "@shared/constants";
import { SlideError } from "./errors";
import { takeNewestBurst } from "./raster-order";
import { trustWindow } from "../ipc/trusted-senders";
import { mt } from "../i18n";

const PRELOAD = path.join(__dirname, "../preload/index.js");
/** The window keeps the PDFs it opened: long enough that a deck on the
 *  projector between two hymns still has its document open when the operator
 *  comes back to it. */
const IDLE_SHUTDOWN_MS = 5 * 60_000;
/** Encoded pages kept in memory, so the projector and the monitors get at once
 *  what PREVIEW already drew. A full slide is 0.1–1.3 MB, a thumbnail ~10 KB. */
const PAGE_CACHE_BYTES = 128 * 1024 * 1024;

/** A PDF as the deck row describes it: the file, at the stamp it was read at. */
export type PdfSource = { sourcePath: string; sourceSizeBytes: number; sourceMtimeMs: number };
export type PdfPageSize = { widthPx: number; heightPx: number };
/** `now`: what the operator is looking at (a slide, opening a deck).
 *  `later`: thumbnails and decks opened in the background. */
export type RasterLane = "now" | "later";
export type PdfFormat = "webp" | "png";

/**
 * A PDF is drawn page by page, when a window asks for the page (owner,
 * 2026-11-03: nothing converted, nothing cached on disk). pdf.js runs in a
 * hidden BrowserWindow rather than a Node worker: it needs a real Canvas2D and
 * Chromium already ships one. The alternative (@napi-rs/canvas in a
 * utilityProcess) publishes its prebuilt binary as a PER-PLATFORM
 * optionalDependency, so `npm install` on macOS never fetches the Windows one
 * and cross-building the Windows installer from a Mac — which this project
 * does — would silently ship a broken app. A hidden window is already its own
 * OS process, so crash isolation is equivalent.
 *
 * One task runs in it at a time, `now` before `later`: rendering a page takes
 * 5–110 ms on an M3, so a slide waits at most for one thumbnail. Inside `now`,
 * the newest ask goes first (`takeNewestBurst`).
 */
let window: BrowserWindow | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let stopped = false;

/**
 * The PDF of the running task, exposed to the sandboxed window as
 * `worship://raster/<taskId>`. The window has no filesystem access (sandbox:
 * true, contextIsolation: true), and this keeps that intact: it receives a
 * capability token, never a path.
 */
const pendingPdfs = new Map<string, string>();

export function resolveRasterPdf(taskId: string): string | null {
  return pendingPdfs.get(taskId) ?? null;
}

/** Whether `win` is the offscreen rasterizer.
 *
 *  Needed because it is a real `BrowserWindow` and therefore shows up in
 *  `BrowserWindow.getAllWindows()` — which is what decides whether macOS
 *  reopens the control window on a dock click and whether
 *  `window-all-closed` fires at all. Counting an invisible worker as "the app
 *  still has a window" is wrong in both directions. */
export function isRasterizerWindow(win: BrowserWindow): boolean {
  return window === win;
}

async function ensureWindow(): Promise<BrowserWindow> {
  if (window && !window.isDestroyed()) return window;

  const win = new BrowserWindow({
    show: false,
    width: 100,
    height: 100,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Hidden windows are throttled by default, which would stall rendering.
      backgroundThrottling: false,
    },
  });

  trustWindow(win);
  win.on("closed", () => {
    if (window === win) window = null;
  });
  // Once per window, never per task: a listener registered per task piled up
  // one per page on the reused window (`MaxListenersExceededWarning`). A
  // renderer crash (OOM on a huge PDF) fails the page it was drawing; the
  // next task starts a fresh window.
  win.webContents.on("render-process-gone", () => {
    if (window === win) window = null;
    if (!win.isDestroyed()) win.destroy();
    if (running) settle(running, new SlideError("RASTER_FAILED", mt("slides.rasterCrashed")));
  });

  // Subscribed and awaited INSIDE a try: a rejected load (dev server not up
  // yet, a missing bundled file) used to throw out of here before `window =
  // win`, leaving a live, unreferenced, never-destroyed BrowserWindow behind —
  // which also kept `BrowserWindow.getAllWindows()` non-empty forever, and
  // that count is what `app.on("activate")`/`window-all-closed` read.
  try {
    const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
    if (!app.isPackaged && devServerUrl) {
      await win.loadURL(`${devServerUrl}/rasterizer.html`);
    } else {
      await win.loadFile(path.join(__dirname, "../renderer/rasterizer.html"));
    }
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }

  window = win;
  return win;
}

function dropWindow(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (window && !window.isDestroyed()) window.destroy();
  window = null;
}

/** On quit: nothing more is drawn, and whatever was waiting is told so. */
export function shutdownRasterizer(): void {
  stopped = true;
  dropWindow();
  const canceled = new SlideError("CANCELED", mt("slides.shuttingDown"));
  if (running) settle(running, canceled);
  for (const lane of [lanes.now, lanes.later]) {
    for (const task of lane.splice(0)) task.reject(canceled);
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

type TaskPayload =
  | { op: "open"; targetWidth: number }
  | { op: "render"; page: number; width: number; thumb: boolean; format: PdfFormat; quality: number };

type Task = {
  id: string;
  pdf: PdfSource;
  payload: TaskPayload;
  /** When it was last asked for (`Date.now()`): what `takeNewestBurst` orders by. */
  at: number;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
};

/** `kind` is the window's own coarse classification of a failure — it does not
 *  know `SlideErrorCode`, and nothing here trusts it beyond picking between
 *  two fixed messages. */
type Reply = { id: string; result?: unknown; error?: { kind: "password" | "unknown"; message: string } };

const lanes: Record<RasterLane, Task[]> = { now: [], later: [] };
let running: Task | null = null;
let taskTimer: NodeJS.Timeout | null = null;
let channelRegistered = false;

function registerChannel(): void {
  if (channelRegistered) return;
  channelRegistered = true;
  ipcMain.handle("raster:reply", (_event, reply: Reply) => {
    const task = running;
    if (!task || task.id !== reply.id) return;
    if (reply.error) {
      settle(
        task,
        reply.error.kind === "password"
          ? new SlideError("PDF_PASSWORD", mt("slides.pdfPassword"))
          : new SlideError("RASTER_FAILED", reply.error.message),
      );
    } else {
      settle(task, undefined, reply.result);
    }
  });
}

function enqueue(lane: RasterLane, pdf: PdfSource, payload: TaskPayload): { task: Task | null; done: Promise<unknown> } {
  if (stopped) return { task: null, done: Promise.reject(new SlideError("CANCELED", mt("slides.shuttingDown"))) };
  registerChannel();
  let task: Task | null = null;
  const done = new Promise<unknown>((resolve, reject) => {
    task = { id: randomUUID(), pdf, payload, at: Date.now(), resolve, reject };
    lanes[lane].push(task);
  });
  void pump();
  return { task, done };
}

/** A page still waiting in `now` that a window asks for again joins the newest
 *  ask: the slide on screen was often queued as a warm-up a press earlier. */
function bump(task: Task): void {
  const at = lanes.now.indexOf(task);
  if (at < 0) return; // running, settled, or a thumbnail
  lanes.now.splice(at, 1);
  task.at = Date.now();
  lanes.now.push(task);
}

async function pump(): Promise<void> {
  if (running || stopped) return;
  const task = takeNewestBurst(lanes.now) ?? lanes.later.shift();
  if (idleTimer) clearTimeout(idleTimer);
  if (!task) {
    idleTimer = setTimeout(dropWindow, IDLE_SHUTDOWN_MS);
    idleTimer.unref();
    return;
  }
  running = task;
  try {
    const win = await ensureWindow();
    if (running !== task) return; // the window crashed or the app quit while it loaded
    pendingPdfs.set(task.id, task.pdf.sourcePath);
    // A page that hangs holds the window: it goes, and the next task starts a
    // fresh one. Dropped before settling, so that task never gets this window.
    taskTimer = setTimeout(() => {
      dropWindow();
      settle(task, new SlideError("RASTER_FAILED", mt("slides.rasterHung")));
    }, SLIDES_RASTER_PAGE_TIMEOUT_MS);
    win.webContents.send("raster:task", {
      id: task.id,
      // Which document the window keeps open: the same file, at the same stamp.
      docKey: `${task.pdf.sourcePath}\n${task.pdf.sourceSizeBytes}\n${task.pdf.sourceMtimeMs}`,
      url: `worship://raster/${task.id}`,
      ...task.payload,
    });
  } catch (error) {
    settle(task, error);
  }
}

function settle(task: Task, error: unknown, result?: unknown): void {
  if (running !== task) return;
  running = null;
  if (taskTimer) clearTimeout(taskTimer);
  taskTimer = null;
  pendingPdfs.delete(task.id);
  if (error === undefined) task.resolve(result);
  else task.reject(error);
  void pump();
}

// ---------------------------------------------------------------------------
// What the deck service and the protocol ask for
// ---------------------------------------------------------------------------

/** Every page's size at `targetWidth` — what opening a PDF costs (~25 ms). */
export async function readPdfPages(pdf: PdfSource, targetWidth: number, lane: RasterLane): Promise<PdfPageSize[]> {
  const result = (await enqueue(lane, pdf, { op: "open", targetWidth }).done) as { pages?: unknown };
  const pages = Array.isArray(result?.pages) ? (result.pages as PdfPageSize[]) : [];
  return pages.filter((page) => Number.isFinite(page?.widthPx) && Number.isFinite(page?.heightPx));
}

/** `task`: the draw while it may still be queued, so asking again can `bump` it. */
type CachedPage = { image: Promise<Buffer>; bytes: number; task: Task | null };
/** Insertion-ordered: a hit moves to the end, the oldest settled page goes first. */
const pageCache = new Map<string, CachedPage>();
let cachedBytes = 0;

/**
 * Page `page` (1-based) of a PDF deck, encoded as its deck says — drawn now,
 * or from memory. Keyed by the file's stamp, never by deck id: a deleted
 * deck's id can come back for another file.
 */
export function pdfPageImage(
  deck: PdfSource & { renderWidth: number; imageFormat: PdfFormat },
  page: number,
  variant: "full" | "thumb",
): Promise<Buffer> {
  const thumb = variant === "thumb";
  const width = thumb ? SLIDES_THUMB_WIDTH : deck.renderWidth;
  const key = [deck.sourcePath, deck.sourceSizeBytes, deck.sourceMtimeMs, page, width, deck.imageFormat].join("\n");
  const hit = pageCache.get(key);
  if (hit) {
    pageCache.delete(key);
    pageCache.set(key, hit);
    if (hit.task) bump(hit.task);
    return hit.image;
  }

  const quality = thumb ? 0.7 : deck.imageFormat === "webp" ? 0.92 : 1;
  const { task, done } = enqueue(thumb ? "later" : "now", deck, { op: "render", page, width, thumb, format: deck.imageFormat, quality });
  const image = done.then((data) => {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new SlideError("RASTER_FAILED", mt("slides.noSlides"));
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  });
  const entry: CachedPage = { image, bytes: 0, task };
  pageCache.set(key, entry);
  image.then(
    (buffer) => {
      entry.task = null;
      if (pageCache.get(key) !== entry) return;
      entry.bytes = buffer.byteLength;
      cachedBytes += entry.bytes;
      for (const [oldKey, old] of pageCache) {
        if (cachedBytes <= PAGE_CACHE_BYTES) break;
        if (old.bytes === 0) continue; // still drawing
        pageCache.delete(oldKey);
        cachedBytes -= old.bytes;
      }
    },
    // A failure is not remembered: the next ask draws it again.
    () => {
      if (pageCache.get(key) === entry) pageCache.delete(key);
    },
  );
  return image;
}
