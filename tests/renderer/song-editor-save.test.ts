/**
 * A song save that answers late (a file write on a share or a pen drive, `renameWithRetry`). The editor kept working
 * meanwhile, and the answer replaced what it held: keys typed during the round trip were lost with no «Editado» (QA
 * 2026-11-06 §7.6), and a duplicate shown before the answer got the original's id (late review, 2026-11-22).
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseLyrics } from "@shared/song-text";
import type { Song } from "@shared/types/song";

const h = vi.hoisted(() => ({ saves: [] as { input: { id?: number; title: string }; resolve: (song: Song) => void }[] }));

vi.mock("@renderer/lib/actions/songs", async (original) => ({
  ...(await original<typeof import("@renderer/lib/actions/songs")>()),
  saveSong: (input: { id?: number; title: string }) => new Promise<Song>((resolve) => h.saves.push({ input, resolve })),
  duplicateSong: (_id: number, title: string) => Promise.resolve({ ...SONG, id: 2, title }),
}));
// The projector's drawing and the slide grid are not what this is about.
vi.mock("@renderer/components/shared/output-view", () => ({ OutputView: () => null }));
vi.mock("@renderer/components/shared/song-slide-grid", () => ({ SongSlideGrid: () => null }));
vi.mock("@renderer/lib/song-fit", async (original) => ({
  ...(await original<typeof import("@renderer/lib/song-fit")>()),
  useSettledSongFit: () => null,
}));

const { I18nProvider } = await import("@renderer/lib/i18n/i18n-provider");
const { SongEditorModal } = await import("@renderer/components/pages/songs/SongEditorModal");
const { useSongStore } = await import("@renderer/stores/song.store");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SONG: Song = {
  id: 1,
  title: "Uno",
  number: null,
  authors: null,
  copyright: null,
  ccliNumber: null,
  notes: null,
  sections: parseLyrics("[Estrofa 1]\nUna línea", "es").sections,
  order: [],
  themeId: null,
  sourceFolder: null,
  file: null,
  updatedAt: 1,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.saves = [];
  Element.prototype.scrollIntoView = () => undefined;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // The «⋯» menu's popover.
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  (window as unknown as { worship: unknown }).worship = {
    invoke: () => Promise.resolve({ ok: true, data: null }),
    on: () => () => undefined,
  };
  useSongStore.setState({ songs: [SONG], themes: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function openEditor(onOpenChange: (open: boolean) => void = () => undefined): Promise<HTMLInputElement> {
  await act(() =>
    Promise.resolve(
      root.render(
        createElement(I18nProvider, {
          locale: "es",
          children: createElement(SongEditorModal, { onOpenChange, onSaved: () => undefined, open: true, songId: 1 }),
        }),
      ),
    ),
  );
  const name = nameField("Uno");
  expect(name, "the song's name in the bar").toBeDefined();
  return name!;
}

const nameField = (value: string) => [...document.querySelectorAll("input")].find((input) => input.value === value);
const byText = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text);

/** Through the prototype's setter, as a key does: React ignores a value written on the element itself. */
function type(input: HTMLInputElement, value: string): void {
  act(() => {
    Reflect.set(HTMLInputElement.prototype, "value", value, input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Enter in the name saves (EditorScreen). */
function pressEnter(input: HTMLInputElement): void {
  act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}

const answer = (index: number, song: Song) => act(() => Promise.resolve(h.saves[index]!.resolve(song)));

test("a key typed while the song saves is still there after the save answers, and still unsaved", async () => {
  const name = await openEditor();
  type(name, "Uno A");
  pressEnter(name);
  expect(h.saves).toHaveLength(1);
  type(name, "Uno AB");
  await answer(0, { ...SONG, title: "Uno A", updatedAt: 2 });
  expect(name.value).toBe("Uno AB");
  expect(document.body.textContent).toContain("Editado");
});

test("a duplicate shown before a slow save answers stays the copy: the next save goes to it, not to the original", async () => {
  const name = await openEditor();
  type(name, "Uno editado");
  pressEnter(name);
  // «⋯» ▸ Duplicar, then «Descartar cambios» in the leave dialog: the draft is still dirty against the old baseline.
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Más acciones"]')!.click());
  act(() => byText('[role="menuitem"]', "Duplicar")!.click());
  const discard = byText("button", "Descartar cambios");
  expect(discard, "the leave dialog").toBeDefined();
  await act(() => Promise.resolve(discard!.click()));
  expect(nameField("Uno (copia)"), "the editor is on the copy").toBeDefined();

  await answer(0, { ...SONG, title: "Uno editado", updatedAt: 2 });
  const copy = nameField("Uno (copia)");
  expect(copy, "still the copy").toBeDefined();
  type(copy!, "Uno (copia) x");
  pressEnter(copy!);
  expect(h.saves[1]?.input).toMatchObject({ id: 2, title: "Uno (copia) x" });
});

test("«Guardar y salir» while a save is in flight does not close over keys typed after it", async () => {
  const closed: boolean[] = [];
  const name = await openEditor((open) => void closed.push(open));
  type(name, "Uno A");
  pressEnter(name);
  type(name, "Uno AB");
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Cerrar"]')!.click());
  const saveAndLeave = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Guardar y/.test(b.textContent ?? ""));
  expect(saveAndLeave, "the leave dialog").toBeDefined();
  await act(() => Promise.resolve(saveAndLeave!.click()));
  await answer(0, { ...SONG, title: "Uno A", updatedAt: 2 });
  // Either still open with «Uno AB» to save, or closed only after saving it.
  expect(closed.includes(false) && !h.saves.some((save) => save.input.title === "Uno AB")).toBe(false);
});

test("«Descartar» while a save is in flight takes what was saved, not the text from before it", async () => {
  const name = await openEditor();
  type(name, "Uno A");
  pressEnter(name);
  // The header's discard puts the draft from before the save back on screen.
  act(() => byText("button", "Descartar")!.click());
  expect(name.value).toBe("Uno");
  await answer(0, { ...SONG, title: "Uno A", updatedAt: 2 });
  expect(name.value).toBe("Uno A");
  expect(document.body.textContent).not.toContain("Editado");
});
