/**
 * The editors' font list (`useLocalFonts`). It asked the system for every installed font each time another theme,
 * scene or plate was chosen (each choice mounts the field again), and until the answer came the stored family read as
 * «not installed» (2026-11-15 audit, U7). Asked once per session now, and a later mount starts with the answer.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { useLocalFonts, type LocalFonts } from "@renderer/lib/hooks/use-local-fonts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("the system's fonts are asked for once, and a later mount has them from its first render", async () => {
  const query = vi.fn(() =>
    Promise.resolve([
      { family: "Gentium", fullName: "Gentium", postscriptName: "Gentium", style: "Regular" },
      { family: "Arial", fullName: "Arial", postscriptName: "Arial", style: "Regular" },
    ]),
  );
  window.queryLocalFonts = query;
  const seen: LocalFonts["status"][] = [];
  function Probe() {
    seen.push(useLocalFonts(true).status);
    return null;
  }
  const mount = async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(Probe));
      await Promise.resolve();
    });
    act(() => root.unmount());
  };

  await mount();
  expect(seen).toEqual(["loading", "ready"]);
  seen.length = 0;
  await mount();
  expect(seen[0]).toBe("ready");
  expect(query).toHaveBeenCalledTimes(1);
});
