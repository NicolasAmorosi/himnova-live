import { ThumbTile } from "@renderer/components/ui";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { cn } from "@renderer/lib/utils";
import { sectionLabel } from "@shared/song-text";
import type { SongDeckSlide, SongTheme } from "@shared/types/song";
import { SECTION_FILL } from "./song-section-fill";
import { SongScene, type SongSlideContent } from "./song-scene";
import { useSongFit } from "@renderer/lib/song-fit";
import { slideLines, songOutputFor } from "@renderer/lib/song-output";
import { findSong, resolveSong, themeForSong, useSongStore } from "@renderer/stores/song.store";

/**
 * One slide of a song, drawn as the projector draws it (owner, 2026-11-04:
 * drawn, not text tiles), with its section's name and colour. `sizeCqw` is
 * the song's own measured size: `null` while it is measured, which paints the
 * tile's skeleton rather than a slide at a size it will not have.
 */
export function SongSlideTile({
  backgroundUrl,
  index,
  live,
  onClick,
  onDoubleClick,
  selected,
  sizeCqw,
  slide,
  tabIndex,
  theme,
}: {
  backgroundUrl: string | null;
  index: number;
  live: boolean;
  onClick: () => void;
  onDoubleClick?: (() => void) | undefined;
  selected: boolean;
  sizeCqw: number | null;
  slide: SongDeckSlide;
  tabIndex?: number | undefined;
  theme: SongTheme;
}) {
  const { locale } = useI18n();
  return (
    <ThumbTile
      index={index}
      label={sectionLabel(slide.type, slide.number, locale)}
      live={live}
      loading={sizeCqw === null}
      media={
        sizeCqw === null ? undefined : (
          <SongSlideMedia content={{ backgroundUrl, lines: slide.lines, sizeCqw, theme }} />
        )
      }
      onClick={onClick}
      {...(onDoubleClick ? { onDoubleClick } : {})}
      overlay={<span className={cn("absolute inset-x-0 bottom-0 h-1", SECTION_FILL[slide.type])} />}
      selected={selected}
      tabIndex={tabIndex}
      title={slide.lines.join(" / ")}
    />
  );
}

/** A slide drawn to fill whatever box it is put in — a tile's, a row's. */
export function SongSlideMedia({ content }: { content: SongSlideContent }) {
  return (
    <div aria-hidden="true" className="@container absolute inset-0 overflow-hidden">
      <SongScene content={content} />
    </div>
  );
}

/** The first slide of a song of the library, at its own size — a schedule
 *  row's picture. Nothing while the song is gone or not yet measured. */
export function SongFirstSlide({ songId }: { songId: number }) {
  const song = useSongStore((s) => findSong(s.songs, songId));
  const themes = useSongStore((s) => s.themes);
  const resolved = song ? resolveSong(song) : null;
  const theme = song ? themeForSong(song, themes) : null;
  const fit = useSongFit(resolved, theme);
  if (!resolved || !theme || !fit) return null;
  return <SongSlideMedia content={songOutputFor(resolved, slideLines(resolved, 1), theme, fit.sizeCqw)} />;
}
