/**
 * A model deck's metafiles and fonts were converted on main, synchronously, as `worship://deck/<id>/part|font/` served
 * them: an EMF of 156 bytes (one `ANGLEARC` of 3.4e38 degrees) held main a minute and then took the app down by
 * memory, with the projector and the engine's video on air frozen meanwhile; a real EMF of 24.5 MB was a turn of
 * 200 ms (2026-11-22 audit, SE1). They are read on a thread of their own now, the cache still in front of it on main.
 * The thread is faked here: what reaches main is the point.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { expect, test, vi } from "vitest";
import { decodeEmbeddedFont } from "../../src/main/slides/pptx/embedded-font";
import { metafileToSvg } from "../../src/main/slides/pptx/metafile";

/** The parts and the hymnal threads' clocks, short for the test. */
const CLOCK_MS = 300;
/** How many times the fake hymnal thread beats on a `slow…` hymn before it answers, one every half clock. */
const SLOW_BEATS = 10;

const h = vi.hoisted(() => ({
  dir: "",
  handler: null as ((request: Request) => Promise<Response>) | null,
  decks: new Map<number, { sourcePath: string; sourceSizeBytes: number; sourceMtimeMs: number }>(),
  /** What the fake thread does with a part: answer it, never answer, or die on it. */
  mode: "answer",
  posted: [] as unknown[],
  /** What each thread was started with. */
  spawned: [] as unknown[],
}));
h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-parts-"));

vi.mock("electron", () => ({
  protocol: { handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => (h.handler = handler) },
}));
vi.mock("../../src/main/paths", () => ({
  liveDeckDir: path.join(h.dir, "live"),
  pdfjsWasmDir: h.dir,
  slidesCacheDir: h.dir,
  ooxmlDir: h.dir,
}));
vi.mock("../../src/main/services/repos", () => ({
  getSettingsRepo: () => ({}),
  getSlidesRepo: () => ({ getDeckSource: (id: number) => h.decks.get(id) ?? null }),
  isDatabaseOpen: () => true,
}));
vi.mock("../../src/main/slides/rasterizer", () => ({}));
vi.mock("../../src/main/slides/native-deck", () => ({}));
vi.mock("../../src/main/media/thumbnail-service", () => ({}));
vi.mock("../../src/shared/constants", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  SLIDES_PART_READ_TIMEOUT_MS: CLOCK_MS,
  SLIDES_HYMNAL_READ_TIMEOUT_MS: CLOCK_MS,
}));
// Spied: neither may run on this thread, which stands for main.
vi.mock("../../src/main/slides/pptx/metafile", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/main/slides/pptx/metafile")>();
  return { ...real, metafileToSvg: vi.fn(real.metafileToSvg) };
});
vi.mock("../../src/main/slides/pptx/embedded-font", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/main/slides/pptx/embedded-font")>();
  return { ...real, decodeEmbeddedFont: vi.fn(real.decodeEmbeddedFont) };
});
vi.mock("../../src/main/slides/pptx-worker?nodeWorker", () => ({
  default: (options: unknown) => {
    h.spawned.push(options);
    const worker = Object.assign(new EventEmitter(), {
      unref: () => undefined,
      terminate: () => undefined,
      postMessage(
        request: { id: number; deckPart: { part: string } } | { id: number; sniff: string } | { id: number; unreadable: string },
      ) {
        h.posted.push(request);
        // A hymn's sniff or «why it won't open», by its name: `hung…` never answers (a read that hangs on a share),
        // `slow…` beats as a large hymn read off a slow share does and then answers, any other answers at once.
        if (!("deckPart" in request)) {
          const name = path.basename("sniff" in request ? request.sniff : request.unreadable);
          const reply = "sniff" in request ? { kind: "binary", native: undefined } : { reason: "DECK_PASSWORD" };
          const answer = (): void => void worker.emit("message", { id: request.id, ...reply });
          if (h.mode === "hang" || name.startsWith("hung")) return;
          if (!name.startsWith("slow")) return void setImmediate(answer);
          let beats = 0;
          const tick = (): void => {
            if (++beats > SLOW_BEATS) return answer();
            worker.emit("message", { id: request.id, alive: true });
            setTimeout(tick, CLOCK_MS / 2);
          };
          setTimeout(tick, CLOCK_MS / 2);
          return;
        }
        setImmediate(() => {
          if (h.mode === "die") {
            worker.emit("error", new Error("ERR_WORKER_OUT_OF_MEMORY"));
            worker.emit("exit", 1);
          } else if (h.mode === "answer") {
            const body = new TextEncoder().encode(`<svg>${request.deckPart.part}</svg>`);
            worker.emit("message", { id: request.id, deckPart: { body, type: "image/svg+xml" } });
          }
        });
      },
    });
    return worker;
  },
}));

