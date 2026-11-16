/**
 * «Reconvertir» never touches the deck on air: not through its own library entry, and not through another entry of
 * the same file either, which shares the deck (2026-11-15 audit, A12). Reading it again replaced the folder and the
 * ids its music on air was playing from.
 */
import { beforeEach, expect, test, vi } from "vitest";
import { reconvertDeck } from "@renderer/lib/actions/deck";
import { useDeckStore, type DeckEntry } from "@renderer/stores/deck.store";
import { useProjectionStore, type LiveDeck } from "@renderer/stores/projection.store";

const ensure = vi.fn(() => Promise.resolve(null));
const entry = (deckId: number) => ({ status: "ready", progress: { done: 3, total: 3 }, deck: { deckId }, error: null }) as unknown as DeckEntry;

beforeEach(() => {
  ensure.mockClear();
  // Entry 1 on air; entry 2 is a copy of the same file, so the same deck (7); entry 3 is another deck.
  useProjectionStore.setState({
    base: { kind: "deck", assetId: 1, slideIndex: 1 },
    liveDeck: { assetId: 1, deckId: 7 } as unknown as LiveDeck,
  });
  useDeckStore.setState({ ensure, byAssetId: { 1: entry(7), 2: entry(7), 3: entry(8) } });
});

test("the deck on air is not converted again through another entry of the same file", () => {
  reconvertDeck(2);
  reconvertDeck(1);
  expect(ensure).not.toHaveBeenCalled();
});

test("another deck is, and an entry not opened yet is told apart by its own entry", () => {
  reconvertDeck(3);
  reconvertDeck(4);
  expect(ensure.mock.calls).toEqual([
    [3, true],
    [4, true],
  ]);
});
