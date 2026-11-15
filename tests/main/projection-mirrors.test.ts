/**
 * The projector's mirrors (`services/projection-state.ts`): the NDI output and the stage screen while it plays
 * videos. A video taken live waits for the ones the room watches to draw it, never for the stage (2026-11-14 review),
 * and a mirror added again does not pile up `closed` listeners.
 */
import { expect, test, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { projectionState } from "../../src/main/services/projection-state";

function fakeWindow(id: number) {
  const once = vi.fn();
  return { win: { isDestroyed: () => false, once, webContents: { id } } as unknown as BrowserWindow, once };
}

test("the stage is a mirror the start of a video never waits for; the NDI output and the projector are", () => {
  const projector = fakeWindow(1);
  const ndi = fakeWindow(2);
  const stage = fakeWindow(3);
  projectionState.setWindow(projector.win);
  projectionState.addMirror(ndi.win);
  projectionState.addMirror(stage.win, false);
  expect(projectionState.getMirrors()).toEqual([ndi.win, stage.win]);
  expect(projectionState.getWatched()).toEqual([projector.win, ndi.win]);

  // Its videos turned off and on, five times: still one mirror, one `closed` listener.
  for (let i = 0; i < 5; i += 1) {
    projectionState.removeMirror(stage.win);
    projectionState.addMirror(stage.win, false);
  }
  expect(projectionState.getMirrors()).toEqual([ndi.win, stage.win]);
  expect(stage.once).toHaveBeenCalledTimes(1);
  expect(projectionState.getWatched()).toEqual([projector.win, ndi.win]);

  projectionState.removeMirror(ndi.win);
  projectionState.removeMirror(stage.win);
  projectionState.setWindow(null);
});
