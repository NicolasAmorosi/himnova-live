import { useT } from "@renderer/lib/i18n/i18n-provider";
import { IconButton, Icon, MediaPanel } from "@renderer/components/ui";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useLiveHeading } from "@renderer/lib/hooks/use-live";
import { advanceVerse } from "@renderer/lib/actions/bible";
import { clearBaseContent } from "@renderer/lib/actions/playback";

/**
 * Transport for the verse currently being projected — the Bible counterpart
 * of `DeckTransport`, styled as the same kind of row so a verse in flight
 * reads as one more media player under the LIVE monitor instead of a
 * one-off. Previous/next only move the projector while the live verse
 * belongs to the chapter loaded in the Bible browser (`advanceVerse`); a
 * verse sent live straight from a saved program item has no chapter to walk,
 * so both arrows stay disabled instead of the whole row disappearing.
 */
export function VerseTransport() {
  const t = useT();
  const base = useProjectionStore((s) => s.base);
  const heading = useLiveHeading();
  const currentVerseIndex = useBibleStore((s) => s.currentVerseIndex);
  const verses = useBibleStore((s) => s.verses);

  if (base?.kind !== "bible") return null;

  return (
    <MediaPanel className="shrink-0">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Icon className="text-muted-foreground" name="bible" />

        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{heading ?? ""}</span>

        <IconButton
          aria-label={t("bible.previous")}
          disabled={currentVerseIndex === null || currentVerseIndex <= 0}
          onClick={() => advanceVerse(-1)}
          size="sm"
          variant="ghost"
        >
          <Icon name="prev" />
        </IconButton>

        <IconButton
          aria-label={t("bible.next")}
          disabled={currentVerseIndex === null || currentVerseIndex >= verses.length - 1}
          onClick={() => advanceVerse(1)}
          size="sm"
          variant="ghost"
        >
          <Icon name="next" />
        </IconButton>

        {currentVerseIndex !== null && verses.length > 0 ? (
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-subtle">
            {t("bible.counter", { current: currentVerseIndex + 1, total: verses.length })}
          </span>
        ) : null}

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
    </MediaPanel>
  );
}
