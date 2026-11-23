/** The «close when the pointer goes down outside» rule `Menu`, `Select` and `ColorField` share. */
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { useCloseOnPointerOutside } from "@renderer/components/ui/floating-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Popup({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  useCloseOnPointerOutside(open, setOpen, triggerRef, popupRef);
  return createElement(
    "div",
    null,
    createElement("button", { ref: triggerRef, id: "trigger" }, createElement("span", { id: "label" }, "Open")),
    createElement("div", { ref: popupRef, id: "popup" }, createElement("button", { id: "option" }, "Option")),
    createElement("p", { id: "outside" }, "Elsewhere"),
  );
}

function mount(open: boolean) {
  const setOpen = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Popup, { open, setOpen })));
  const press = (id: string) => document.getElementById(id)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { press, setOpen, unmount };
}

test("a press outside the trigger and the popup closes it", () => {
  const { press, setOpen, unmount } = mount(true);
  press("outside");
  expect(setOpen).toHaveBeenCalledExactlyOnceWith(false);
  unmount();
});

test("a press on the trigger, on something inside it or inside the popup leaves it open", () => {
  const { press, setOpen, unmount } = mount(true);
  for (const id of ["trigger", "label", "popup", "option"]) press(id);
  expect(setOpen).not.toHaveBeenCalled();
  unmount();
});

test("closed, or once gone, it listens to nothing", () => {
  const closed = mount(false);
  closed.press("outside");
  expect(closed.setOpen).not.toHaveBeenCalled();
  closed.unmount();
  const gone = mount(true);
  gone.unmount();
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(gone.setOpen).not.toHaveBeenCalled();
});
