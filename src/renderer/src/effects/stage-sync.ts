import { api } from "@renderer/lib/api";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { stageOutputFor } from "@renderer/lib/stage-output";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { assetThumbUrl, assetThumbVersion } from "@shared/urls";

/**
 * Keeps the musicians' screen (`stage:show`) in step with what is live. Built
 * only while a stage screen is chosen, and only when something it reads
 * changed — compared by reference, like `selectOutputMemo`: the projection
 * store's busiest writer, `setMediaStatus`, changes none of it. Coalesced
 * into a microtask, like `projection-sync.ts`, so a GO LIVE's several `set()`s
 * send one picture.
 */
export function startStageSync(): () => void {
  let lastInputs: readonly unknown[] = [];
  let queued = false;
  /** The live video's thumbnail, fetched once per video. */
  let poster: { assetId: number; url: string | null } | null = null;

  const posterFor = (assetId: number | null): string | null => {
    if (assetId === null) return null;
    if (poster?.assetId === assetId) return poster.url;
    poster = { assetId, url: null };
    void api.library
      .get(assetId)
      .then((asset) => {
        if (poster?.assetId !== assetId || !asset) return;
        poster = { assetId, url: assetThumbUrl(asset.id, assetThumbVersion(asset)) };
        schedule();
      })
      .catch(() => undefined); // No poster is a black frame: still the truth.
    return null;
  };

  const push = () => {
    queued = false;
    const projection = useProjectionStore.getState();
    const { verses, currentVerseIndex } = useBibleStore.getState();
    const { settings } = useSettingsStore.getState();
    if (settings["stage.displayId"] === null) {
      lastInputs = [];
      return;
    }
    const posterUrl = posterFor(projection.base?.kind === "video" ? projection.base.assetId : null);
    const inputs = [
      projection.base,
      projection.overlay,
      projection.liveDeck,
      projection.bibleStyle,
      projection.slideText,
      verses,
      currentVerseIndex,
      posterUrl,
      settings["ui.locale"],
      settings["stage.displayId"],
    ];
    if (inputs.length === lastInputs.length && inputs.every((value, i) => Object.is(value, lastInputs[i]))) return;
    lastInputs = inputs;
    void api.stage.show(
      stageOutputFor(projection, { verses, currentVerseIndex }, posterUrl, {
        black: t("status.black"),
        logo: t("status.logo"),
        lyricsHidden: t("stage.lyricsHidden"),
        next: t("stage.next"),
      }),
    );
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(push);
  };

  const unsubscribe = [
    useProjectionStore.subscribe(schedule),
    useBibleStore.subscribe(schedule),
    useSettingsStore.subscribe(schedule),
  ];
  schedule();
  return () => unsubscribe.forEach((off) => off());
}
