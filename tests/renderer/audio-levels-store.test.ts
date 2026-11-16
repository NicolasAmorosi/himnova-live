/**
 * The meters' levels (`audio-levels.store`), written up to 25 times a second. A level equal to the last one is no
 * change: with only LIVE sounding, PREVIEW's meter was woken and redrawn 25 times a second for the same silence
 * (2026-11-15 audit, R32).
 */
import { expect, test } from "vitest";
import { SILENT, useAudioLevelsStore } from "@renderer/stores/audio-levels.store";

test("a bus told the level it already has wakes nobody", () => {
  let woken = 0;
  const stop = useAudioLevelsStore.subscribe((state) => state.levels.preview, () => (woken += 1));
  const { setLevels } = useAudioLevelsStore.getState();
  setLevels("preview", [-Infinity, -Infinity]);
  setLevels("preview", SILENT);
  setLevels("live", [-12, -14]);
  expect(woken).toBe(0);
  setLevels("preview", [-20, -21]);
  setLevels("preview", [-20, -21]);
  expect(woken).toBe(1);
  setLevels("preview", SILENT);
  expect(woken).toBe(2);
  stop();
});
