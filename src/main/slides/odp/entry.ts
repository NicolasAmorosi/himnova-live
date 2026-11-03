import type { PptxDeck, PptxResources } from "../pptx/reader";
import type { PresentationMeta } from "../pptx-metadata";
import { readOdpMeta } from "./meta";
import { readOdpDeck } from "./reader";

/**
 * An OpenDocument presentation (`.odp`) read into the same `SlideModel` per
 * slide a `.pptx` is, plus its timings, transitions and sounds. Runs on the
 * reader's worker thread (`pptx-worker.ts`); a throw fails the deck as
 * unreadable. Timings that can't be read cost the timings, not the deck.
 */
export function readOdpModel(file: string, resources: PptxResources): { deck: PptxDeck; meta: PresentationMeta } {
  const deck = readOdpDeck(file, resources);
  let meta: PresentationMeta;
  try {
    meta = readOdpMeta(file);
  } catch {
    meta = { slideCount: deck.slides.length, slideSizeEmu: { cx: deck.width, cy: deck.height }, slides: [], audio: [], video: [], skippedVideoParts: [] };
  }
  return { deck, meta };
}
