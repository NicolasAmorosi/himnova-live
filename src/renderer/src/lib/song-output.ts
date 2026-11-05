import { assetUrl } from "@shared/urls";
import type { ProjectionOutputKind, SlideEnter } from "@shared/types/projection";
import type { SongPosition } from "@shared/song-jump";
import type { ResolvedSong, SongFooterShow, SongTheme } from "@shared/types/song";

/** The theme's background as a url, when it is an image with a file —
 *  `timerOutputFor`'s sentinel: an image background without one yet is none. */
export function songBackgroundUrl(theme: SongTheme): string | null {
  const { background } = theme;
  return background.kind === "image" && background.assetId > 0 ? assetUrl(background.assetId) : null;
}

/** The lines of the order's slide `slideIndex` (1-based, clamped: a song
 *  edited live may have lost the slide it was on). */
export function slideLines(song: ResolvedSong, slideIndex: number): readonly string[] {
  const index = Math.min(Math.max(1, slideIndex), Math.max(1, song.slides.length));
  return song.slides[index - 1]?.lines ?? [];
}

/** Whether the slide at `position` carries the footer. A detour does only
 *  under «every slide»: it is no slide of the order. */
export function footerShown(show: SongFooterShow, position: SongPosition, total: number): boolean {
  if (position.detour) return show === "all";
  const { slideIndex } = position;
  switch (show) {
    case "never":
      return false;
    case "first":
      return slideIndex === 1;
    case "last":
      return slideIndex === total;
    case "firstAndLast":
      return slideIndex === 1 || slideIndex === total;
    case "all":
      return true;
  }
}

/** The footer lines a slide shows, or `null`. */
export function footerAt(song: ResolvedSong, theme: SongTheme, position: SongPosition): readonly string[] | null {
  return song.footer.length > 0 && footerShown(theme.footer.show, position, song.slides.length) ? song.footer : null;
}

/**
 * One slide of a song as the projection window wants it — shared by
 * `selectOutput`, the PREVIEW monitor and every drawn tile, so none of them
 * can dress a slide differently from the room.
 */
export function songOutputFor(
  song: Pick<ResolvedSong, "id" | "title">,
  lines: readonly string[],
  theme: SongTheme,
  sizeCqw: number,
  footer: readonly string[] | null = null,
  enter: SlideEnter | null = null,
): Extract<ProjectionOutputKind, { kind: "song" }> {
  return {
    kind: "song",
    songId: song.id,
    title: song.title,
    lines,
    footer,
    theme,
    backgroundUrl: songBackgroundUrl(theme),
    sizeCqw,
    enter,
  };
}
