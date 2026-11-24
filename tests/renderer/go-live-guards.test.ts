/**
 * GO LIVE guards that nothing else in the suite would see break (2026-11-22 audit, TQ4 to TQ6, TQ9, TQ10 and TQ12):
 * each test fails on the mutant the audit named. What the operator does while the projector opens or a deck is read
 * wins; an old video's end clears nothing new; an audio never cancels a deck; CLEAR and «Sacar del aire» stick.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearBaseContent, clearLive, goLive } from "@renderer/lib/actions/playback";
import { previewAsset, previewScheduleItem, previewVerse } from "@renderer/lib/actions/preview";
import { startEndOfPlaybackEffects } from "@renderer/effects/end-of-playback";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useDeckStore } from "@renderer/stores/deck.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { DEFAULT_SETTINGS } from "@shared/types/settings";
import type { DeckDTO } from "@shared/types/deck";
import type { MediaAsset } from "@shared/types/media";
import type { ProgramItemDTO } from "@shared/types/program";
import { assetUrl } from "@shared/urls";

const asset = (id: number, kind: MediaAsset["kind"]): MediaAsset => ({
  id, kind, name: `asset ${id}`, ext: kind === "audio" ? "mp3" : "png", path: `/media/${id}`, sizeBytes: 1, mtimeMs: 1,
  durationMs: null, linkedAudioPath: null, inLibrary: true, missingSince: null, createdAt: 0, updatedAt: 0,
});
const ASSETS = [asset(1, "image"), asset(2, "image"), asset(3, "image"), asset(4, "audio"), asset(5, "video"), asset(6, "video")];
const row = (id: number, mediaAssetId: number): ProgramItemDTO => ({ id, position: id, kind: "media", mediaAssetId, title: null });
const readyDeck = { assetId: 9, deckId: 9, status: "ready", slides: [{ index: 1, url: "worship://deck/9/1", thumbUrl: "t", modelUrl: null, advanceAfterMs: null, transition: null }], soundtrack: null, sounds: [], videos: [], autoAdvance: false, slideCount: 1, error: null } as unknown as DeckDTO;

const initial = { projection: useProjectionStore.getState(), program: useProgramStore.getState(), audio: useAudioStore.getState(), deck: useDeckStore.getState() };
let stop: () => void = () => {};
beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: (channel: string, req: { id?: number; chapter?: number }) =>
      Promise.resolve({
        ok: true,
        data: channel === "library:get" ? (ASSETS.find((a) => a.id === req.id) ?? null)
          : channel === "bible:chapter" ? Array.from({ length: 20 }, (_, i) => ({ id: i, bookId: 43, bookName: "Juan", chapter: req.chapter ?? 1, verse: i + 1, text: `v${i + 1}` }))
          : null,
      }),
    on: () => () => {},
  };
  useProjectionStore.setState(initial.projection, true);
  useProgramStore.setState(initial.program, true);
  useAudioStore.setState(initial.audio, true);
  useDeckStore.setState(initial.deck, true);
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  usePreviewStore.getState().clear();
  useDisplayStore.setState({ openIfNeeded: async () => {} });
});
afterEach(() => stop());

/** A deck read that ends only when the test says so. */
function slowDeck(): () => void {
  let done: () => void = () => {};
  useDeckStore.setState({ ensure: () => new Promise((resolve) => (done = () => resolve(readyDeck))) as never });
  return () => done();
}

// P3 (preview.ts:142): the existing test picks row 1, which is exactly the row «Lo que sigue» leaves, so it cannot tell.
test("the row picked while the projector opens stays in PREVIEW even when it is not the next one", async () => {
  useProgramStore.setState({ items: [row(10, 1), row(11, 2), row(12, 3)] });
  let open: () => void = () => {};
  useDisplayStore.setState({ openIfNeeded: () => new Promise<void>((resolve) => (open = resolve)) });
  previewScheduleItem(0);
  const pressed = goLive();
  previewScheduleItem(2);
  open();
  await pressed;
  expect(useProgramStore.getState().selectedIndex).toBe(2);
});

