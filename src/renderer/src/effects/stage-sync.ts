import { api } from "@renderer/lib/api";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { stageOutputFor } from "@renderer/lib/stage-output";
import { useBibleStore } from "@renderer/stores/bible.store";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useStageStore } from "@renderer/stores/stage.store";
import { survivingAssetId } from "@renderer/stores/program.store";
import { assetThumbUrl, assetThumbVersion } from "@shared/urls";
import { onIpc } from "@renderer/lib/ipc";
import { toast } from "@renderer/lib/toast";

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
    // A video on air keeps the id it went out with; a relocate may have merged its row into a twin since
    // (2026-11-15 audit, D4).
    void api.library
      .get(survivingAssetId(assetId))
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
    const { countdown, message } = useStageStore.getState();
    if (settings["stage.displayId"] === null) {
      lastInputs = [];
      return;
    }
    const posterUrl = posterFor(projection.base?.kind === "video" ? projection.base.assetId : null);
    const inputs = [
      // What the projector shows (the stage draws it, covered or copied whole) and what comes next.
      selectOutputMemo(projection),
      verses,
      currentVerseIndex,
      posterUrl,
      settings["ui.locale"],
      settings["stage.displayId"],
      countdown,
      message,
      settings["stage.layout"],
      settings["stage.mirror"],
      settings["stage.textSize"],
      settings["stage.clockFormat"],
      settings["stage.chords"],
      settings["stage.videoMotion"],
      settings["stage.warnMs"],
      settings["stage.alertMs"],
    ];
    if (inputs.length === lastInputs.length && inputs.every((value, i) => Object.is(value, lastInputs[i]))) return;
    lastInputs = inputs;
    const output = stageOutputFor(
      projection,
      { verses, currentVerseIndex },
      posterUrl,
      {
        countdown,
        message: message && { text: message.text, urgent: message.urgent, seq: message.seq },
        settings,
      },
    );
    // The stage panel's monitor draws what the stage was sent, not a second build of it.
    useStageStore.setState({ output });
    void api.stage.show(output);
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(push);
  };

  // Whether the stage window is on its screen: the panel's dot, and a toast when a screen coming or going is the
  // reason (a cable, a monitor turned off). The warning stays until it is back, like the projector's.
  let lostToastId: string | null = null;
  void api.stage.shown().then(({ closed, shown }) => useStageStore.setState({ closed, shown }));
  const stopStageScreen = onIpc("stage-screen", ({ byScreens, closed, shown }) => {
    useStageStore.setState({ closed, shown });
    if (!byScreens) return;
    if (lostToastId !== null) toast.dismiss(lostToastId);
    lostToastId = null;
    if (shown) toast.success(t("stagePanel.screenBack"));
    else lostToastId = toast.warning(t("stagePanel.screenLost"));
  });

  const unsubscribe = [
    useProjectionStore.subscribe(schedule),
    useBibleStore.subscribe(schedule),
    useSettingsStore.subscribe(schedule),
    useStageStore.subscribe(schedule),
    stopStageScreen,
  ];
  schedule();
  return () => unsubscribe.forEach((off) => off());
}
