/**
 * An inspector's sections remember how the operator left them folded. They were remembered under the translated
 * names of the inspector and the section: changing the language lost every one and left the old keys behind
 * (2026-11-15 audit, U11). Each has a stable id now.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { Inspector, InspectorSection } from "@renderer/components/ui/inspector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => localStorage.clear());

function mount(label: string, title: string): { details: HTMLDetailsElement; unmount: () => void } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(Inspector, {
        id: "themes",
        label,
        children: createElement(InspectorSection, { id: "background", title, children: "knobs" }),
      }),
    ),
  );
  return {
    details: host.querySelector("details")!,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("a section folded in one language is still folded in another", () => {
  const spanish = mount("Temas de canciones", "Fondo");
  expect(spanish.details.open).toBe(true);
  act(() => {
    spanish.details.open = false;
    spanish.details.dispatchEvent(new Event("toggle"));
  });
  spanish.unmount();

  const english = mount("Song themes", "Background");
  expect(english.details.open).toBe(false);
  english.unmount();
  expect(Object.keys(localStorage)).toEqual(["inspector.open:themes:background"]);
});
