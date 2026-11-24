/**
 * What a deck that failed to open says under «No se pudo abrir la presentación»: main's worded reason, or nothing.
 * Node's or SQLite's own text crosses IPC as UNKNOWN, in English, and reached the deck panel, PREVIEW and the GO LIVE
 * toast (2026-11-22, EC-2).
 */
import { expect, test, vi } from "vitest";
import { IpcError, toIpcError } from "@shared/ipc/result";

const h = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock("@renderer/lib/api", () => ({ api: { deck: { ensure: h.ensure } } }));

const { useDeckStore } = await import("@renderer/stores/deck.store");

test("a deck that fails keeps main's worded reason, never Node's or SQLite's English", async () => {
  h.ensure.mockRejectedValueOnce(new IpcError(toIpcError(new Error("database or disk is full"))));
  await useDeckStore.getState().ensure(1);
  expect(useDeckStore.getState().byAssetId[1]).toMatchObject({ status: "failed", error: null });

  h.ensure.mockRejectedValueOnce(new IpcError({ code: "DECK_PASSWORD", message: "La presentación tiene contraseña." }));
  await useDeckStore.getState().ensure(2);
  expect(useDeckStore.getState().byAssetId[2]).toMatchObject({ status: "failed", error: "La presentación tiene contraseña." });
});
