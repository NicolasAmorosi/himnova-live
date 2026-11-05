import { useT } from "@renderer/lib/i18n/i18n-provider";
import {
  Badge,
  Button,
  Menu,
  Callout,
  DECK_GRID_COLUMNS,
  EmptyState,
  Icon,
  IconButton,
  MediaPanel,
  SLIDE_GRID_GAP_PX,
  ThumbTile,
  Tooltip,
  VirtualGrid,
  thumbTileHeight,
} from "@renderer/components/ui";
import { PreviewMissingState } from "@renderer/components/shared/preview-missing-state";
import { ModelSlide } from "@renderer/components/shared/slide-view/ModelSlide";
import { DeckConversionStatus } from "@renderer/components/shared/deck-conversion-status";
import { DamagedSlideMark } from "@renderer/components/shared/damaged-slide";
import { useDeck } from "@renderer/lib/hooks/use-deck";
import { useDeckStore } from "@renderer/stores/deck.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { clearPreview, setPreviewSlide } from "@renderer/lib/actions/preview";
import { seekPreview, togglePreviewPlayback } from "@renderer/lib/actions/preview-playback";
import { usePreviewEngineSound } from "@renderer/lib/hooks/use-preview-engine-video";
import { MediaTrackRow } from "@renderer/components/shared/media-track-row";
import { previewSoundtrackUrl } from "@shared/urls";
import { goLive, gotoSlide } from "@renderer/lib/actions/playback";
import { api } from "@renderer/lib/api";
import type { DeckDTO } from "@shared/types/deck";

/**
 * A deck under the PREVIEW monitor, the same two lines as EN VIVO's
 * (`DeckTransport`) — owner, 2026-11-05: «que aparezca todo como en vivo pero
 * con el volumen a 0»:
 *
 * - the deck: its name, ◀ ▶ through PREVIEW's slides (never on their own —
 *   the deck's timings play only on the projector), the counter, «Auto-avance»
 *   when it has timings, and the ✕ that clears PREVIEW;
 * - its music: play, position and PREVIEW's volume (0 with every new item,
 *   silenced the moment it goes live), and assigning, changing or removing a
 *   linked file. No «Sin audio» line: a deck without music only offers to
 *   assign one.
 */
function DeckPreviewTransport({ deck, title }: { deck: DeckDTO; title: string }) {
  const t = useT();
  const { refresh } = useDeck(deck.assetId);
  const current = usePreviewStore((s) => s.slideIndex);
  const positionSeconds = usePreviewStore((s) => s.positionSeconds);
  const durationSeconds = usePreviewStore((s) => s.durationSeconds);
  const playing = usePreviewStore((s) => s.playing);
  const volume = usePreviewStore((s) => s.volume);
  const setVolume = usePreviewStore((s) => s.setVolume);
  const total = deck.slides.length;
  const soundtrackUrl = deck.soundtrack ? previewSoundtrackUrl(deck.soundtrack.url) : null;
  const soundFailed = usePreviewEngineSound(soundtrackUrl) !== null;
  const duration = durationSeconds > 0 ? durationSeconds : (deck.soundtrack?.durationMs ?? 0) / 1000;

  /** A linked file keeps its url (`worship://linked-audio/<deck>`) whatever
   *  file it names, so PREVIEW's engine would go on playing the old one: it is
   *  stopped, and the row starts over. */
  function forgetPlayedMusic() {
    void api.preview.setVideo(null);
    const preview = usePreviewStore.getState();
    preview.setPlaying(false);
    preview.setPositionSeconds(0);
    preview.setDurationSeconds(0);
  }

  async function assign() {
    const paths = await api.files.pick("audio", false);
    const chosen = paths[0];
    if (!chosen) return;
    forgetPlayedMusic();
    await api.library.setLinkedAudio(deck.assetId, chosen);
    refresh();
  }

  async function remove() {
    forgetPlayedMusic();
    await api.library.setLinkedAudio(deck.assetId, null);
    refresh();
  }

  // Music from inside the file is the deck's own and cannot be swapped. With
  // none, the one action shows; a linked file's two live in «⋯», so the deck's
  // name keeps its room on the line (2026-11-05).
  const audioActions =
    deck.soundtrack === null ? (
      <Tooltip content={t("deck.audio.help")} floating>
        <Button onClick={() => void assign()} size="xs" variant="ghost">
          <Icon name="audio" />
          {t("deck.audio.assign")}
        </Button>
      </Tooltip>
    ) : deck.soundtrack.origin === "linked" ? (
      <Menu
        align="end"
        icon="more"
        label={t("deck.audio.more")}
        size="sm"
        onSelect={(command) => void (command === "change" ? assign() : remove())}
        options={[
          { label: t("deck.audio.change"), value: "change" },
          { label: t("deck.audio.remove"), tone: "danger", value: "remove" },
        ]}
      />
    ) : null;

  return (
    <MediaPanel>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Icon className="text-muted-foreground" name="ppt" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{title}</span>
        {deck.autoAdvance ? <Badge variant="blue">{t("deck.audio.autoAdvance")}</Badge> : null}
        <IconButton
          aria-label={t("deck.previous")}
          disabled={current <= 1}
          onClick={() => setPreviewSlide(current - 1)}
          size="sm"
          variant="ghost"
        >
          <Icon name="prev" />
        </IconButton>
        <IconButton
          aria-label={t("deck.next")}
          disabled={current >= total}
          onClick={() => setPreviewSlide(current + 1)}
          size="sm"
          variant="ghost"
        >
          <Icon name="next" />
        </IconButton>
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-subtle">
          {t("deck.counter", { current, total })}
        </span>
        {audioActions}
        <IconButton aria-label={t("preview.clear")} onClick={clearPreview} size="sm" variant="ghost">
          <Icon name="close" />
        </IconButton>
      </div>
      {deck.soundtrack && soundtrackUrl ? (
        <MediaTrackRow
          currentSeconds={positionSeconds}
          durationSeconds={duration}
          error={soundFailed ? t("media.loadError") : undefined}
          kind="audio"
          label={deck.soundtrack.name}
          onRestart={duration ? () => seekPreview(0) : undefined}
          onSeek={duration ? seekPreview : undefined}
          onTogglePause={togglePreviewPlayback}
          onVolumeChange={setVolume}
          paused={!playing}
          volume={volume}
        />
      ) : null}
    </MediaPanel>
  );
}

