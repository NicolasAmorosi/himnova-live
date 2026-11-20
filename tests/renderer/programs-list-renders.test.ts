/**
 * The saved programs' rows lived in the screen's own state: every key typed into the notes, and every `dragover` the
 * floating clone followed (~20 a second), re-rendered all of them, and the clone the whole screen (2026-11-15 audit,
 * R30). The rows are counted through `ProgramRow` and the screen through `EditorScreen`, on the real screen.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProgramSummary } from "@shared/types/program";

const rows = vi.hoisted(() => ({ count: 0, screen: 0 }));
vi.mock("@renderer/components/pages/programs/program-row", async (original) => {
  const real = await original<typeof import("@renderer/components/pages/programs/program-row")>();
  return {
    ProgramRow: (props: Parameters<typeof real.ProgramRow>[0]) => {
      rows.count += 1;
      return real.ProgramRow(props);
    },
  };
});

vi.mock("@renderer/components/shared/editor-screen", async (original) => {
  const real = await original<typeof import("@renderer/components/shared/editor-screen")>();
  return {
    ...real,
    EditorScreen: (props: Parameters<typeof real.EditorScreen>[0]) => {
      rows.screen += 1;
      return real.EditorScreen(props);
    },
  };
});

const { I18nProvider } = await import("@renderer/lib/i18n/i18n-provider");
const { ProgramsModal } = await import("@renderer/components/pages/programs/ProgramsModal");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const program = (id: number, name: string): ProgramSummary => ({
  id,
  name,
  notes: null,
  favorite: false,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: null,
  sortOrder: id,
  itemCount: 0,
});
const PROGRAMS = [program(1, "Mañana"), program(2, "Tarde"), program(3, "Noche")];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  rows.count = 0;
  rows.screen = 0;
  Element.prototype.scrollIntoView = () => undefined;
  (window as unknown as { worship: unknown }).worship = {
    invoke: (channel: string, req: { id?: number } | null) =>
      Promise.resolve({
        ok: true,
        data: channel === "programs:list" ? PROGRAMS : channel === "programs:peek" ? { id: req?.id, items: [] } : null,
      }),
    on: () => () => undefined,
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** A DOM event with the fields React and the screen read off a drag. */
function drag(type: string, clientY: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = {
    effectAllowed: "",
    types: [],
    getData: () => "",
    setData: () => undefined,
    setDragImage: () => undefined,
  };
  return Object.assign(event, { clientY, dataTransfer });
}

test("typing into the notes and dragging a row draw no row again", async () => {
  await act(() =>
    Promise.resolve(
      root.render(
        createElement(I18nProvider, {
          locale: "es",
          children: createElement(ProgramsModal, { onOpenChange: () => undefined, open: true }),
        }),
      ),
    ),
  );
  const notes = document.querySelector("textarea");
  expect(notes, "a program is chosen").not.toBeNull();
  const drawn = rows.count;
  expect(drawn).toBeGreaterThan(0);

  // Through the prototype's setter, as a key does: React ignores a value written on the element itself.
  for (const text of ["P", "Pr", "Pre"]) {
    act(() => {
      Reflect.set(HTMLTextAreaElement.prototype, "value", text, notes);
      notes!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  expect(notes!.value).toBe("Pre");
  expect(rows.count, "keys typed into the notes").toBe(drawn);

  const row = document.querySelector("li[data-id='2']")!;
  act(() => void row.dispatchEvent(drag("dragstart", 0)));
  const dragging = rows.count;
  const screen = rows.screen;
  expect(dragging, "the dragged row fades").toBeGreaterThan(drawn);
  for (const y of [10, 20, 30]) act(() => void window.dispatchEvent(drag("dragover", y)));
  const clone = document.body.querySelector<HTMLElement>(":scope > .fixed.pointer-events-none");
  expect(clone?.style.top, "the clone follows the cursor").toBe("30px");
  expect(rows.count, "the cursor moving").toBe(dragging);
  expect(rows.screen, "the cursor moving, the screen").toBe(screen);

  act(() => void window.dispatchEvent(drag("dragend", 30)));
  expect(document.body.querySelector(":scope > .fixed.pointer-events-none")).toBeNull();
});
