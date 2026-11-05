import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { useAudioStore, type LiveAudioTrack } from "@renderer/stores/audio.store";
import { useDeckStore } from "@renderer/stores/deck.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { freezeLivePositions } from "@renderer/lib/actions/live-positions";
import { getCachedMediaAsset } from "@renderer/lib/hooks/use-media-asset";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import { startDeckAutoplay } from "./deck-autoplay";
import { startDeckSounds } from "./deck-sounds";
import { startEndOfPlaybackEffects } from "./end-of-playback";
import { startPlateAutoHide } from "./plate-auto-hide";
import { mediaErrorKey } from "@shared/types/projection";
import type { AudioTrackPush, ProjectionMediaError, ProjectionOutput } from "@shared/types/projection";

/**
 * `track.paused` is the operator's own declarative pause and must survive a
 * BLACK/LOGO round-trip unchanged (same rule as `VideoUnderlay.paused` vs.
 * `LiveVideo`'s `covered`) — so covering is combined into the pushed value
 * here, never written back into `useAudioStore`. Only the deck's own
 * soundtrack reacts to the cover; a standalone audio asset sent live is
 * intentionally independent of what's on screen (see `audio.store.ts`).
 */
function toAudioTrackPush(track: LiveAudioTrack, covered: boolean): AudioTrackPush {
  return {
    trackId: track.trackId,
    url: track.url,
    epoch: track.epoch,
    paused: track.paused || (track.source === "deck" && covered),
    startAtSeconds: track.startAtSeconds,
    volume: track.volume,
    loop: track.loop,
  };
}

/**
 * A toast that just says "something failed" is barely worth interrupting the
 * operator for — the name of the file is the whole point. An audio track
 * carries its own label; everything else is the current base content, whose
 * asset the header and the media panel have already resolved, so the cache is
 * warm in practice and the generic message is only a fallback.
 */
function describeMediaError(error: ProjectionMediaError): string | null {
  if (error.target.kind === "audio") {
    const { trackId } = error.target;
    const track = useAudioStore.getState().tracks.find((candidate) => candidate.trackId === trackId);
    if (track) return track.label;
  }
  if (error.target.kind === "plate") {
    return useProjectionStore.getState().livePlates.find((plate) => plate.kind === "bug")?.name ?? null;
  }
  const base = useProjectionStore.getState().base;
  const assetId =
    base && (base.kind === "deck" || base.kind === "video" || base.kind === "image")
      ? base.assetId
      : null;
  return getCachedMediaAsset(assetId)?.name ?? null;
}

/**
 * Wires the control window to main. What used to live here — the PowerPoint
 * overlay dance, which hid the projection window so PowerPoint's own fullscreen
 * slideshow could show through — is gone: slides are images now, the projection
 * window is never hidden, and BLACK/LOGO work through `selectOutput` like any
 * other content.
 *
 * `selectOutputMemo` gives the subscription stable identity, so the default
 * comparator is enough and no equalityFn workaround is needed.
 */