/** The EMF of the audit: a header, one `ANGLEARC` swept 3.4e38 degrees, and the end. 156 bytes. */
function angleArcEmf(): Uint8Array {
  const emf = Buffer.alloc(156);
  emf.writeUInt32LE(1, 0); // EMR_HEADER
  emf.writeUInt32LE(108, 4);
  emf.writeInt32LE(2540, 24); // rclFrame right, bottom (0.01 mm)
  emf.writeInt32LE(2540, 28);
  emf.writeUInt32LE(0x464d4520, 40);
  emf.writeUInt32LE(0x10000, 44);
  emf.writeUInt32LE(156, 48);
  emf.writeUInt32LE(3, 52);
  emf.writeInt32LE(1920, 72); // szlDevice
  emf.writeInt32LE(1080, 76);
  emf.writeInt32LE(508, 80); // szlMillimeters
  emf.writeInt32LE(285, 84);
  emf.writeUInt32LE(41, 108); // EMR_ANGLEARC: center 50,50, radius 20, start 0, sweep 3.4e38
  emf.writeUInt32LE(28, 112);
  emf.writeInt32LE(50, 116);
  emf.writeInt32LE(50, 120);
  emf.writeUInt32LE(20, 124);
  emf.writeUInt32LE(0x7f7fc99e, 132);
  emf.writeUInt32LE(14, 136); // EMR_EOF
  emf.writeUInt32LE(20, 140);
  emf.writeUInt32LE(16, 148);
  emf.writeUInt32LE(20, 152);
  return emf;
}

function deck(id: number): void {
  const sourcePath = path.join(h.dir, `deck-${id}.pptx`);
  fs.writeFileSync(
    sourcePath,
    zipSync({ "ppt/media/image1.emf": angleArcEmf(), "ppt/fonts/font1.fntdata": new Uint8Array([1, 2, 3, 4]) }),
  );
  const stat = fs.statSync(sourcePath);
  h.decks.set(id, { sourcePath, sourceSizeBytes: stat.size, sourceMtimeMs: Math.trunc(stat.mtimeMs) });
}

async function ask(id: number, kind: "part" | "font", part: string): Promise<{ status: number; body: string }> {
  if (!h.handler) {
    const { registerWorshipProtocolHandler } = await import("../../src/main/protocol/worship-protocol");
    registerWorshipProtocolHandler({} as Parameters<typeof registerWorshipProtocolHandler>[0]);
  }
  const response = await h.handler!(new Request(`worship://deck/${id}/${kind}/${encodeURIComponent(part)}`));
  return { status: response.status, body: await response.text() };
}

test("a deck's metafile and font are converted off main, and four windows asking are one read", async () => {
  h.mode = "answer";
  h.posted = [];
  deck(1);
  const windows = await Promise.all([1, 2, 3, 4].map(() => ask(1, "part", "ppt/media/image1.emf")));
  expect(metafileToSvg).not.toHaveBeenCalled();
  expect(windows).toEqual([1, 2, 3, 4].map(() => ({ status: 200, body: "<svg>ppt/media/image1.emf</svg>" })));
  expect(await ask(1, "font", "ppt/fonts/font1.fntdata")).toEqual({
    status: 200,
    body: "<svg>ppt/fonts/font1.fntdata</svg>",
  });
  expect(decodeEmbeddedFont).not.toHaveBeenCalled();
  expect(h.posted).toHaveLength(2);
  // Already converted: answered from main's cache, the thread not asked again.
  expect((await ask(1, "part", "ppt/media/image1.emf")).status).toBe(200);
  expect(h.posted).toHaveLength(2);
});

test("a part whose thread never answers is missing within the clock, and one that kills it unreadable, never read on main", async () => {
  h.mode = "hang";
  h.posted = [];
  deck(2);
  const started = performance.now();
  expect((await ask(2, "part", "ppt/media/image1.emf")).status).toBe(404);
  expect(performance.now() - started).toBeLessThan(CLOCK_MS + 500);
  // Too slow says nothing about the file (a pen drive slow for a moment): not kept, the next ask goes to a thread again.
  expect((await ask(2, "part", "ppt/media/image1.emf")).status).toBe(404);
  expect(h.posted).toHaveLength(2);

  // A thread that dies on a part: kept as unreadable, neither read on main nor handed to a thread again.
  h.mode = "die";
  expect((await ask(2, "font", "ppt/fonts/font1.fntdata")).status).toBe(415);
  expect((await ask(2, "font", "ppt/fonts/font1.fntdata")).status).toBe(415);
  expect(h.posted).toHaveLength(3);
  expect(metafileToSvg).not.toHaveBeenCalled();
  expect(decodeEmbeddedFont).not.toHaveBeenCalled();
});

