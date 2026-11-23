/**
 * The library that cannot be read: under «No se pudo leer la biblioteca» the hint was SQLite's own English
 * («database disk image is malformed») or Node's (2026-11-22 review, EC-5).
 */
import { expect, test, vi } from "vitest";
import { folderAssetsKey, useLibraryStore } from "@renderer/stores/library.store";
import es from "../../src/renderer/src/lib/i18n/messages/es";

test("a library that cannot be read hints what to do in the operator's words, never SQLite's", async () => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn(() =>
      Promise.resolve({ ok: false, error: { code: "UNKNOWN", message: "database disk image is malformed" } }),
    ),
    on: vi.fn(() => () => undefined),
  };
  await useLibraryStore.getState().refresh("video");
  expect(useLibraryStore.getState().viewStatus.video).toEqual({ error: es.library.loadFailedHint, loading: false });
  await useLibraryStore.getState().refreshFolder("video", "/media/himnos");
  expect(useLibraryStore.getState().viewStatus[folderAssetsKey("video", "/media/himnos")]).toEqual({
    error: es.library.loadFailedHint,
    loading: false,
  });
});
