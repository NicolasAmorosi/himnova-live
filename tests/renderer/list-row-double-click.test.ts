/**
 * A double click on a control inside a list row is that control's, never the row's: starring and unstarring a saved
 * program quickly opened it and replaced the order of service on screen (2026-11-15 audit, U1). The real
 * `ProgramRow`, mounted.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { I18nProvider } from "@renderer/lib/i18n/i18n-provider";
import { ProgramRow } from "@renderer/components/pages/programs/program-row";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("a double click on a saved program's star toggles it twice and does not open the program", () => {
  const onOpen = vi.fn();
  const onToggleFavorite = vi.fn();
  const host = document.createElement("ul");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(I18nProvider, {
        locale: "es",
        children: createElement(ProgramRow, {
          draggable: true,
          dragOver: false,
          dragging: false,
          isCurrent: false,
          onDragStart: () => undefined,
          onOpen,
          onSelect: () => undefined,
          onToggleFavorite,
          program: { id: 7, name: "Culto", favorite: false } as never,
          ref: null,
          selected: false,
        }),
      }),
    ),
  );
  const star = host.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
  act(() => {
    star.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    star.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    star.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
  });
  expect(onToggleFavorite).toHaveBeenCalledTimes(2);
  expect(onOpen).not.toHaveBeenCalled();

  // The row's own double click still opens it.
  act(() => {
    host.querySelector("li")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
  });
  expect(onOpen).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
  host.remove();
});
