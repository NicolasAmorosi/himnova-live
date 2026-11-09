import { useT, useI18n } from "@renderer/lib/i18n/i18n-provider";
import { Badge, Icon, IconButton, MediaPanel, Segmented } from "@renderer/components/ui";
import { SongSectionButtons } from "@renderer/components/shared/song-section-buttons";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { advanceSong, clearBaseContent, jumpSong, toggleSongLyrics } from "@renderer/lib/actions/playback";
import { setLiveSongLanguage } from "@renderer/lib/actions/songs";
import { findSong, useSongStore } from "@renderer/stores/song.store";
import { hasTranslation, sectionLabel } from "@shared/song-text";
import { SONG_LANGUAGES } from "@shared/types/song";

/**
 * Transport for the live song — `VerseTransport`'s row: which section is on
 * the projector, previous/next, hide the lyrics (T), the slide count, off —
 * and a button per section that jumps there, like its key.
 */
export function SongTransport() {
  const t = useT();
  const { locale } = useI18n();
  const base = useProjectionStore((s) => s.base);
  const songs = useSongStore((s) => s.songs);
  // On the last slide «Siguiente» ends the song, unless its end is to stay there.
  const holdsAtEnd = useSettingsStore((s) => s.settings["projection.songEnd"] === "hold");
  if (base?.kind !== "song") return null;
  // Asked of the stored song: resolved in «original», the live one has none.
  const stored = findSong(songs, base.songId);
  const translated = stored !== null && hasTranslation(stored.sections);
  const total = base.song.slides.length;
  const detourSection = base.detour ? base.song.sections.find((s) => s.key === base.detour?.sectionKey) : undefined;
  const slide = base.song.slides[base.slideIndex - 1];
  const section = detourSection ?? slide;
  const activeKey = detourSection?.key ?? slide?.sectionKey ?? null;

  return (
    <MediaPanel className="shrink-0">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Icon className="text-muted-foreground" name="song" />
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
          size="sm"
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
          size="sm"
          variant="ghost"
        >
          <Icon name="prev" />
        </IconButton>
        <IconButton
          aria-label={t("songs.next")}
          disabled={holdsAtEnd && !base.detour && base.slideIndex >= total}
          onClick={() => advanceSong(1)}
          size="sm"
          variant="ghost"
        >
          <Icon name="next" />
        </IconButton>
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-subtle">
          {base.detour && detourSection
            ? t("songs.detourCounter", { current: base.detour.slideIndex, total: detourSection.slides.length })
            : t("songs.counter", { current: base.slideIndex, total })}
        </span>
        <IconButton
          aria-label={t("live.takeOffAir")}
          onClick={clearBaseContent}
          size="sm"
          title={t("live.takeOffAir")}
          variant="ghost"
        >
          <Icon name="offAir" />
        </IconButton>
      </div>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <SongSectionButtons
            activeKey={activeKey}
            onPick={(picked, shift) => jumpSong({ type: picked.type, number: picked.number }, shift ? -1 : 1)}
            sections={base.song.sections}
          />
        </div>
        {translated ? (
          // The app's one segmented look (2026-11-05), at the bar's 28 px.
          <Segmented
            label={t("songs.language.label")}
            onChange={(language) => void setLiveSongLanguage(language)}
            options={SONG_LANGUAGES.map((language) => ({ label: t(`songs.language.${language}`), value: language }))}
            size="xs"
            value={base.language}
          />
        ) : null}
      </div>
    </MediaPanel>
  );
}
