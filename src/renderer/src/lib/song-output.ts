import { assetUrl } from "@shared/urls";
import type { ProjectionOutputKind } from "@shared/types/projection";
import type { ResolvedSong, SongTheme } from "@shared/types/song";

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
): Extract<ProjectionOutputKind, { kind: "song" }> {
  return {
    kind: "song",
    songId: song.id,
    title: song.title,
    lines,
    theme,
    backgroundUrl: songBackgroundUrl(theme),
    sizeCqw,
  };
}
