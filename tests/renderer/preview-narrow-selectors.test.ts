/**
 * The Bible, Utilities and Plates tabs read the whole PREVIEW target, so every click on a slide, a song or a schedule
 * row re-rendered them, hidden or not (2026-11-15 audit, R28): the narrow selector Songs got in the 2026-11-10 review
 * (agent7-03). Each reads only the id of its own kind now.
 */
import { act, createElement, Profiler, type FunctionComponent } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test, vi } from "vitest";
import { I18nProvider } from "@renderer/lib/i18n/i18n-provider";
import { BibleBrowser } from "@renderer/components/pages/resources/bible-browser";
import { OverlaysPanel } from "@renderer/components/pages/functions/overlays-panel";
import { UtilitiesPanel } from "@renderer/components/pages/functions/utilities-panel";
import { usePreviewStore, type PreviewTarget } from "@renderer/stores/preview.store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn(() => Promise.resolve({ ok: true, data: null })),
    on: () => () => {},
  };
  usePreviewStore.getState().clear();
});

const unrelated: PreviewTarget[] = [
  { kind: "scheduleItem" },
  { kind: "asset", assetId: 3, assetKind: "image" },
  { kind: "song", songId: 4 },
  { kind: "asset", assetId: 5, assetKind: "video" },
];

test.each<[string, FunctionComponent, PreviewTarget]>([
  ["Bible", BibleBrowser, { kind: "verse", verseIndex: 2 }],
  ["Utilities", UtilitiesPanel, { kind: "utility", sceneId: 2 }],
  ["Plates", OverlaysPanel, { kind: "plate", plateId: 2 }],
])("%s re-renders only for a PREVIEW target of its own kind", async (_name, Panel, own) => {
  let commits = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(() =>
    Promise.resolve(
      root.render(
        createElement(I18nProvider, {
          locale: "es",
          children: createElement(Profiler, { id: "panel", onRender: () => void (commits += 1) }, createElement(Panel)),
        }),
      ),
    ),
  );
  const mounted = commits;
  for (const target of unrelated) act(() => usePreviewStore.setState({ target }));
  expect(commits, "a target of another kind").toBe(mounted);

  act(() => usePreviewStore.setState({ target: own }));
  expect(commits, "its own kind still reaches it").toBeGreaterThan(mounted);
  const selected = commits;
  act(() => usePreviewStore.setState({ target: { ...own } }));
  expect(commits, "the same id again").toBe(selected);
  act(() => root.unmount());
  host.remove();
});
