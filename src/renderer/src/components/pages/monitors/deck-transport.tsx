import { useT } from "@renderer/lib/i18n/i18n-provider";
import { cn, formatClock } from "@renderer/lib/utils";
import { Button, IconButton, Icon, MediaPanel, ProgressBar } from "@renderer/components/ui";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useLiveHeading } from "@renderer/lib/hooks/use-live";
import { DECK_SOUNDTRACK_TRACK_ID } from "@renderer/stores/audio.store";
import { advanceSlide, clearBaseContent } from "@renderer/lib/actions/playback";
import { resyncDeck, restartDeck, toggleAutoplay } from "@renderer/effects/deck-autoplay";
import { mediaTargetKey } from "@shared/types/projection";

const DECK_AUDIO_STATUS_KEY = mediaTargetKey({ kind: "audio", trackId: DECK_SOUNDTRACK_TRACK_ID });

/**
 * Transport for the deck currently being projected — it lives under the LIVE
 * monitor, never under the preview one, so its buttons can only ever mean
 * "change what the congregation sees". That is the selected-vs-projected
 * confusion the COM version had.
 *
 * Styled as the same kind of row as `MediaTrackRow`, down to its geometry:
 * icon, truncated title and fixed-size buttons on the first line, and the
 * position bar spanning the full width below with a clock on the left — so a
 * PPT in flight reads as one more media player stacked under the monitor
 * instead of a one-off button bar. See `MediaPanel`.
 */
export function DeckTransport() {
  const t = useT();
  const base = useProjectionStore((s) => s.base);
  const liveDeck = useProjectionStore((s) => s.liveDeck);
  const autoplay = useProjectionStore((s) => s.autoplay);
  const autoplayMode = useProjectionStore((s) => s.autoplayMode);
  // On the last slide «Siguiente» ends the deck, unless its end is to stay there.
  const holdsAtEnd = useSettingsStore((s) => s.settings["projection.deckEnd"] === "hold");
  const heading = useLiveHeading();
  // Filtered by target: the shared slot also carries the video's or other
  // audio tracks' clocks, which must never be read as this deck's.
  const mediaStatus = useProjectionStore((s) => s.mediaStatus[DECK_AUDIO_STATUS_KEY]);

  if (base?.kind !== "deck" || !liveDeck) return null;

  const current = base.slideIndex;
  const total = liveDeck.slides.length;
  const advanceMs = liveDeck.slides[current - 1]?.advanceAfterMs ?? null;

  const autoplayActive = autoplay === "playing" || autoplay === "paused";
  // Once the operator navigates by hand, the slide cursor no longer matches
  // the audio clock this bar reads — showing its old countdown would just be
  // a wrong number. It's shown grayed out instead, with the same-slot button
  // that's the only way back to the synced flow (`resyncDeck`).
  const isDesynced = autoplayMode === "detached" && liveDeck.autoAdvance && autoplayActive;

  // Time-to-next-slide, only meaningful while synced to the soundtrack clock.
  // Kept visible while paused too — `mediaStatus` freezes at the paused
  // timestamp (the reporter stops firing `timeupdate` once the element is
  // paused), so the same calculation just yields a frozen ratio/countdown.
  let elapsedRatio: number | null = null;
  let elapsedSeconds: number | null = null;
  let secondsLeft: number | null = null;
  if (!isDesynced && advanceMs !== null && autoplayActive) {
    const boundary = liveDeck.cumulativeMs[current + 1];
    const start = liveDeck.cumulativeMs[current];
    if (boundary !== undefined && start !== undefined && mediaStatus) {
      const now = mediaStatus.currentTimeSeconds * 1000;
      const ratio = (now - start) / Math.max(1, boundary - start);
      elapsedRatio = Math.min(1, Math.max(0, ratio));
      // Time spent on THIS slide, not the soundtrack's absolute position:
      // the clock has to measure whatever the bar beside it measures, or the
      // two halves of the same line describe different things.
      elapsedSeconds = Math.max(0, (now - start) / 1000);
      secondsLeft = Math.max(0, Math.round((boundary - now) / 1000));
    }
  }

  return (
    <MediaPanel className="shrink-0">
      {/* Both lines are ONE child of `MediaPanel`, never two: the panel
          divides its children with a border, and a rule between a transport's
          controls and its own progress bar would split one row in half.
          Same two-line shape as `MediaTrackRow` — controls on top, position
          across the full width below. */}
      <div className="flex flex-col gap-1 px-2 py-1.5">
        <div className="flex items-center gap-2">
          <Icon className="text-muted-foreground" name="ppt" />

          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{heading ?? ""}</span>

          <IconButton
            aria-label={t("deck.previous")}
            disabled={current <= 1}
            onClick={() => advanceSlide(-1)}
            size="sm"
            variant="ghost"
          >
            <Icon name="prev" />
          </IconButton>

          {liveDeck.autoAdvance ? (
            <>
              <IconButton
                aria-label={autoplay === "playing" ? t("deck.pause") : t("deck.play")}
                onClick={() => toggleAutoplay()}
                size="sm"
                variant="ghost"
              >
                <Icon name={autoplay === "playing" ? "pause" : "play"} />
              </IconButton>
              <IconButton aria-label={t("deck.restart")} onClick={() => restartDeck()} size="sm" variant="ghost">
                <Icon name="restart" />
              </IconButton>
            </>
          ) : null}

          <IconButton
            aria-label={t("deck.next")}
            disabled={holdsAtEnd && current >= total}
            onClick={() => advanceSlide(1)}
            size="sm"
            variant="ghost"
          >
            <Icon name="next" />
          </IconButton>

          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-subtle">
            {t("deck.counter", { current, total })}
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

        {elapsedRatio !== null || isDesynced ? (
          <div className="flex items-center gap-2">
            {/* Keeps its box while desynced (when there is no honest number to
                print) so the bar starts on the same pixel as every scrubber
                stacked above and below it. */}
            <span className="w-[4ch] shrink-0 text-xs tabular-nums text-subtle">
              {elapsedSeconds === null ? "" : formatClock(elapsedSeconds)}
            </span>
            <ProgressBar className={cn("min-w-0 flex-1", isDesynced && "opacity-40")} value={elapsedRatio ?? 0} />
            {isDesynced ? (
              <Button
                className="shrink-0 whitespace-nowrap"
                onClick={() => resyncDeck()}
                size="xs"
                variant="link"
              >
                {t("deck.resync")}
              </Button>
            ) : secondsLeft !== null ? (
              <span className="shrink-0 whitespace-nowrap text-xs text-subtle">
                {t("deck.nextIn", { seconds: secondsLeft })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </MediaPanel>
  );
}
