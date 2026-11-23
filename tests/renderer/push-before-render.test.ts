/**
 * What goes to the projector, picture and sound, leaves before the control window draws again: with the Songs tab
 * open, a song's GO LIVE drew 1500 rows before `projection:show`, and a deck's music waited for that too (2026-11-22
 * audit, RR-01). Mounted the way `main.tsx` and `App` do it, with React's own scheduling (no `act`, which would flush
 * the render itself): the pushes are queued first, the components subscribe, and the effects start in `App`'s effect.
 */
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { queueProjectionPushesFirst, startProjectionEffects } from "@renderer/effects/projection-sync";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { useAudioStore } from "@renderer/stores/audio.store";

let log: string[] = [];
let recording = false;
(window as unknown as { worship: unknown }).worship = {
  invoke: (channel: string) => {
    if (recording && channel.startsWith("projection:")) log.push(channel);
    return Promise.resolve({ ok: true, data: null });
  },
  on: () => () => {},
};

/** The Songs tab's list: every row reads what is live, as `songs-browser.tsx` does. */
function SongList() {
  const output = useProjectionStore(selectOutputMemo);
  const tracks = useAudioStore((state) => state.tracks);
  if (recording) log.push("render");
  return createElement(
    "ul",
    null,
    Array.from({ length: 1500 }, (_, i) => createElement("li", { key: i }, `${i} ${output.kind} ${tracks.length}`)),
  );
}

function App() {
  useEffect(() => startProjectionEffects(), []);
  return createElement(SongList);
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const root = createRoot(document.createElement("div"));

beforeAll(async () => {
  queueProjectionPushesFirst();
  root.render(createElement(App));
  await settle();
});
afterAll(() => root.unmount());
beforeEach(() => {
  log = [];
  recording = false;
});

let n = 0;
const deckWithMusic = () => {
  n += 1;
  const projection = useProjectionStore.getState();
  projection.beginScene();
  projection.setBase({ kind: "image", assetId: n, url: `worship://asset/${n}` } as never);
  projection.setOverlay("none");
  useAudioStore.getState().setDeckTrack({
    url: `worship://asset/m${n}`, epoch: n, paused: false, startAtSeconds: 0, label: "", volume: 1, loop: false,
  });
};

test("a key's GO LIVE of a deck with music: picture, then sound, then the control window's render", async () => {
  // A key on `window`, as `useGlobalShortcuts` listens, and an `await` before the change, as `goLive` has.
  window.addEventListener("keydown", () => {
    void Promise.resolve().then(() => {
      recording = true;
      deckWithMusic();
    });
  }, { once: true });
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await settle();
  // Fails without the fix: "render" comes first, and the sound after it even with the picture queued first.
  expect(log.slice(0, 3)).toEqual(["projection:show", "projection:setAudioTracks", "render"]);
  // One of each for the whole batch: the overlay and the deck's track changed in it too.
  expect(log.filter((entry) => entry === "projection:show")).toHaveLength(1);
  expect(log.filter((entry) => entry === "projection:setAudioTracks")).toHaveLength(1);
});

test("a batch that changes the sound first still sends it first", async () => {
  recording = true;
  useAudioStore.getState().setDeckTrack(null);
  useProjectionStore.getState().beginScene();
  useProjectionStore.getState().setBase(null);
  await settle();
  expect(log.slice(0, 3)).toEqual(["projection:setAudioTracks", "projection:show", "render"]);
});
