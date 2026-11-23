/**
 * The copy of the deck on air (`keepLiveDeckSource`) is what its slides are read from once its file is gone (a pen
 * drive pulled). Deck A on air, GO LIVE of B whose copy is slow, then back to A before it ends: B's copy used to land
 * anyway, replacing A's and deleting it, so A on air had no copy (2026-11-15 audit, A47).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  dir: "",
  asked: 0,
  decks: new Map<number, { sourcePath: string; sourceSizeBytes: number; sourceMtimeMs: number }>(),
  handler: null as ((request: Request) => Promise<Response>) | null,
}));
h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-deck-"));
const LIVE = path.join(h.dir, "live-deck");

vi.mock("electron", () => ({
  protocol: { handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => (h.handler = handler) },
}));
vi.mock("../../src/main/paths", () => ({ liveDeckDir: LIVE, pdfjsWasmDir: h.dir, slidesCacheDir: h.dir }));
vi.mock("../../src/main/services/repos", () => ({
  getSettingsRepo: () => ({}),
  getSlidesRepo: () => ({
    getDeckById: (id: number) => {
      h.asked += 1;
      return h.decks.get(id) ?? null;
    },
  }),
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
  for (const id of [1, 2, 3, 4]) deck(id);
  // A's copy settled: its size checked (`stat` of the copy), then it is the one kept, synchronously after that.
  const realStat = fs.promises.stat.bind(fs.promises);
  const checked: Promise<unknown>[] = [];
  const stat = vi.spyOn(fs.promises, "stat").mockImplementation((target: fs.PathLike) => {
    const done = realStat(target);
    // The copy is written beside its place (`1.pptx.<n>.partial`) and renamed into it.
    if (String(target).startsWith(path.join(LIVE, "1.pptx"))) checked.push(done);
    return done;
  });
  keepLiveDeckSource(1);
  await vi.waitFor(() => expect(checked).toHaveLength(1));
  await checked[0];
  await vi.waitFor(() => expect(kept()).toEqual(["1.pptx"]));
  await new Promise((resolve) => setImmediate(resolve));
  stat.mockRestore();

  // B's copy waits until released: a slow pen drive. Settled once its chain removes a file: B's own copy dropped,
  // or A's replaced by it.
  const realCopy = fs.promises.copyFile.bind(fs.promises);
  const realRm = fs.promises.rm.bind(fs.promises);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const copyFile = vi.spyOn(fs.promises, "copyFile").mockImplementation(async (from, to) => {
    await gate;
    return realCopy(from, to);
  });
  const removed: Promise<void>[] = [];
  const rm = vi.spyOn(fs.promises, "rm").mockImplementation((target, options) => {
    const done = realRm(target, options);
    removed.push(done);
    return done;
  });
  keepLiveDeckSource(2);
  await vi.waitFor(() => expect(copyFile).toHaveBeenCalledTimes(1));
  keepLiveDeckSource(1);
  release();
  await vi.waitFor(() => expect(rm).toHaveBeenCalledTimes(1));
  await Promise.all(removed);
  expect(kept()).toEqual(["1.pptx"]);

  // A, B (slow), A and B again inside that copy: B's copy under way is B's again, no second one to the same file.
  copyFile.mockClear();
  rm.mockClear();
  removed.length = 0;
  let releaseB!: () => void;
  const gateB = new Promise<void>((resolve) => (releaseB = resolve));
  copyFile.mockImplementation(async (from, to) => {
    await gateB;
    return realCopy(from, to);
  });
  keepLiveDeckSource(2);
  await vi.waitFor(() => expect(copyFile).toHaveBeenCalledTimes(1));
  keepLiveDeckSource(1);
  const asked = h.asked;
  keepLiveDeckSource(2);
  expect(h.asked).toBe(asked);
  releaseB();
  await vi.waitFor(() => expect(rm).toHaveBeenCalledTimes(1));
  await Promise.all(removed);
  expect(kept()).toEqual(["2.pptx"]);
  copyFile.mockRestore();
  rm.mockRestore();

  // A deck shown again while its own copy is under way (every slide is a show) still gets it.
  keepLiveDeckSource(3);
  keepLiveDeckSource(3);
  await vi.waitFor(() => expect(kept()).toEqual(["3.pptx"]));
});

test("a second copy of the deck on air that fails mid-write leaves the copy that landed whole", async () => {
  const { keepLiveDeckSource } = await import("../../src/main/protocol/worship-protocol");
  for (const id of [5, 6]) deck(id);
  // D (5) from a slow drive, E (6) while it copies, D again: a second copy of D starts, to the same place. The second
  // lands; then the first, its drive pulled, fails after writing half the file over the copy that landed, and D on air
  // read its slides from a broken file (final pass of the 2026-11-15 audit, A47).
  const realCopy = fs.promises.copyFile.bind(fs.promises);
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
  let calls = 0;
  let firstDone!: Promise<void>;
  const copyFile = vi.spyOn(fs.promises, "copyFile").mockImplementation((from, to) => {
    calls += 1;
    if (calls !== 1) return realCopy(from, to);
    firstDone = (async () => {
      await gate;
      fs.writeFileSync(to, "de");
      throw Object.assign(new Error("EIO: the drive went away"), { code: "EIO" });
    })();
    return firstDone;
  });
  keepLiveDeckSource(5);
  await vi.waitFor(() => expect(calls).toBe(1));
  keepLiveDeckSource(6);
  keepLiveDeckSource(5);
  await vi.waitFor(() => expect(kept()).toContain("5.pptx"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  releaseFirst();
  await firstDone.catch(() => undefined);
  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  await new Promise((resolve) => setImmediate(resolve));
  expect(fs.readFileSync(path.join(LIVE, "5.pptx"), "utf8")).toBe("deck 5");
  expect(kept()).toEqual(["5.pptx"]);
  warn.mockRestore();
  copyFile.mockRestore();
});

test("the music of the hymn on air plays on from its copy once its file is gone (2026-11-22 audit, RV-4)", async () => {
  const { keepLiveDeckSource, liveMusicFile, registerWorshipProtocolHandler } = await import(
    "../../src/main/protocol/worship-protocol"
  );
  const music = path.join(h.dir, "Himno 522.mp3");
  fs.writeFileSync(music, "the hymn's music");
  // `worship://linked-audio/<asset>` names the deck's asset; its music is the file beside it (`linked-audio.ts`).
  registerWorshipProtocolHandler({
    survivingId: (id: number) => id,
    linkedAudioPathById: (id: number) => (id === 522 ? music : null),
  } as unknown as Parameters<typeof registerWorshipProtocolHandler>[0]);
  await vi.waitFor(() => expect(fs.existsSync(LIVE)).toBe(false)); // a previous run's copies, cleared at start
  const play = async () => {
    const response = await h.handler!(new Request("worship://linked-audio/522", { headers: { Range: "bytes=4-" } }));
    return { status: response.status, body: await response.text() };
  };

  deck(7);
  keepLiveDeckSource(7, music);
  await vi.waitFor(() => expect(kept()).toEqual(["7.pptx", "7.pptx.music.mp3"]));
  expect(await liveMusicFile(music)).toBe(music); // its own file while it is still there
  // The pen drive pulled mid-hymn: the next bytes the player asks for, and what the engine opens (a `.wma`).
  fs.rmSync(music);
  expect(await play()).toEqual({ status: 206, body: "hymn's music" });
  expect(await liveMusicFile(music)).toBe(path.join(LIVE, "7.pptx.music.mp3"));
  // Its drive back with the file as it was: the file itself again.
  fs.writeFileSync(music, "the hymn's music");
  expect(await liveMusicFile(music)).toBe(music);

  // Another deck on air takes the music copy with it, and music that is not the deck on air's is never redirected.
  deck(8);
  keepLiveDeckSource(8);
  await vi.waitFor(() => expect(kept()).toEqual(["8.pptx"]));
  expect(await liveMusicFile(music)).toBe(music);
});

test("a hymn's music the operator replaced plays in its new version and is copied again (review of the night, RN-5)", async () => {
  const { keepLiveDeckSource, registerWorshipProtocolHandler } = await import("../../src/main/protocol/worship-protocol");
  const music = path.join(h.dir, "Himno 523.mp3");
  fs.writeFileSync(music, "the wrong track");
  fs.mkdirSync(LIVE, { recursive: true }); // so the wait below is for the clear at start, also when run alone
  registerWorshipProtocolHandler({
    survivingId: (id: number) => id,
    linkedAudioPathById: (id: number) => (id === 523 ? music : null),
  } as unknown as Parameters<typeof registerWorshipProtocolHandler>[0]);
  await vi.waitFor(() => expect(fs.existsSync(LIVE)).toBe(false)); // the copies before, cleared at start
  const play = async () => (await h.handler!(new Request("worship://linked-audio/523"))).text();
  const copy = path.join(LIVE, "9.pptx.music.mp3");

  deck(9);
  keepLiveDeckSource(9, music);
  await vi.waitFor(() => expect(fs.existsSync(copy) && fs.readFileSync(copy, "utf8")).toBe("the wrong track"));

  // The operator puts the right one under the same name (another size) and shows the hymn again: PREVIEW and the
  // projector play it, and its copy is taken again without copying the deck itself.
  fs.writeFileSync(music, "the right track, at last");
  expect(await play()).toBe("the right track, at last");
  const copyFile = vi.spyOn(fs.promises, "copyFile");
  keepLiveDeckSource(9, music);
  await vi.waitFor(() => expect(fs.readFileSync(copy, "utf8")).toBe("the right track, at last"));
  expect(copyFile.mock.calls.map(([from]) => from)).toEqual([music]);
  copyFile.mockRestore();

  // Then its pen drive pulled: the right one plays on.
  fs.rmSync(music);
  await vi.waitFor(async () => expect(await play()).toBe("the right track, at last"));
});
