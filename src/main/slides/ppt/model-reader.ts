import type { PptxDeck } from "../pptx/reader";
import type { AudioRef, PresentationMeta, SlideTiming } from "../pptx-metadata";
import { readPptModel, type PptResources } from "./reader";

/**
 * A legacy `.ppt`/`.pps` as a model deck — what `pptx-worker.ts` hands back
 * for a binary the picture-only reader refused. The timings, transitions,
 * titles, notes and sounds come from the same reading as the slides, numbered
 * like a `.pptx`'s: presentation order, hidden slides included. Sounds are
 * named by their part (`ppt/parts.ts`), read from the deck, never extracted
 * beforehand.
 */
export function readPptModelDeck(file: string, resources: PptResources): { deck: PptxDeck; meta: PresentationMeta } {
  const read = readPptModel(file, resources);
  const slides: SlideTiming[] = read.slides.map((s, i) => ({
    slideIndex: i + 1,
    partName: `slide${i + 1}`,
    autoAdvanceMs: s.autoAdvanceMs,
    advanceOnClick: s.advanceOnClick,
    transition: s.transition,
    hidden: s.hidden,
    title: s.title,
    notes: s.notes,
  }));
  const audio: AudioRef[] = read.slides.flatMap((s, i) =>
    s.sounds.flatMap((played) => {
      const sound = read.sounds.find((x) => x.id === played.id);
      return sound
        ? [{ partName: sound.part, startSlideIndex: i + 1, origin: played.origin, loop: played.loop, volume: null, slides: played.slides }]
        : [];
    }),
  );
  return {
    deck: read.deck,
    meta: {
      slideCount: slides.length,
      slideSizeEmu: { cx: read.deck.width, cy: read.deck.height },
      slides,
      audio,
      video: [],
      skippedVideoParts: [],
    },
  };
}
