/**
 * A song's moving background leaving the projector fades with the song (2026-11-15 audit, A13). `songVideo` exists
 * only while a song is the base, so the push to a verse or a picture dropped it in that same render: the outgoing song
 * layer turned black with the background's still and only then faded. The fade is only visible in `OutputView`'s
 * render, which is why this file mounts it.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { OutputView } from "@renderer/components/shared/output-view";
import { selectOutput, useProjectionStore } from "@renderer/stores/projection.store";
import { resolveSong } from "@renderer/stores/song.store";
import { songBackgroundUrl, songBackgroundVideo } from "@renderer/lib/song-output";
import { parseLyrics } from "@shared/song-text";
import { DEFAULT_SONG_THEME, type SongTheme } from "@shared/types/song";
import type { ProjectionOutput } from "@shared/types/projection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useProjectionStore.getState();
const store = () => useProjectionStore.getState();
const VIDEO_THEME: SongTheme = { ...DEFAULT_SONG_THEME, background: { kind: "video", assetId: 5, fit: "cover" } };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useProjectionStore.setState(initialState, true);
  store().setTransitionSettings("crossfade", 300);
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.load = () => undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (output: ProjectionOutput) => act(() => root.render(createElement(OutputView, { mode: "live", output })));
const sceneLayers = () =>
  Array.from(host.firstElementChild!.children).filter(
    (el) => el.tagName === "DIV" && el.classList.contains("inset-0") && !el.hasAttribute("data-song-video"),
  );

function goLiveSong(theme: SongTheme = VIDEO_THEME): void {
  const song = {
    id: 7,
    title: "x",
    number: null,
    authors: null,
    copyright: null,
    ccliNumber: null,
    notes: null,
    sections: parseLyrics("[Estrofa 1]\nuno\n\ndos", "es").sections,
    order: [],
    themeId: null,
    sourceFolder: null,
    file: null,
    updatedAt: 1,
  };
  store().beginScene();
  store().setBase({
    kind: "song",
    songId: 7,
    song: resolveSong(song, theme, null),
    slideIndex: 1,
    detour: null,
    lyricsHidden: false,
    enterSeq: 0,
    theme,
    sizeCqw: 4,
    backgroundVideo: songBackgroundVideo(theme, null),
    language: "both",
  });
  store().setOverlay("none");
}

test("a song's moving background stays under the outgoing song for the whole fade, and leaves with it", async () => {
  const poster = songBackgroundUrl(VIDEO_THEME)!;
  goLiveSong();
  render(selectOutput(store()));
  const video = host.querySelector("[data-song-video] video");
  expect(video).not.toBeNull();

  store().beginScene();
  store().setBase({ kind: "image", assetId: 1 });
  store().setOverlay("none");
  render(selectOutput(store()));

  expect(sceneLayers()).toHaveLength(2);
  // The same element, under the leaving song, which stays see-through instead of painting its still on black.
  expect(host.querySelector("[data-song-video] video")).toBe(video);
  const leaving = sceneLayers()[0]!;
  expect(leaving.querySelector(`img[src="${poster}"]`)).toBeNull();
  expect(leaving.className).not.toContain("bg-black");

  // The fade's end (jsdom runs no animation: the fallback timer ends it).
  await act(() => new Promise((resolve) => setTimeout(resolve, 1000)));
  expect(sceneLayers()).toHaveLength(1);
  expect(host.querySelector("[data-song-video]")).toBeNull();
});

test("a song without a moving background entering over one that had it paints its own, over the old one paused", () => {
  let paused = 0;
  HTMLMediaElement.prototype.pause = () => {
    paused += 1;
  };
  goLiveSong();
  render(selectOutput(store()));
  goLiveSong(DEFAULT_SONG_THEME);
  render(selectOutput(store()));

  expect(sceneLayers()).toHaveLength(2);
  expect(host.querySelector("[data-song-video] video")).not.toBeNull();
  // The leaving song stays see-through over its own background; the new one is opaque, its own background.
  expect(sceneLayers()[0]!.className).not.toContain("bg-black");
  expect(sceneLayers()[1]!.className).toContain("bg-black");
  expect(paused).toBeGreaterThan(0);
});
