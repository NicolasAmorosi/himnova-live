/**
 * The app's one tooltip (2026-11-15 audit, X16). The in-flow bubble it replaced lived in the DOM while hidden (a
 * screen reader read it, it counted for scroll, a panel clipped it), and neither bubble described its control nor
 * closed with Esc: the shortcuts Enter, B and L were only in the bubble. Esc must close the bubble and leave the
 * modal under it open (2026-11-15 audit, U2 and U3: an Esc meant for a popup closed the whole editor).
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { Modal } from "@renderer/components/shared/modal/Modal";
import { Tooltip } from "@renderer/components/ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HINT = "Send the preview live (Enter)";

function mount(onOpenChange: (open: boolean) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(Modal, {
        open: true,
        onOpenChange,
        size: "sm",
        children: createElement(Tooltip, {
          content: HINT,
          children: createElement("button", { type: "button" }, "GO LIVE"),
        }),
      }),
    ),
  );
  const button = document.querySelector<HTMLButtonElement>("button:not([aria-hidden])")!;
  return {
    button,
    bubble: () => document.querySelector('[role="tooltip"]'),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

// Cancelable, as a real key is: `preventDefault` is what tells the modal the key was used.
const escape = () =>
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

test("the hint describes its control, and no bubble is in the document until it opens", () => {
  const { bubble, button, unmount } = mount(() => undefined);
  const description = document.getElementById(button.getAttribute("aria-describedby") ?? "");
  expect(description?.textContent).toBe(HINT);
  expect(description?.hidden).toBe(true);
  expect(bubble()).toBeNull();
  unmount();
});

test("one Esc closes the bubble and the modal under it, as it closed the modal before", () => {
  const onOpenChange = vi.fn();
  const { bubble, button, unmount } = mount(onOpenChange);
  act(() => {
    button.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  });
  expect(bubble()?.textContent).toBe(HINT);

  act(() => {
    escape();
  });
  expect(bubble()).toBeNull();
  expect(onOpenChange).toHaveBeenCalledWith(false);
  unmount();
});
