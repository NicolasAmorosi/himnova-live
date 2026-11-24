/**
 * A deck whose disk or share did not answer in time (`SOURCE_NOT_RESPONDING`, 2026-11-22 review, RN2-1): one already
 * read stays ready, its slides still in PREVIEW and LIVE; one never read fails saying so, with «Reintentar»; and a
 * GO LIVE that waited on it says why instead of doing nothing.
 */
import { beforeEach, expect, test } from "vitest";
import { goLive } from "@renderer/lib/actions/playback";
import { previewAsset } from "@renderer/lib/actions/preview";
import { useDeckStore } from "@renderer/stores/deck.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useToastStore } from "@renderer/stores/toast.store";
import type { DeckDTO } from "@shared/types/deck";
import type { MediaAsset } from "@shared/types/media";

const SILENT = { code: "SOURCE_NOT_RESPONDING", message: "El disco o la carpeta de la presentación no responde." };
const hymn: MediaAsset = {
  id: 9, kind: "ppt", name: "Himno 9", ext: "pps", path: "/share/9.pps", sizeBytes: 2, mtimeMs: 2, durationMs: null,
  linkedAudioPath: null, inLibrary: true, missingSince: null, createdAt: 0, updatedAt: 0,
};
/** Read when the file was smaller: GO LIVE has to read it again, and waits on main. */
const readBefore = {
  assetId: 9, deckId: 9, status: "ready", sourceSizeBytes: 1, sourceMtimeMs: 1, soundtrack: null, sounds: [], videos: [],
  slides: [{ index: 1, url: "worship://deck/9/1", thumbUrl: "t", modelUrl: null, advanceAfterMs: null, transition: null }],
  autoAdvance: false, slideCount: 1, error: null,
} as unknown as DeckDTO;

const initial = { projection: useProjectionStore.getState(), deck: useDeckStore.getState() };
beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: (channel: string) =>
      Promise.resolve(channel === "deck:ensure" ? { ok: false, error: SILENT } : { ok: true, data: channel === "library:get" ? hymn : null }),
    on: () => () => {},
  };
  useProjectionStore.setState(initial.projection, true);
  useDeckStore.setState(initial.deck, true);
  useToastStore.setState({ toasts: [] });
  usePreviewStore.getState().clear();
  useDisplayStore.setState({ openIfNeeded: async () => {} });
});

const ready = () =>
  useDeckStore.setState({
    byAssetId: { 9: { status: "ready", progress: { done: 1, total: 1 }, deck: readBefore, error: null } },
  });

test("a deck already read stays ready when its source does not answer", async () => {
  ready();
  await useDeckStore.getState().ensure(9);
  expect(useDeckStore.getState().byAssetId[9]).toMatchObject({ status: "ready", deck: readBefore });
});

test("a deck never read fails saying its source does not answer", async () => {
  await useDeckStore.getState().ensure(9);
  expect(useDeckStore.getState().byAssetId[9]).toMatchObject({ status: "failed", error: SILENT.message });
});

test("GO LIVE that waited on a source that does not answer says why, and the projector keeps what it had", async () => {
  ready();
  previewAsset(9, "ppt");
  await goLive();
  expect(useProjectionStore.getState().base).toBeNull();
  await expect.poll(() => useToastStore.getState().toasts.map((toast) => toast.message).join()).toContain(SILENT.message);
});
