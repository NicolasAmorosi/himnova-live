/**
 * The deck's bar under PREVIEW mounts only once its deck is read, beside the grid that read it, and it read it again:
 * one more `deck:get` per deck put in PREVIEW, whose answer replaced the store's entry and re-rendered every reader of
 * it (2026-11-15 audit, R27). It asks main again only after it changed the deck's music.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { I18nProvider } from "@renderer/lib/i18n/i18n-provider";
import { DeckPreviewBar } from "@renderer/components/pages/slides/deck-slides";
import { useDeckStore } from "@renderer/stores/deck.store";
import type { DeckDTO } from "@shared/types/deck";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("the deck's bar in PREVIEW reads nothing the grid already read, and reads again after a change", async () => {
  const deck = {
    assetId: 41,
    deckId: 5,
    status: "ready",
    slideCount: 2,
    slides: [],
    soundtrack: null,
    sounds: [],
    videos: [],
    autoAdvance: false,
    timingsSource: "none",
    sourceSizeBytes: 0,
    sourceMtimeMs: 0,
  } as unknown as DeckDTO;
  const invoke = vi.fn((channel: string) =>
    Promise.resolve({
      ok: true,
      data: channel === "deck:get" ? deck : channel === "files:pick" ? ["/music/himno.mp3"] : null,
    }),
  );
  (window as unknown as { worship: unknown }).worship = { invoke, on: () => () => {} };
  useDeckStore.setState({
    byAssetId: { 41: { status: "ready", progress: { done: 2, total: 2 }, deck, error: null } },
  });
  const entry = useDeckStore.getState().byAssetId[41];
  const deckGets = (): number => invoke.mock.calls.filter(([channel]) => channel === "deck:get").length;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(() =>
    Promise.resolve(
      root.render(
        createElement(I18nProvider, {
          locale: "es",
          children: createElement(DeckPreviewBar, { assetId: 41, missingSince: null, title: "Culto.pptx" }),
        }),
      ),
    ),
  );
  expect(deckGets()).toBe(0);
  expect(useDeckStore.getState().byAssetId[41], "the store's entry is left alone").toBe(entry);

  // «Asignar audio»: the one button of a deck without music, besides the arrows and the close.
  const assign = [...host.querySelectorAll("button")].find((button) => !button.hasAttribute("aria-label"))!;
  await act(() => Promise.resolve(assign.click()));
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(
    expect.arrayContaining(["files:pick", "library:setLinkedAudio", "deck:get"]),
  );
  expect(deckGets()).toBe(1);
  act(() => root.unmount());
  host.remove();
});
