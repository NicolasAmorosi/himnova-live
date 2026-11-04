import { useT } from "@renderer/lib/i18n/i18n-provider";
import {
  Badge,
  EmptyState,
  MediaPanel,
  SLIDE_GRID_GAP_PX,
  SlideGrid,
  ThumbTile,
  VERSE_TILE_MIN_WIDTH_PX,
  VirtualGrid,
  thumbTileHeight,
} from "@renderer/components/ui";
import { MediaTrackRow } from "@renderer/components/shared/media-track-row";
import { UtilityTrackRow } from "@renderer/components/shared/utility-track-row";
import { PlateTrackRow } from "@renderer/components/shared/plate-track-row";
import { PanelBody, PanelHeader } from "@renderer/components/shared/panel";
import { PreviewMissingState } from "@renderer/components/shared/preview-missing-state";
import { DamagedSlideBadge } from "@renderer/components/shared/damaged-slide";
import { useDeckStore } from "@renderer/stores/deck.store";
import { PreviewMonitor } from "@renderer/components/pages/monitors/preview-monitor";
import { useBibleStore } from "@renderer/stores/bible.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { usePreviewContent } from "@renderer/lib/hooks/use-preview";
import { clearPreview, previewVerse, setPreviewSlide } from "@renderer/lib/actions/preview";
import { goLive, gotoSongSlide } from "@renderer/lib/actions/playback";
import { SongSlideGrid } from "@renderer/components/shared/song-slide-grid";
import { DeckPreviewBar, DeckSlides } from "./deck-slides";
import { PreviewMediaBar } from "./preview-media-bar";

/**
 * The centre column: the preview monitor pinned on top (a fixed box, the same
 * primitive the projector uses — see `Monitor`), and below it everything the
 * previewed item can put on screen, as a grid. A deck shows its slides, a
 * chapter shows its verses, a single media file shows itself. Clicking a
 * tile only moves the preview cursor — going live is always the GO LIVE
 * button's job, never this column.
 */