test("a hymn read ahead whose thread never answers is too slow within the hymnal's own clock, not a deck's minute", async () => {
  // A hymn on a share that stopped answering held the hymnal's thread, and every hymn behind it, 60 s (review, RN-7).
  h.mode = "hang";
  try {
    const { sniffDeck } = await import("../../src/main/slides/pptx-deck");
    const started = performance.now();
    expect(await sniffDeck(path.join(h.dir, "hymn.pps"), true, "later")).toBe("too-slow");
    expect(performance.now() - started).toBeLessThan(CLOCK_MS + 500);
  } finally {
    h.mode = "answer";
  }
});

test("the hymnal has one clock without a beat: a hymn still reading is never cut, a hung one is in either lane", async () => {
  // With a deck's 60 s for what the operator waits on, a hymn whose read hung held the hymnal's only thread, and the
  // next hymn the operator chose waited 55 s behind it, measured on Windows (2026-11-22 review, RN3-2).
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { hurryDeck, sniffDeck, unreadableReason } = await import("../../src/main/slides/pptx-deck");
    const answers = new Map<string, unknown>();
    const sniff = (name: string, lane: "now" | "later") =>
      void sniffDeck(path.join(h.dir, name), true, lane).then((answer) => answers.set(name, answer));
    const wait = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
    };

    // A large hymn the operator waits on, read off a slow share: five clocks long, beating all along.
    sniff("slow.pps", "now");
    await wait(CLOCK_MS * 3);
    expect(answers.has("slow.pps")).toBe(false);
    await wait(CLOCK_MS * (SLOW_BEATS + 1) * 0.5 - CLOCK_MS * 3 + 50);
    expect(answers.get("slow.pps")).toMatchObject({ kind: "binary" });

    // The measured case: A's read-ahead starts, the operator hurries it, and then chooses B, not read yet.
    sniff("hung-a.pps", "later");
    hurryDeck(path.join(h.dir, "hung-a.pps"));
    sniff("b.pps", "now");
    await wait(CLOCK_MS - 50);
    expect(answers.size).toBe(1);
    await wait(100);
    expect(answers.get("hung-a.pps")).toBe("too-slow");
    // B, on a new thread, answers within A's clock: not 55 s behind it.
    expect(answers.get("b.pps")).toMatchObject({ kind: "binary" });

    // Asked straight in `now`, the sniff and «why it won't open» alike: the same clock, one after the other.
    sniff("hung-now.pps", "now");
    void unreadableReason(path.join(h.dir, "hung-why.pps"), "now").then((answer) => answers.set("hung-why.pps", answer));
    await wait(CLOCK_MS + 50);
    expect(answers.get("hung-now.pps")).toBe("too-slow");
    expect(answers.has("hung-why.pps")).toBe(false);
    await wait(CLOCK_MS);
    expect(answers.get("hung-why.pps")).toBe("too-slow");
  } finally {
    vi.useRealTimers();
  }
});

test("on its thread, the EMF of the audit is converted to an SVG whose bytes cross to main moved, not copied", async () => {
  deck(3);
  const { readDeckPart } = await import("../../src/main/slides/pptx-worker");
  const found = readDeckPart(h.decks.get(3)!.sourcePath, "part", "ppt/media/image1.emf");
  if (typeof found === "number") throw new Error(`no SVG: ${found}`);
  expect(found.type).toBe("image/svg+xml");
  expect(new TextDecoder().decode(found.body)).toMatch(/^<svg/);
  // Its own buffer, whole: moving it to main moves no more than the SVG.
  expect(found.body.buffer.byteLength).toBe(found.body.byteLength);
  expect(readDeckPart(h.decks.get(3)!.sourcePath, "part", "ppt/media/missing.png")).toBe(404);
});

test("a deck thread, which lives the whole session, starts with a small young generation (2026-11-22 audit, ME-3)", async () => {
  // At V8's default it grew to 128 MB within ten or so model reads, nearly all of it empty and kept for good.
  // A part of a deck never asked, so a thread is started even when this test runs alone.
  h.mode = "answer";
  deck(4);
  expect((await ask(4, "part", "ppt/media/image1.emf")).status).toBe(200);
  expect(h.spawned.length).toBeGreaterThan(0);
  for (const options of h.spawned) expect(options).toMatchObject({ resourceLimits: { maxYoungGenerationSizeMb: 16 } });
});