// P7 (playback.ts:531): a video ends on «siguiente», the next row is a deck still being read, the operator sends a
// picture meanwhile. The chain gives up, and must not take the operator's picture down to the logo.
test("what the operator sent while the chained deck was read stays up, not the logo", async () => {
  stop = startEndOfPlaybackEffects();
  const read = slowDeck();
  useProgramStore.setState({ items: [row(10, 5), { id: 11, position: 11, kind: "ppt", mediaAssetId: 9, title: "Himno" }], activeIndex: 0 });
  const store = useProjectionStore.getState();
  store.setVideoEnd("next");
  store.setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 2, startAtSeconds: 0 });
  store.setMediaStatus({ target: { kind: "video" }, epoch: 2, currentTimeSeconds: 8, durationSeconds: 8, paused: true, ended: true });
  previewAsset(1, "image");
  await goLive();
  read();
  await vi.waitFor(() => expect(useProjectionStore.getState().base).toMatchObject({ kind: "image", assetId: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "image", assetId: 1 });
  expect(useProjectionStore.getState().overlay).toBe("none");
});

// P12 (end-of-playback.ts:31): video A ended to the logo; its sticky `ended` must not take video B off as it goes up.
test("a video sent after one that ended is not cleared by the old one's end", () => {
  stop = startEndOfPlaybackEffects();
  const store = useProjectionStore.getState();
  store.setVideoEnd("logo");
  store.setBase({ kind: "video", assetId: 5, url: assetUrl(5), epoch: 2, startAtSeconds: 0 });
  store.setMediaStatus({ target: { kind: "video" }, epoch: 2, currentTimeSeconds: 8, durationSeconds: 8, paused: true, ended: true });
  expect(useProjectionStore.getState().base).toBeNull();
  useProjectionStore.getState().setBase({ kind: "video", assetId: 6, url: assetUrl(6), epoch: 3, startAtSeconds: 0 });
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "video", assetId: 6 });
});

// P9 (playback.ts:631): the accompaniment sent while the hymn's deck is read must not cancel the hymn.
test("an audio sent while a deck is being read leaves the deck to go up", async () => {
  const read = slowDeck();
  previewAsset(9, "ppt");
  const deck = goLive();
  previewAsset(4, "audio");
  await goLive();
  read();
  await deck;
  expect(useProjectionStore.getState().base).toMatchObject({ kind: "deck", assetId: 9 });
  expect(useAudioStore.getState().tracks.map((t) => t.assetId)).toContain(4);
});

// P8 (playback.ts:649): CLEAR pressed while the projector opens for a verse wins; the verse does not go out after it.
test("CLEAR pressed while the projector opens for a verse keeps the verse off", async () => {
  await useBibleStore.getState().setBookAndChapter(43, 3);
  let open: () => void = () => {};
  useDisplayStore.setState({ openIfNeeded: () => new Promise<void>((resolve) => (open = resolve)) });
  previewVerse(15);
  const pressed = goLive();
  clearLive();
  open();
  await pressed;
  expect(useProjectionStore.getState().base).toBeNull();
});

// clearBaseContentUnder (playback.ts:818): «Sacar del aire» on a hymn with music takes its music with it.
test("taking a deck with music off the air silences its music", async () => {
  previewAsset(9, "ppt");
  useDeckStore.setState({ ensure: () => Promise.resolve({ ...readyDeck, soundtrack: { url: "worship://deck-audio/9", durationMs: null, origin: "linked", name: "a.mp3" } }) as never });
  await goLive();
  expect(useAudioStore.getState().tracks.map((t) => t.trackId)).toContain("deck-soundtrack");
  clearBaseContent();
  expect(useAudioStore.getState().tracks.map((t) => t.trackId)).not.toContain("deck-soundtrack");
});
