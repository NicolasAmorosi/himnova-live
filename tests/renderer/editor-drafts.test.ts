/**
 * The editors' drafts (owner, 2026-11-23, DU-1), through the song editor, the one most typed in: its form reaches
 * main 600 ms after the last change while it is unsaved, and is dropped once saved; a launch with drafts left asks
 * «Recuperar / Descartar»; «Recuperar» hands the form back to the editor, «Descartar» deletes it. Main's half is
 * `tests/main/editor-drafts.test.ts`.
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseLyrics } from "@shared/song-text";
import type { EditorDraft } from "@shared/types/editor-draft";
import type { Song } from "@shared/types/song";

const h = vi.hoisted(() => ({
  calls: [] as { channel: string; req: unknown }[],
  drafts: [] as unknown[],
}));

vi.mock("@renderer/lib/actions/songs", async (original) => ({
  ...(await original<typeof import("@renderer/lib/actions/songs")>()),
  saveSong: (input: { title: string }) => Promise.resolve({ ...SONG, ...input, id: 1, updatedAt: 2 }),
}));
vi.mock("@renderer/components/shared/output-view", () => ({ OutputView: () => null }));
vi.mock("@renderer/components/shared/song-slide-grid", () => ({ SongSlideGrid: () => null }));
vi.mock("@renderer/lib/song-fit", async (original) => ({
  ...(await original<typeof import("@renderer/lib/song-fit")>()),
  useSettledSongFit: () => null,
}));

const { I18nProvider } = await import("@renderer/lib/i18n/i18n-provider");
const { SongEditorModal } = await import("@renderer/components/pages/songs/SongEditorModal");
const { EditorDraftsNotice, offerEditorDrafts, useEditorRecovery } = await import(
  "@renderer/components/shared/editor-screen"
);
const { useSongStore } = await import("@renderer/stores/song.store");
const { ModalBoundary } = await import("@renderer/components/shared/modal-boundary");

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
  h.calls = [];
  Element.prototype.scrollIntoView = () => undefined;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  (window as unknown as { worship: unknown }).worship = {
    invoke: (channel: string, req: unknown) => {
      h.calls.push({ channel, req });
      return Promise.resolve({ ok: true, data: channel === "editors:loadDrafts" ? h.drafts : null });
    },
    on: () => () => undefined,
  };
  useSongStore.setState({ songs: [SONG], themes: [] });
  useEditorRecovery.setState({ pending: [], asking: false, queue: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = (children: ReactNode) =>
  act(() => Promise.resolve(root.render(createElement(I18nProvider, { locale: "es", children }))));
const editor = (open: boolean) =>
  createElement(SongEditorModal, { onOpenChange: () => undefined, onSaved: () => undefined, open, songId: 1 });
const nameField = () => document.querySelector<HTMLInputElement>('input[aria-label="Título"]')!;
const byText = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text);
const draftWrites = () =>
  h.calls
    .filter((call) => call.channel === "editors:saveDraft")
    .map((call) => call.req as { editor: string; draft: EditorDraft | null });

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    Reflect.set(HTMLInputElement.prototype, "value", value, input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const songForm = (title: string, lyrics: string) => ({
  title,
  number: "",
  authors: "",
  copyright: "",
  ccliNumber: "",
  notes: "",
  lyrics,
  translation: "",
  order: null,
  themeId: null,
});
const recovered: EditorDraft = {
  v: 1,
  editor: "song",
  id: 1,
  name: "Uno recuperado",
  state: {
    currentId: 1,
    draft: songForm("Uno recuperado", "[Estrofa 1]\nOtra línea"),
    baseline: songForm("Uno", "[Estrofa 1]\nUna línea"),
  },
  updatedAt: 5,
};

test("the song being typed reaches main 600 ms after the last key, and is dropped once saved", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await render(editor(true));
  type(nameField(), "Uno A");
  act(() => void vi.advanceTimersByTime(599));
  expect(draftWrites(), "nothing before the pause").toEqual([]);
  act(() => void vi.advanceTimersByTime(1));
  // Fails without the draft: a crash now would lose what was typed.
  expect(draftWrites()).toHaveLength(1);
  expect(draftWrites()[0]).toMatchObject({ editor: "song", draft: { editor: "song", id: 1, name: "Uno A" } });
  expect((draftWrites()[0]!.draft!.state as { draft: { title: string } }).draft.title).toBe("Uno A");

  // Enter in the name saves (EditorScreen); the save answers at once here.
  act(() => void nameField().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await act(() => Promise.resolve());
  // Fails if a saved song keeps its draft: the next launch would offer what is already saved.
  expect(draftWrites().at(-1)).toEqual({ editor: "song", draft: null });
});

test("a launch with a draft left asks, naming it; «Recuperar» sends it to its editor", async () => {
  h.drafts = [recovered];
  await render(createElement(EditorDraftsNotice, { blocked: false }));
  await act(() => offerEditorDrafts());
  // Fails without the notice: the draft would sit on disk, never offered.
  expect(document.body.textContent).toContain("¿Recuperar lo que estabas editando?");
  expect(document.body.textContent).toContain("la canción «Uno recuperado»");
  await act(() => Promise.resolve(byText("button", "Recuperar")!.click()));
  expect(useEditorRecovery.getState().queue).toEqual([recovered]);
  expect(document.body.textContent).not.toContain("¿Recuperar lo que estabas editando?");
});

test("«Descartar» deletes every draft offered", async () => {
  useEditorRecovery.setState({ pending: [recovered, { ...recovered, editor: "plate", id: 4 }], asking: true });
  await render(createElement(EditorDraftsNotice, { blocked: false }));
  await act(() => Promise.resolve(byText("button", "Descartar")!.click()));
  expect(draftWrites()).toEqual([
    { editor: "song", draft: null },
    { editor: "plate", draft: null },
  ]);
  expect(useEditorRecovery.getState().pending).toEqual([]);
});

test("the editor opened by «Recuperar» has the form as it was left, and closing it hands over to the next", async () => {
  useEditorRecovery.setState({ queue: [recovered, { ...recovered, editor: "plate" }] });
  await render(editor(true));
  // Fails if the editor opens on the saved song instead of what was typed.
  expect(nameField().value).toBe("Uno recuperado");
  expect(document.body.textContent).toContain("Editado");
  await render(editor(false));
  expect(useEditorRecovery.getState().queue.map((draft) => draft.editor)).toEqual(["plate"]);
});

test("an editor that breaks on the form it took back lets it go: the next opening is the saved song", async () => {
  const broken: EditorDraft = { ...recovered, state: { currentId: 1, draft: null, baseline: null } };
  useEditorRecovery.setState({ queue: [broken, { ...recovered, editor: "plate" }] });
  const crashed = vi.fn();
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const guarded = (open: boolean) => createElement(ModalBoundary, { onCrash: crashed, open, children: editor(open) });
  try {
    await render(guarded(true));
    expect(crashed).toHaveBeenCalled();
    // Fails if the broken form stays first: every opening of the song editor this session would break on it again.
    expect(useEditorRecovery.getState().queue.map((draft) => draft.editor)).toEqual(["plate"]);
    await render(guarded(false));
    await render(guarded(true));
    expect(nameField().value).toBe("Uno");
  } finally {
    quiet.mockRestore();
  }
});

test("the notice waits behind the welcome and «Novedades»", async () => {
  useEditorRecovery.setState({ pending: [recovered], asking: true });
  await render(createElement(EditorDraftsNotice, { blocked: true }));
  expect(document.body.textContent).not.toContain("¿Recuperar lo que estabas editando?");
  await render(createElement(EditorDraftsNotice, { blocked: false }));
  expect(document.body.textContent).toContain("¿Recuperar lo que estabas editando?");
});
