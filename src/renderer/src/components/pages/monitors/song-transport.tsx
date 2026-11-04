import { useT, useI18n } from "@renderer/lib/i18n/i18n-provider";
import { Badge, Icon, IconButton, MediaPanel } from "@renderer/components/ui";
import { SongSectionButtons } from "@renderer/components/shared/song-section-buttons";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { advanceSong, clearBaseContent, jumpSong, toggleSongLyrics } from "@renderer/lib/actions/playback";
import { sectionLabel } from "@shared/song-text";

/**
 * Transport for the live song — `VerseTransport`'s row: which section is on
 * the projector, previous/next, hide the lyrics (T), the slide count, off —
 * and a button per section that jumps there, like its key.
 */
export function SongTransport() {
  const t = useT();
  const { locale } = useI18n();
  const base = useProjectionStore((s) => s.base);
  if (base?.kind !== "song") return null;
  const total = base.song.slides.length;
  const detourSection = base.detour ? base.song.sections.find((s) => s.key === base.detour?.sectionKey) : undefined;
  const slide = base.song.slides[base.slideIndex - 1];
  const section = detourSection ?? slide;
  const activeKey = detourSection?.key ?? slide?.sectionKey ?? null;

  return (
    <MediaPanel className="shrink-0">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Icon className="size-4 text-accent-ink" name="song" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{base.song.title}</span>
        {section ? (
          <span className="shrink-0 truncate text-xs text-muted-foreground">
            {sectionLabel(section.type, section.number, locale)}
          </span>
        ) : null}
        {base.lyricsHidden ? <Badge variant="neutral">{t("songs.lyricsHidden")}</Badge> : null}
        <IconButton
          aria-label={base.lyricsHidden ? t("songs.showLyrics") : t("songs.hideLyrics")}
          onClick={toggleSongLyrics}
          size="xs"
          title={base.lyricsHidden ? t("songs.showLyrics") : t("songs.hideLyrics")}
          toggled={base.lyricsHidden}
          variant="ghost"
        >
          <Icon name={base.lyricsHidden ? "eyeOff" : "eye"} />
        </IconButton>
        <IconButton
          aria-label={t("songs.previous")}
          disabled={!base.detour && base.slideIndex <= 1}
          onClick={() => advanceSong(-1)}
          size="xs"
          variant="ghost"
        >
          <Icon name="prev" />
        </IconButton>
        <IconButton
          aria-label={t("songs.next")}
          disabled={!base.detour && base.slideIndex >= total}
          onClick={() => advanceSong(1)}
          size="xs"
          variant="ghost"
        >
          <Icon name="next" />
        </IconButton>
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-subtle">
          {base.detour && detourSection
            ? t("songs.detourCounter", { current: base.detour.slideIndex, total: detourSection.slides.length })
            : t("songs.counter", { current: base.slideIndex, total })}
        </span>
        <IconButton aria-label={t("common.remove")} onClick={clearBaseContent} size="xs" variant="ghost">
          <Icon name="close" />
        </IconButton>
      </div>
      <div className="px-2 pb-1.5">
        <SongSectionButtons
          activeKey={activeKey}
          onPick={(picked, shift) => jumpSong({ type: picked.type, number: picked.number }, shift ? -1 : 1)}
          sections={base.song.sections}
        />
      </div>
    </MediaPanel>
  );
}
