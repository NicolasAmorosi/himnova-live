/**
 * What is on air is never cut to black by a file that went away (2026-11-22 audit, RV-2 and RV-3). The sweep marks a
 * missing file on focus and every 5 minutes, so GO LIVE looks at the file itself before it cuts: a file gone since
 * is refused the way one already marked is, and what the congregation sees stays.
 */
import { beforeEach, expect, test, vi } from "vitest";
import { goLive } from "@renderer/lib/actions/playback";
import { previewScheduleItem } from "@renderer/lib/actions/preview";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useDeckStore, type DeckEntry } from "@renderer/stores/deck.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useToastStore } from "@renderer/stores/toast.store";
import type { DeckDTO } from "@shared/types/deck";
import type { MediaAsset } from "@shared/types/media";
import type { ProgramItemDTO } from "@shared/types/program";
import { mediaErrorKey } from "@shared/types/projection";
import { slideUrl } from "@shared/urls";

const asset = (id: number, kind: MediaAsset["kind"]): MediaAsset => ({
  id,
  kind,
  name: `asset ${id}`,
  ext: kind === "video" ? "mp4" : kind === "ppt" ? "pptx" : "png",
  path: `/media/${id}`,
  sizeBytes: 1,
  mtimeMs: 1,
  durationMs: null,
  linkedAudioPath: null,
  inLibrary: true,
  missingSince: null,
  createdAt: 0,
  updatedAt: 0,
});

/** A deck of two slides read from its file at `(1, mtimeMs)`. */
const deck = (assetId: number, deckId: number, mtimeMs = 1): DeckDTO => ({
  assetId,
  deckId,
  status: "ready",
  slideCount: 2,
  slides: [1, 2].map((index) => ({ index, url: slideUrl(deckId, index), thumbUrl: "", modelUrl: null, advanceAfterMs: null, transition: null })),
  soundtrack: null,
  sounds: [],
  videos: [],
  autoAdvance: false,
  timingsSource: "none",
  sourceSizeBytes: 1,
  sourceMtimeMs: mtimeMs,
  convertedAt: 0,
  error: null,
});
const ready = (d: DeckDTO): DeckEntry => ({ status: "ready", progress: { done: 2, total: 2 }, deck: d, error: null });

/** The rows as the last sweep left them, and the files as they are on disk now (what a `check` answers). */
let swept: MediaAsset[] = [];
let onDisk: MediaAsset[] = [];
/** What main reads the deck's file as now. */
let ensured: DeckDTO | null = null;

const media = (id: number, mediaAssetId: number): ProgramItemDTO => ({ id, position: id, kind: "media", mediaAssetId, title: null });
const ppt = (id: number, mediaAssetId: number): ProgramItemDTO => ({ id, position: id, kind: "ppt", mediaAssetId, title: null });

const initialProjection = useProjectionStore.getState();
const initialProgram = useProgramStore.getState();
const initialAudio = useAudioStore.getState();
const initialDeck = useDeckStore.getState();

beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn((channel: string, req: { id?: number; check?: boolean }) => {
      const rows = req.check ? onDisk : swept;
      const data =
        channel === "library:get" ? (rows.find((a) => a.id === req.id) ?? null) : channel === "deck:ensure" ? ensured : null;
      return Promise.resolve({ ok: true, data });
    }),
    on: () => () => {},
  };
  useProjectionStore.setState(initialProjection, true);
  useProgramStore.setState(initialProgram, true);
  useAudioStore.setState(initialAudio, true);
  useDeckStore.setState(initialDeck, true);
  useToastStore.setState({ toasts: [] });
  usePreviewStore.getState().clear();
  useDisplayStore.setState({ openIfNeeded: async () => {} });
});

const verseOnAir = () =>
  useProjectionStore.getState().setBase({ kind: "bible", text: "Juan 3:16", reference: "Juan 3:16", versionLabel: null, parallel: null });

test.each([
  ["a video", "video"],
  ["an image", "image"],
] as const)("%s gone since the last sweep never takes the verse off the projector", async (_, kind) => {
  swept = [asset(5, kind)];
  onDisk = [{ ...asset(5, kind), missingSince: 123 }]; // the pendrive pulled two minutes ago
  verseOnAir();
  useProgramStore.setState({ items: [media(10, 5)] });
  previewScheduleItem(0);
  await goLive();

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "bible", reference: "Juan 3:16" });
  expect(useProgramStore.getState().activeIndex).toBeNull();
  expect(useToastStore.getState().toasts.map((t) => t.tone)).toEqual(["warning"]);
});

test("a deck read before its file was edited goes out read again, never with the slides main no longer serves", async () => {
  // Read before the service (deck 100); someone fixed the sermon on another PC during the praise.
  swept = [asset(7, "ppt")];
  onDisk = [{ ...asset(7, "ppt"), mtimeMs: 2 }];
  useDeckStore.setState({ byAssetId: { 7: ready(deck(7, 100)) } });
  ensured = deck(7, 101, 2);
  useProgramStore.setState({ items: [ppt(11, 7)] });
  previewScheduleItem(0);
  await goLive();

  expect(useProjectionStore.getState().liveDeck?.deckId).toBe(101);
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "deck", assetId: 7 });
});

test("a deck read before its file went away never takes the verse off the projector", async () => {
  swept = [asset(7, "ppt")];
  onDisk = [{ ...asset(7, "ppt"), missingSince: 123 }];
  useDeckStore.setState({ byAssetId: { 7: ready(deck(7, 100)) } });
  ensured = null;
  verseOnAir();
  useProgramStore.setState({ items: [ppt(11, 7)] });
  previewScheduleItem(0);
  await goLive();

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "bible", reference: "Juan 3:16" });
  expect(useProjectionStore.getState().liveDeck).toBeNull();
  expect(useToastStore.getState().toasts.map((t) => t.tone)).toEqual(["warning"]);
});

test("GO LIVE on the deck on air whose slides stopped drawing sends it again, read from its file as it is now", async () => {
  swept = [asset(7, "ppt")];
  onDisk = [asset(7, "ppt")];
  useDeckStore.setState({ byAssetId: { 7: ready(deck(7, 100)) } });
  useProgramStore.setState({ items: [ppt(11, 7)] });
  previewScheduleItem(0);
  await goLive();
  expect(useProjectionStore.getState().liveDeck?.deckId).toBe(100);

  // Healthy, picked again: only uncovered, never sent again (2026-11-15 audit, A3).
  previewScheduleItem(0);
  await goLive();
  expect(useProjectionStore.getState().liveDeck?.deckId).toBe(100);

  // Its file edited under it before its copy was kept: the projector's next slide answers 410.
  onDisk = [{ ...asset(7, "ppt"), mtimeMs: 2 }];
  ensured = deck(7, 101, 2);
  useProjectionStore.getState().setMediaError({ target: { kind: "scene" }, url: slideUrl(100, 2), code: null });
  previewScheduleItem(0);
  await goLive();
  expect(useProjectionStore.getState().liveDeck?.deckId).toBe(101);
  expect(useProjectionStore.getState().mediaErrors[mediaErrorKey({ kind: "scene" })]).toBeUndefined();
});