export function SlidesPanel() {
  const t = useT();
  const content = usePreviewContent();
  const verses = useBibleStore((s) => s.verses);
  const liveVerseIndex = useBibleStore((s) => s.currentVerseIndex);
  const target = usePreviewStore((s) => s.target);
  const base = useProjectionStore((s) => s.base);
  // The slide the PREVIEW monitor draws — the same pick `usePreviewOutput`
  // makes.
  const previewSlideIndex = usePreviewStore((s) => s.slideIndex);
  const previewModelUrl = useDeckStore((s) => {
    if (content?.kind !== "deck") return null;
    const slides = s.byAssetId[content.assetId]?.deck?.slides ?? [];
    return slides[Math.min(previewSlideIndex, slides.length) - 1]?.modelUrl ?? null;
  });

  function body() {
    if (!content) {
      return <EmptyState description={t("slides.placeholderHint")} icon="layers" title={t("slides.placeholder")} />;
    }

    if (content.kind === "deck") {
      return <DeckSlides assetId={content.assetId} missingSince={content.missingSince} />;
    }

    // A verse being previewed brings its whole chapter along, so the operator
    // can walk the passage without going back to the resource tab.
    if (content.kind === "bible" && target?.kind === "verse" && verses.length > 0) {
      const previewedVerseIndex = target.verseIndex;
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
              live={liveVerseIndex === index && base?.kind === "bible"}
              onClick={() => previewVerse(index)}
              onDoubleClick={() => {
                previewVerse(index);
                void goLive();
              }}
              selected={previewedVerseIndex === index}
              tabIndex={tabIndex}
              text={verse.text}
            />
          )}
          scrollToIndex={previewedVerseIndex}
        />
      );
    }

    if (content.kind === "bible") {
      return (
        <SlideGrid>
          <ThumbTile label={content.reference} selected text={content.text} />
        </SlideGrid>
      );
    }

    // The song's slides, the order expanded. A double click sends it live
    // from that slide — or, already live, moves the projector there.
    if (content.kind === "song") {
      const live = base?.kind === "song" && base.songId === content.song.id ? base : null;
      return (
        <SongSlideGrid
          liveIndex={live?.slideIndex ?? null}
          onActivate={(index) => {
            setPreviewSlide(index);
            if (live) gotoSongSlide(index);
            else void goLive();
          }}
          onSelect={setPreviewSlide}
          scrollToIndex={previewSlideIndex}
          selectedIndex={previewSlideIndex}
          song={content.resolved}
          theme={content.theme}
        />
      );
    }

    if (content.kind === "media" && content.asset.missingSince !== null) {
      return <PreviewMissingState assetId={content.asset.id} />;
    }

    // A live image needs no grid content of its own — the preview monitor
    // above already shows it full-size. Every other kind's dismiss control
    // lives outside this grid entirely (see `mediaBar` below), so there is
    // nothing left to render here for either.
    return null;
  }

  // Every previewed item gets a closable row below the monitor — the "x"
  // clears the preview back to empty (`clearPreview`), so an operator can back
  // out of a wrong pick without touching the schedule/library selection by
  // hand. Video/audio keep their own richer bar (scrubber, preview playback),
  // a deck its soundtrack strip; everything else is a plain `MediaTrackRow`
  // with nothing but the close button.
  // Rendered as a sibling of the monitor, never inside `PanelBody`, so it lands
  // on the same pixel as the first row under LIVE instead of picking up an
  // extra layer of padding — see `MonitorsColumn`.
  const mediaBar = (() => {
    if (!content) return null;
    if (content.kind === "deck") {
      return <DeckPreviewBar assetId={content.assetId} missingSince={content.missingSince} />;
    }
    if (content.kind === "media") {
      if (content.asset.kind === "image") {
        return (
          <MediaPanel className="w-full">
            <MediaTrackRow kind="image" label={content.asset.name} onDelete={clearPreview} />
          </MediaPanel>
        );
      }
      return <PreviewMediaBar asset={content.asset} />;
    }
    if (content.kind === "bible") {
      return (
        <MediaPanel className="w-full">
          <MediaTrackRow kind="bible" label={content.reference} onDelete={clearPreview} />
        </MediaPanel>
      );
    }
    // The same transport the LIVE panel gives a projected scene, so a
    // countdown can be armed, paused and aimed here and reach the projector
    // already running — and so the two rows, which can be on screen at once,
    // never show two numbers for one scene (`clockForScene`).
    if (content.kind === "utility") {
      return (
        <MediaPanel className="w-full">
          <UtilityTrackRow onDelete={clearPreview} scene={content.scene} />
        </MediaPanel>
      );
    }
    if (content.kind === "song") {
      return (
        <MediaPanel className="w-full">
          <MediaTrackRow kind="song" label={content.song.title} onDelete={clearPreview} />
        </MediaPanel>
      );
    }
    // A plate goes up from its own row: it does not replace what is live, so
    // the button beside the picture of it is where the operator looks.
    if (content.kind === "plate") {
      return (
        <MediaPanel className="w-full">
          <PlateTrackRow onDelete={clearPreview} plate={content.plate} withLiveButton />
        </MediaPanel>
      );
    }
    return null;
  })();

  const heading =
    content?.kind === "deck"
      ? content.title
      : content?.kind === "media"
        ? content.asset.name
        : content?.kind === "bible"
          ? content.reference
          : content?.kind === "utility"
            ? content.scene.name
            : content?.kind === "plate"
              ? content.plate.name
              : content?.kind === "song"
                ? content.song.title
                : null;

  return (
    <>
      <PanelHeader
        actions={
          <>
            {heading ? (
              <Badge className="min-w-0 flex-1" variant="blue">
                <span className="truncate">{heading}</span>
              </Badge>
            ) : null}
            <DamagedSlideBadge url={previewModelUrl} />
          </>
        }
        title={t("slides.title")}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <PreviewMonitor />
        {mediaBar}
        <PanelBody className="p-1.5">{body()}</PanelBody>
      </div>
    </>
  );
}