export function startProjectionEffects(): () => void {
  // Coalesced into a microtask rather than sent on every `set()`: a single
  // user action (e.g. `goLiveWithDeck` — `setLiveDeck` + `setBase` +
  // `setOverlay`, all synchronous) fires this listener once per call, and
  // without batching, the projector would briefly show each intermediate
  // state — most visibly, `clearLive()`'s `setOverlay("none")` before
  // `setBase(null)` would flash whatever was still live for a frame before
  // landing on the logo. Queuing the *last* value and flushing once per
  // microtask means only the final state of a synchronous batch is ever
  // pushed, which is also what makes a single scene transition (one
  // `sceneEpoch`) correspond to exactly one push to the projection window.
  let pendingOutput: ProjectionOutput | null = null;
  let flushScheduled = false;
  const unsubscribeOutput = useProjectionStore.subscribe(selectOutputMemo, (next) => {
    pendingOutput = next;
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      if (pendingOutput) void api.projection.show(pendingOutput);
    });
  });

  // Coalesced the same way as the output above, and for the same reason: going
  // live from BLACK from deck A to deck B is `setOverlay("none")` and then
  // `setDeckTrack(B)` in one synchronous action, and pushing each set on its
  // own sent A's soundtrack UNcovered for a moment before B replaced it.
  let audioFlushScheduled = false;
  const pushAudioTracks = () => {
    if (audioFlushScheduled) return;
    audioFlushScheduled = true;
    queueMicrotask(() => {
      audioFlushScheduled = false;
      const covered = useProjectionStore.getState().overlay !== "none";
      const tracks = useAudioStore.getState().tracks;
      // The one place that knows the complete live track list, so it is also
      // where the status slots of tracks that no longer exist get collected —
      // every path that can retire a track (`removeTrack`, `restartTrack`'s new
      // epoch, `setDeckTrack`, `clear`) ends up here.
      useProjectionStore.getState().pruneMediaStatus(tracks.map((track) => track.trackId));
      void api.projection.setAudioTracks(tracks.map((track) => toAudioTrackPush(track, covered)));
    });
  };

  const unsubscribeAudioTracks = useAudioStore.subscribe((state) => state.tracks, pushAudioTracks);
  // Re-push on every overlay toggle too, purely to recompute the deck-track's
  // effective `paused` above — `useAudioStore.tracks` itself doesn't change.
  const unsubscribeOverlayForAudio = useProjectionStore.subscribe(
    (state) => state.overlay,
    pushAudioTracks,
  );

  // The projector went away without this window asking (Cmd+W on it, a crash).
  // Nothing else can tell: `presentationOpen` is otherwise only ever written by
  // the actions that open and close it deliberately, so it would stay `true`
  // forever and make `openIfNeeded()` a silent no-op.
  let closedToastId: string | null = null;
  const unsubscribeProjectionClosed = onIpc("projection-closed", () => {
    // Every media element that was playing has just ceased to exist, so its
    // position is folded back into where it would resume before anything can
    // reopen the window. See `live-positions.ts`.
    freezeLivePositions();
    useProjectionStore.getState().setPresentationOpen(false);
    // The header quietly switching to "Projector off" is not a signal an
    // operator sees: mid-service they are looking at the room, not at the
    // chrome. The toast goes after its 10 s like every toast (owner,
    // 2026-11-05) — the LIVE header keeps a «Sin pantalla» warning with «Abrir
    // pantalla» beside it for as long as it lasts —, and its action reopens onto
    // whatever was live, replayed from main's snapshot — routing it through
    // `open()` instead would land on BLACK and force a second GO LIVE, which
    // re-sends the PREVIEW target rather than what the congregation was
    // watching.
    closedToastId = toast.danger(t("projector.closedUnexpectedly"), {
      action: {
        label: t("projector.reopen"),
        onClick: () => void useDisplayStore.getState().openIfNeeded(),
      },
    });
  });

  // Retires that toast once the projector is back by any route — its own
  // action, GO LIVE, BLACK/LOGO or Settings. A permanent notice offering to
  // reopen something that is already open is pure noise in a dark booth.
  const unsubscribePresentationOpen = useProjectionStore.subscribe(
    (state) => state.presentationOpen,
    (open) => {
      if (!open || closedToastId === null) return;
      toast.dismiss(closedToastId);
      closedToastId = null;
    },
  );

  const unsubscribeStatus = onIpc("media-status", (status) => {
    useProjectionStore.getState().setMediaStatus(status);

    // A standalone audio track that finished on its own just disappears —
    // the operator never has to clean it up. The deck's own soundtrack is
    // exempt: it belongs to the deck's lifecycle (restart, re-sync), not to
    // "this one play finished".
    const { target } = status;
    if (status.ended && target.kind === "audio") {
      const track = useAudioStore.getState().tracks.find((t) => t.trackId === target.trackId);
      if (track?.source === "asset") useAudioStore.getState().removeTrack(track.trackId);
    }
  });

  // A file the projector could not load or decode. The store entry is what
  // paints the notice on the LIVE monitor and marks the row in the media
  // panel; the toast is for the operator who is looking anywhere else — which,
  // mid-service, is most of the time.
  const unsubscribeError = onIpc("media-error", (error) => {
    const { mediaErrors, setMediaError } = useProjectionStore.getState();
    // Already reported for this exact element and file: a deck navigated over
    // several broken slides, or a reload retrying the same missing track,
    // would otherwise stack one toast per attempt on top of the operator.
    const alreadyReported = mediaErrors[mediaErrorKey(error.target)]?.url === error.url;
    setMediaError(error);
    if (alreadyReported) return;

    const name = describeMediaError(error);
    toast.danger(name === null ? t("media.loadErrorToastGeneric") : t("media.loadErrorToast", { name }));
  });

  const unsubscribeProgress = onIpc("deck-progress", (progress) => {
    useDeckStore.getState().applyProgress(progress);
  });

  const unsubscribePrewarmProgress = onIpc("prewarm-progress", (progress) => {
    useDeckStore.getState().applyPrewarmProgress(progress);
  });

  // Not a conversion finishing — main learned which already-cached deck some
  // assets' bytes belong to (the startup content-hash backfill). Same
  // consequence for this window as a deck reaching `ready`: whatever grid is
  // on screen has to re-ask `deck:statuses`, so it rides the same epoch.
  const unsubscribeStatusesChanged = onIpc("deck-statuses-changed", () => {
    useDeckStore.getState().markStatusesChanged();
  });

  const unsubscribeDeckUpdated = onIpc("deck-updated", ({ deckId }) => {
    useDeckStore.getState().refreshDeck(deckId);
  });

  const unsubscribeDisplaysChanged = onIpc("displays-changed", () => {
    void useDisplayStore.getState().refresh();
  });

  // The projector's screen went away: main hid the window — still playing,
  // sound included — and puts it back when a screen returns
  // (`windows/projector-screen.ts`). The operator only has to be told, and the
  // notice stays until it is true again.
  let screenLostToastId: string | null = null;
  const unsubscribeProjectorScreen = onIpc("projector-screen", ({ connected }) => {
    if (screenLostToastId !== null) toast.dismiss(screenLostToastId);
    screenLostToastId = null;
    if (connected) toast.success(t("projector.screenBack"));
    else screenLostToastId = toast.warning(t("projector.screenLost"));
  });

  const stopAutoplay = startDeckAutoplay();
  const stopDeckSounds = startDeckSounds();
  const stopEndOfPlayback = startEndOfPlaybackEffects();
  const stopPlateAutoHide = startPlateAutoHide();

  return () => {
    unsubscribeOutput();
    unsubscribeAudioTracks();
    unsubscribeOverlayForAudio();
    unsubscribeProjectionClosed();
    unsubscribePresentationOpen();
    unsubscribeStatus();
    unsubscribeError();
    unsubscribeProgress();
    unsubscribePrewarmProgress();
    unsubscribeStatusesChanged();
    unsubscribeDeckUpdated();
    unsubscribeDisplaysChanged();
    unsubscribeProjectorScreen();
    stopAutoplay();
    stopDeckSounds();
    stopEndOfPlayback();
    stopPlateAutoHide();
  };
}