/**
 * The deck's rows under the PREVIEW monitor, once it is read. A sibling of the
 * monitor in `SlidesPanel` like every other kind's row — inside the grid's
 * padded body it sat 6px lower and narrower than `DeckTransport` under LIVE.
 */
export function DeckPreviewBar({
  assetId,
  missingSince,
  title,
}: {
  assetId: number;
  missingSince: number | null;
  title: string;
}) {
  const deck = useDeckStore((s) => {
    const entry = s.byAssetId[assetId];
    return entry?.status === "ready" ? entry.deck : null;
  });
  if (missingSince !== null || !deck) return null;
  return <DeckPreviewTransport deck={deck} title={title} />;
}

export function DeckSlides({ assetId, missingSince }: { assetId: number; missingSince: number | null }) {
  const t = useT();
  // A missing source file has nothing to read — skip `useDeck`'s ensure
  // trigger entirely instead of surfacing its "couldn't open" error for a
  // file that was never going to exist.
  const { entry, markStale, reconvert } = useDeck(missingSince !== null ? null : assetId);
  const base = useProjectionStore((s) => s.base);
  const previewIndex = usePreviewStore((s) => s.slideIndex);

  const isLive = base?.kind === "deck" && base.assetId === assetId;
  const liveIndex = isLive ? base.slideIndex : null;

  if (missingSince !== null) {
    return <PreviewMissingState assetId={assetId} />;
  }

  const slides = entry?.deck?.slides ?? [];

  /** «Read again»/«Retry» over slides that are still there. */
  const reconvertAction = (label: string) => (
    // Outline like every «Retry» inside content (2026-11-04 review: five looks).
    <Button className="mt-2" onClick={reconvert} size="sm" variant="outline">
      {label}
    </Button>
  );

  // Only fall back to the loading/failed placeholder when there is nothing
  // else to show. A deck that already has a rendered grid (from a previous
  // `ready` DTO still sitting in the store) keeps showing it even while
  // `entry.status` flips to `converting` — e.g. `ensure()`'s IPC round-trip
  // for a deck that's actually a cache hit, or a real background
  // reconversion racing a stale grid. Tearing the grid down here is exactly
  // the "monitors lie to the operator" failure this app avoids everywhere
  // else — a slide grid that vanishes and reappears for a deck that was
  // never really being reconverted.
  // A cancelled conversion (`stale` with no DTO — see `DeckConversionStatus`)
  // belongs here too: the "has no slides" empty state below would
  // accuse the file for something the operator chose to do. Spelled out rather
  // than written as `!== "ready"` so this only ever routes states that
  // `DeckConversionStatus` actually renders.
  if (
    slides.length === 0 &&
    (!entry ||
      entry.status === "converting" ||
      entry.status === "failed" ||
      (entry.status === "stale" && entry.deck === null))
  ) {
    return (
      <div className="self-center py-6">
        <DeckConversionStatus assetId={assetId} onRetry={reconvert} />
      </div>
    );
  }

  if (slides.length === 0) {
    return <EmptyState icon="layers" title={t("deck.noSlides")} />;
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {entry?.status === "stale" ? (
        <Callout tone="warning">
          <p>{t("deck.stale")}</p>
          {reconvertAction(t("deck.reconvert"))}
        </Callout>
      ) : null}
      {entry?.status === "failed" ? (
        <Callout tone="danger">
          <p>{entry.error ?? t("deck.failed")}</p>
          {reconvertAction(t("deck.retry"))}
        </Callout>
      ) : null}
      <VirtualGrid
        aria-label={t("deck.title")}
        columns={DECK_GRID_COLUMNS}
        gap={SLIDE_GRID_GAP_PX}
        itemHeight={(columnWidth) => thumbTileHeight(columnWidth, { label: false })}
        itemKey={(slide) => slide.index}
        items={slides}
        renderItem={(slide, _index, { tabIndex }) => (
          <ThumbTile
            index={slide.index}
            live={liveIndex === slide.index}
            onClick={() => setPreviewSlide(slide.index)}
            // The cache dir can be evicted under us; surface it instead of
            // leaving a broken image.
            onImageError={markStale}
            // Already live: jump on the projector. Not live: this deck goes on
            // air starting from the slide that was double-clicked.
            onDoubleClick={() => {
              setPreviewSlide(slide.index);
              if (isLive) gotoSlide(slide.index);
              else void goLive();
            }}
            selected={previewIndex === slide.index}
            media={slide.modelUrl ? <ModelSlide onError={markStale} url={slide.modelUrl} /> : undefined}
            overlay={<DamagedSlideMark url={slide.modelUrl} />}
            src={slide.modelUrl ? null : slide.thumbUrl}
            tabIndex={tabIndex}
            title={t("deck.slideAlt", { index: slide.index })}
          />
        )}
        // A slide's `index` is 1-based, the way EasyWorship numbers them; this
        // grid works in array positions.
        scrollToIndex={previewIndex - 1}
      />
    </div>
  );
}
