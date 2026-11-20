import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { playableAssetUrl, useEngineAssetsStore } from "@renderer/stores/engine-assets.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useDeckStore } from "@renderer/stores/deck.store";
import { survivingAssetId } from "@renderer/stores/program.store";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import type { DecoderSupport } from "@shared/types/media";
import { SLIDE_VIDEO_STATUS_KEY } from "@shared/types/projection";

const deckVideoId = (url: string) => /^worship:\/\/(?:engine\/)?deck-video\/(\d+)/.exec(url)?.[1];

/**
 * What only this renderer's Chromium can say: whether the GPU decodes HEVC.
 * `isTypeSupported` answers for the platform decoder, which is the only HEVC
 * decoder Chromium has — no software fallback — so on a PC without one an
 * iPhone video would play as silence over black. The media engine plays those.
 */
function decoderSupport(): DecoderSupport {
  const supports = (codecs: string) => {
    try {
      return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(`video/mp4; codecs="${codecs}"`);
    } catch {
      return false;
    }
  };
  return { hevc: supports("hvc1.1.6.L93.B0"), hevcMain10: supports("hvc1.2.4.L153.B0") };
}

/**
 * Mirrors what main sends to the media engine into `engine-assets.store`, and is
 * what starts it: main decides nothing until it hears what this machine decodes.
 *
 * Subscribed before the list is fetched. Events and invoke replies travel the
 * same ordered pipe, so an event that arrives before the reply describes an
 * older state the reply supersedes, and every one after it is newer.
 */
/**
 * A decision that lands while its file is already live. An AVI sent live within ~0.5 s of its import
 * or of the app's launch — before main's first decision — went out as a `<video>` Chromium cannot
 * open, and stayed black and silent: nothing re-armed it (2026-11-10 review, agent2v-01). Re-pointed
 * in place, from where it is: the same scene, no fade, and main starts the engine for the new url.
 */
export function rearmLive(assetId: number): void {
  // A row a relocate merged away left the engine's list, but what is on the air with it plays on as it went out
  // (2026-11-15 audit, D4): re-pointed at a `<video>` Chromium cannot open, it went black.
  if (survivingAssetId(assetId) !== assetId) return;
  const url = playableAssetUrl(assetId);
  const projection = useProjectionStore.getState();
  const { base, videoPaused, videoVolume } = projection;
  if (base?.kind === "video" && base.assetId === assetId && base.url !== url) {
    const status = projection.mediaStatus.video;
    const at = status?.epoch === base.epoch ? status.currentTimeSeconds : base.startAtSeconds;
    projection.setBase({ ...base, url, startAtSeconds: at });
    // `setBase` means «something new is live» and resets the operator's pause and volume; this is the same video
    // (2026-11-15 audit, A33). Put back in the same synchronous batch, so `projection-sync` pushes one output.
    projection.setVideoPaused(videoPaused);
    projection.setVideoVolume(videoVolume);
  }
  // A song's video background, re-dressed in place: a background keeps no position, so it starts again.
  if (
    base?.kind === "song" &&
    base.theme.background.kind === "video" &&
    base.theme.background.assetId === assetId &&
    base.backgroundVideo !== null &&
    base.backgroundVideo.url !== url
  ) {
    projection.setLiveSong(base.song, base.theme, base.sizeCqw, base.slideIndex, base.language);
  }
  const audio = useAudioStore.getState();
  for (const track of audio.tracks) {
    if (track.source === "asset" && track.assetId === assetId && track.url !== url) audio.setUrl(track.trackId, url);
  }
}

/**
 * The live deck's clips follow its DTO, as `rearmLive` does a library file: a clip the engine takes after GO LIVE, or
 * one it failed on and gave back to Chromium (owner, 2026-11-17), changes url in the deck store, never in the
 * `liveDeck` snapshot. Patched in place, from where the clip is: `setLiveDeck` would start the deck's music over and
 * send a synced deck back to slide 1.
 */
export function rearmLiveClips(): void {
  const state = useProjectionStore.getState();
  const live = state.liveDeck;
  const fresh = live ? useDeckStore.getState().byAssetId[live.assetId]?.deck : null;
  if (!live || !fresh || fresh.deckId !== live.deckId) return;
  let changed = false;
  const videos = live.videos.map((video) => {
    const url = fresh.videos.find((candidate) => candidate.slideIndex === video.slideIndex)?.url;
    if (url === undefined || url === video.url || deckVideoId(url) !== deckVideoId(video.url)) return video;
    changed = true;
    return { ...video, url };
  });
  if (!changed) return;
  const status = state.mediaStatus[SLIDE_VIDEO_STATUS_KEY];
  const at = status?.epoch === state.slideVideoEpoch ? status.currentTimeSeconds : state.slideVideoStartAt;
  useProjectionStore.setState({ liveDeck: { ...live, videos }, slideVideoStartAt: at });
}

/** Once a session: the engine failed and a video went on in Chromium (owner, 2026-11-17). Never in the room. */
let fallbackSaid = false;

export function startEngineAssetsSync(): () => void {
  const unsubscribe = onIpc("engine-asset-changed", (update) => {
    useEngineAssetsStore.getState().apply(update);
    rearmLive(update.assetId);
  });
  const offFallback = onIpc("engine-fallback", () => {
    if (fallbackSaid) return;
    fallbackSaid = true;
    toast.info(t("media.engineFallbackToast"));
  });
  void (async () => {
    try {
      await api.engine.reportDecoders(decoderSupport());
      const assets = await api.engine.assets();
      useEngineAssetsStore.getState().reset(assets);
      for (const assetId of assets) rearmLive(assetId);
    } catch (error) {
      console.warn("[engine] sync failed", error);
    }
  })();
  const offClips = useDeckStore.subscribe((next, prev) => {
    if (next.byAssetId !== prev.byAssetId) rearmLiveClips();
  });
  return () => {
    unsubscribe();
    offFallback();
    offClips();
  };
}
