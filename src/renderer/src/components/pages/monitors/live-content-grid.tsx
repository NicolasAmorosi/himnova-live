import { useT } from "@renderer/lib/i18n/i18n-provider";
import {
  DECK_GRID_COLUMNS,
  SLIDE_GRID_GAP_PX,
  SlideGrid,
  ThumbTile,
  VERSE_TILE_MIN_WIDTH_PX,
  VirtualGrid,
  thumbTileHeight,
} from "@renderer/components/ui";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { gotoSlide } from "@renderer/lib/actions/playback";
import { projectVerse } from "@renderer/lib/actions/bible";
import { ModelSlide } from "@renderer/components/shared/slide-view/ModelSlide";
import { DamagedSlideMark } from "@renderer/components/shared/damaged-slide";

/**
 * Below the LIVE monitor: whatever the projector is actually showing, as the
 * same kind of grid the centre column uses for the preview — a deck's slides,
 * or a passage's verses. Clicking a tile jumps the projector there directly;
 * there is no second stage here, this content is already live.
 */
export function LiveContentGrid() {
  const t = useT();
  const base = useProjectionStore((s) => s.base);
  const liveDeck = useProjectionStore((s) => s.liveDeck);
  const verses = useBibleStore((s) => s.verses);
  const currentVerseIndex = useBibleStore((s) => s.currentVerseIndex);

  if (base?.kind === "deck" && liveDeck) {
    const liveSlideIndex = base.slideIndex;
    return (
      <VirtualGrid
        aria-label={t("deck.title")}
        columns={DECK_GRID_COLUMNS}
        gap={SLIDE_GRID_GAP_PX}
        itemHeight={(columnWidth) => thumbTileHeight(columnWidth, { label: false })}
        itemKey={(slide) => slide.index}
        items={liveDeck.slides}
        renderItem={(slide, _index, { tabIndex }) => (
          <ThumbTile
            index={slide.index}
            live={liveSlideIndex === slide.index}
            onClick={() => gotoSlide(slide.index)}
            selected={liveSlideIndex === slide.index}
            media={slide.modelUrl ? <ModelSlide url={slide.modelUrl} /> : undefined}
            overlay={<DamagedSlideMark url={slide.modelUrl} />}
            src={slide.modelUrl ? null : slide.thumbUrl}
            tabIndex={tabIndex}
            title={t("deck.slideAlt", { index: slide.index })}
          />
        )}
        // This grid IS the live monitor's second half: it follows the
        // projector, auto-advance included, or it stops being a monitor.
        // `slideIndex` is 1-based; the grid works in array positions.
        scrollToIndex={liveSlideIndex - 1}
      />
    );
  }

  // Only when the live verse actually belongs to the chapter loaded in the
  // Bible browser (see playback.ts) do we have a passage to walk — otherwise
  // it's a single scheduled reference, same as the centre column's fallback.
  if (base?.kind === "bible" && currentVerseIndex !== null && verses.length > 0) {
    const liveVerseIndex = currentVerseIndex;
    return (
      <VirtualGrid
        aria-label={t("bible.title")}
        gap={SLIDE_GRID_GAP_PX}
        itemHeight={(columnWidth) => thumbTileHeight(columnWidth, { label: false })}
        itemKey={(verse) => verse.id}
        items={verses}
        minItemWidth={VERSE_TILE_MIN_WIDTH_PX}
        renderItem={(verse, index, { tabIndex }) => (
          <ThumbTile
            index={verse.verse}
            live={liveVerseIndex === index}
            onClick={() => projectVerse(index)}
            selected={liveVerseIndex === index}
            tabIndex={tabIndex}
            text={verse.text}
          />
        )}
        scrollToIndex={liveVerseIndex}
      />
    );
  }

  if (base?.kind === "bible") {
    return (
      <SlideGrid>
        <ThumbTile label={base.reference} selected text={base.text} />
      </SlideGrid>
    );
  }

  // A video/image/text base, a sounding audio track, or genuinely nothing
  // live — this grid has nothing to add in any of those cases, so it stays
  // empty rather than showing a redundant placeholder.
  return null;
}
