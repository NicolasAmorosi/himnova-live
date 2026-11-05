import { useT } from "@renderer/lib/i18n/i18n-provider";
import { DECK_GRID_COLUMNS, SLIDE_GRID_GAP_PX, VirtualGrid, thumbTileHeight } from "@renderer/components/ui";
import { useSongFit } from "@renderer/lib/song-fit";
import { footerAt, songBackgroundUrl } from "@renderer/lib/song-output";
import type { ResolvedSong, SongTheme } from "@shared/types/song";
import { SongSlideTile } from "./song-slide-tile";

/**
 * A song's slides as a grid — the PREVIEW column's and the LIVE column's, so
 * both draw a song the same way. The order is expanded: a chorus sung three
 * times is three tiles, each with its section's name and colour. Indexes are
 * 1-based, like a deck's.
 */
export function SongSlideGrid({
  liveIndex,
  onActivate,
  onSelect,
  scrollToIndex,
  selectedIndex,
  song,
  theme,
}: {
  liveIndex: number | null;
  onActivate?: (index: number) => void;
  onSelect: (index: number) => void;
  /** The grid follows this one (1-based): the preview cursor, or the projector. */
  scrollToIndex: number | null;
  selectedIndex: number | null;
  song: ResolvedSong;
  theme: SongTheme;
}) {
  const t = useT();
  const fit = useSongFit(song, theme);
  const backgroundUrl = songBackgroundUrl(theme);
  const slides = song.slides.map((slide, i) => ({ slide, index: i + 1 }));

  return (
    <VirtualGrid
      aria-label={t("songs.slidesLabel", { title: song.title })}
      columns={DECK_GRID_COLUMNS}
      gap={SLIDE_GRID_GAP_PX}
      itemHeight={(columnWidth) => thumbTileHeight(columnWidth, { label: true })}
      itemKey={({ index }) => index}
      items={slides}
      renderItem={({ index, slide }, _i, { tabIndex }) => (
        <SongSlideTile
          backgroundUrl={backgroundUrl}
          footer={footerAt(song, theme, { slideIndex: index, detour: null })}
          index={index}
          live={liveIndex === index}
          onClick={() => onSelect(index)}
          onDoubleClick={onActivate ? () => onActivate(index) : undefined}
          selected={selectedIndex === index}
          sizeCqw={fit?.sizeCqw ?? null}
          slide={slide}
          tabIndex={tabIndex}
          theme={theme}
        />
      )}
      scrollToIndex={scrollToIndex === null ? null : scrollToIndex - 1}
    />
  );
}
