/**
 * The style editors' media library (`useEditorLibrary`): scenes, plates, the verse's look and song themes each had
 * their own copy of the listing and of «Add…», and song themes listed both libraries again after every save, because
 * the listing shared an effect with the themes (2026-11-15 audit, X14). Listed on open, and only on open.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { I18nProvider } from "@renderer/lib/i18n/i18n-provider";
import { useEditorLibrary, type EditorLibrary } from "@renderer/lib/hooks/use-editor-library";
import type { MediaAsset } from "@shared/types/media";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const asset = (id: number) => ({ id, name: `image ${id}` }) as MediaAsset;

let library: MediaAsset[] = [];
let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  library = [asset(1)];
  const answer = (channel: string, req: { paths?: string[] }): unknown => {
    if (channel === "library:list") return library;
    if (channel === "files:pick") return ["/pictures/new.png"];
    if (channel === "library:add") {
      const added = (req.paths ?? []).map((_, i) => asset(library.length + i + 1));
      library = [...library, ...added];
      return added;
    }
    throw new Error(`unexpected ${channel}`);
  };
  invoke = vi.fn((channel: string, req: { paths?: string[] }) => Promise.resolve({ ok: true, data: answer(channel, req) }));
  (window as unknown as { worship: unknown }).worship = { invoke, on: () => () => {} };
});

let unmount = (): void => {};
afterEach(() => unmount());

const lists = () => invoke.mock.calls.filter(([channel]) => channel === "library:list").length;

/** An editor holding the library; `saves` stands for the editor re-rendering with new rows (a saved theme). */
function mount(): { render: (open: boolean, saves: number) => Promise<void>; library: () => EditorLibrary } {
  let current: EditorLibrary | null = null;
  function Editor({ open }: { open: boolean; saves: number }) {
    current = useEditorLibrary(open, "image", "test");
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  unmount = () => act(() => root.unmount());
  return {
    render: async (open, saves) => {
      // Async, so the listing's answer lands inside it.
      await act(async () => {
        root.render(createElement(I18nProvider, { locale: "es", children: createElement(Editor, { open, saves }) }));
        await Promise.resolve();
      });
    },
    library: () => current!,
  };
}

test("the library is listed once per opening, not again when the editor re-renders after a save", async () => {
  const editor = mount();
  await editor.render(false, 0);
  expect(lists()).toBe(0);
  await editor.render(true, 0);
  expect(lists()).toBe(1);
  expect(editor.library().assets.map((a) => a.id)).toEqual([1]);
  await editor.render(true, 1);
  await editor.render(true, 2);
  expect(lists()).toBe(1);
  await editor.render(false, 2);
  await editor.render(true, 2);
  expect(lists()).toBe(2);
});

test("«Add…» imports the picked files, lists the library again and hands back the first one added", async () => {
  const editor = mount();
  await editor.render(true, 0);
  let first: MediaAsset | null = null;
  await act(async () => {
    first = await editor.library().add();
  });
  expect(first).toMatchObject({ id: 2 });
  expect(editor.library().assets.map((a) => a.id)).toEqual([1, 2]);
  expect(editor.library().adding).toBe(false);
});
