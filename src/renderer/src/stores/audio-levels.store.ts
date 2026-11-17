import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { AudioBus } from "@shared/types/audio";

/** Left and right, in dBFS (sample peak); `-Infinity` is silence. */
export type StereoLevel = readonly [number, number];

export const SILENT: StereoLevel = [-Infinity, -Infinity];

type AudioLevelsState = {
  levels: Record<AudioBus, StereoLevel>;
  setLevels: (bus: AudioBus, level: StereoLevel) => void;
};

/**
 * What each bus sounds at right now, for the meters of the audio strips (`AudioStrip`). Written up to ~25 times a
 * second while something sounds, so a strip reads it with `subscribe`, never as React state: a re-render per level
 * would redraw the whole column. Fed by `effects/audio-levels.ts`.
 */
export const useAudioLevelsStore = create<AudioLevelsState>()(
  subscribeWithSelector((set) => ({
    levels: { live: SILENT, preview: SILENT },
    // The level it already has is no change: PREVIEW's meter was woken and redrawn 25 times a second for the same
    // silence while only LIVE sounded (2026-11-15 audit, R32).
    setLevels: (bus, level) =>
      set((state) => {
        const now = state.levels[bus];
        return now[0] === level[0] && now[1] === level[1] ? state : { levels: { ...state.levels, [bus]: level } };
      }),
  })),
);
