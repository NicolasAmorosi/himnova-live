import { useT, useI18n } from "@renderer/lib/i18n/i18n-provider";
import { Icon, IconButton, MediaPanel } from "@renderer/components/ui";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { advanceSong, clearBaseContent } from "@renderer/lib/actions/playback";
import { sectionLabel } from "@shared/song-text";

/**
 * Transport for the live song — `VerseTransport`'s row: which section is on
 * the projector, previous/next, the slide count, and off.
 */
export function SongTransport() {
  const t = useT();
  const { locale } = useI18n();
  const base = useProjectionStore((s) => s.base);
  if (base?.kind !== "song") return null;
  const total = base.song.slides.length;
  const slide = base.song.slides[base.slideIndex - 1];

  return (
    <MediaPanel className="shrink-0">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Icon className="size-4 text-accent-ink" name="song" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{base.song.title}</span>
        {slide ? (
          <span className="shrink-0 truncate text-xs text-muted-foreground">
            {sectionLabel(slide.type, slide.number, locale)}
          </span>
        ) : null}
        <IconButton
          aria-label={t("songs.previous")}
          disabled={base.slideIndex <= 1}
          onClick={() => advanceSong(-1)}
          size="xs"
          variant="ghost"
        >
          <Icon name="prev" />
        </IconButton>
        <IconButton
          aria-label={t("songs.next")}
          disabled={base.slideIndex >= total}
          onClick={() => advanceSong(1)}
          size="xs"
          variant="ghost"
        >
          <Icon name="next" />
        </IconButton>
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-subtle">
          {t("songs.counter", { current: base.slideIndex, total })}
        </span>
        <IconButton aria-label={t("common.remove")} onClick={clearBaseContent} size="xs" variant="ghost">
          <Icon name="close" />
        </IconButton>
      </div>
    </MediaPanel>
  );
}
