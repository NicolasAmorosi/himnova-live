/**
 * A floating menu follows its trigger through every scroll that moves it (`useFollowTrigger`). It also took the
 * scrolls of its own list as such: `Select`, `Menu` and `ColorField` placed (and re-rendered) themselves on every
 * scroll of their options, 20 commits for 20 scrolls of 300 options (2026-11-15 audit, R31).
 */
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { useFollowTrigger } from "@renderer/components/ui/floating-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("only a scroll that moves the trigger places the menu again", () => {
  globalThis.IntersectionObserver = class {
    observe(): void {}
    disconnect(): void {}
  } as unknown as typeof IntersectionObserver;
  const place = vi.fn();
  function Probe() {
    const triggerRef = useRef<HTMLButtonElement>(null);
    useFollowTrigger(true, triggerRef, place, () => undefined);
    return createElement(
      "div",
      { id: "panel" },
      createElement("button", { ref: triggerRef }, "open"),
      createElement("ul", { id: "options" }, createElement("li", null, "one")),
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Probe)));
  place.mockClear();

  host.querySelector("#options")!.dispatchEvent(new Event("scroll"));
  expect(place).not.toHaveBeenCalled();
  host.querySelector("#panel")!.dispatchEvent(new Event("scroll"));
  expect(place).toHaveBeenCalledTimes(1);
  document.dispatchEvent(new Event("scroll"));
  expect(place).toHaveBeenCalledTimes(2);

  act(() => root.unmount());
  host.remove();
});
