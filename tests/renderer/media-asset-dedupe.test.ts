/**
 * A schedule row reads its asset through three `useMediaAsset` consumers (label, icon and badge, thumbnail): each
 * one fired its own `library:get` at startup and again on every `library-changed` (2026-11-15 audit, R29). Consumers
 * of one id share one request now, which must not outlive a change to the library nor keep a failure for good.
 */
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { forgetAllMediaAssets, forgetMediaAsset, useMediaAsset } from "@renderer/lib/hooks/use-media-asset";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { resolve: (name: string) => void; reject: (error: Error) => void };
let answers: Answer[] = [];
let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  answers = [];
  invoke = vi.fn(
    (_channel: string, req: { id: number }) =>
      new Promise((resolve, reject) =>
        answers.push({
          resolve: (name) => resolve({ ok: true, data: { id: req.id, name } }),
          reject,
        }),
      ),
  );
  (window as unknown as { worship: unknown }).worship = { invoke, on: () => () => {} };
});

let unmount = (): void => {};
afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

/** `count` consumers of one id, as a schedule row mounts them; returns what each one shows. */
function mount(id: number, count: number): () => (string | null)[] {
  const shown: (string | null)[] = new Array<string | null>(count).fill(null);
  function Consumer({ index }: { index: number }) {
    shown[index] = useMediaAsset(id)?.name ?? null;
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(
        Fragment,
        null,
        Array.from({ length: count }, (_, index) => createElement(Consumer, { index, key: index })),
      ),
    ),
  );
  unmount = () => act(() => root.unmount());
  return () => shown;
}

const libraryGets = (): number => invoke.mock.calls.filter(([channel]) => channel === "library:get").length;

test("the three consumers of a schedule row share one request", async () => {
  const shown = mount(101, 3);
  expect(libraryGets()).toBe(1);
  await act(() => Promise.resolve(answers[0]!.resolve("Himno.mp4")));
  expect(shown()).toEqual(["Himno.mp4", "Himno.mp4", "Himno.mp4"]);
});

test("a change to the library asks again, once, and an answer from before it never lands", async () => {
  const shown = mount(102, 3);
  expect(libraryGets()).toBe(1);
  act(() => forgetAllMediaAssets());
  expect(libraryGets(), "the request in flight is not joined after the change").toBe(2);
  await act(() => Promise.resolve(answers[1]!.resolve("nuevo.mp4")));
  await act(() => Promise.resolve(answers[0]!.resolve("viejo.mp4")));
  expect(shown()).toEqual(["nuevo.mp4", "nuevo.mp4", "nuevo.mp4"]);
});

test("an older answer landing first is replaced by the one asked after the change", async () => {
  const shown = mount(103, 2);
  act(() => forgetAllMediaAssets());
  await act(() => Promise.resolve(answers[0]!.resolve("viejo.mp4")));
  expect(shown(), "the stale answer is not cached").toEqual([null, null]);
  await act(() => Promise.resolve(answers[1]!.resolve("nuevo.mp4")));
  expect(shown()).toEqual(["nuevo.mp4", "nuevo.mp4"]);
});

test("a failed request is not kept: forgetting the id asks again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const shown = mount(104, 3);
  await act(() => Promise.resolve(answers[0]!.reject(new Error("boom"))));
  expect(shown()).toEqual([null, null, null]);
  expect(libraryGets()).toBe(1);
  act(() => forgetMediaAsset(104));
  expect(libraryGets()).toBe(2);
  await act(() => Promise.resolve(answers[1]!.resolve("Himno.mp4")));
  expect(shown()).toEqual(["Himno.mp4", "Himno.mp4", "Himno.mp4"]);
});
