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
 * would redraw the whole column.
 *
 * ponytail: nothing feeds it yet (the meters stay silent); the media engine's `level` events and the projector's
 * analysers write here once they exist.
 */
export const useAudioLevelsStore = create<AudioLevelsState>()(
  subscribeWithSelector((set) => ({
    levels: { live: SILENT, preview: SILENT },
    setLevels: (bus, level) => set((state) => ({ levels: { ...state.levels, [bus]: level } })),
  })),
);
