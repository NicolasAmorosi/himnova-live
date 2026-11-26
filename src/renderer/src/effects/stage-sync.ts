import { api } from "@renderer/lib/api";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { stageOutputFor, stageSong, TEXT_SCALE, type StageLyricsFit } from "@renderer/lib/stage-output";
import { fitSongSize, knownSongFit } from "@renderer/lib/song-fit";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useBibleStore } from "@renderer/stores/bible.store";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useStageStore } from "@renderer/stores/stage.store";
import { survivingAssetId } from "@renderer/stores/program.store";
import { assetThumbUrl, assetThumbVersion } from "@shared/urls";
import { resolveStageLayout, STAGE_SONG_THEME, stageLyricRows } from "@shared/stage";
import type { ResolvedSong } from "@shared/types/song";
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
/** Chromium rounds a face's ascent and descent to whole pixels, so a line is not the same share of the width at every
 *  size: measured at `fitSongSize`'s 1000 px, a chorded slide drawn small (the next row) came out 2.5 % taller than
 *  measured and lost its last line (2026-11-26). The rows are measured this much shorter than they are drawn. */
const ROUNDING_HEADROOM = 1.06;

export function startStageSync(): () => void {
  let lastInputs: readonly unknown[] = [];
  let queued = false;
  /** The live video's thumbnail, fetched once per video. A control page that starts again over a video
   *  (`effects/live-copy.ts`) takes it from what the stage was last sent: fetched anew, the stage went black for a
   *  moment (2026-11-15 audit, A30 review). */
  let poster: { assetId: number; url: string | null } | null = null;
  const { base } = useProjectionStore.getState();
  const still = useStageStore.getState().output?.videoStill;
  if (base?.kind === "video" && still?.posterUrl && still.videoUrl === base.url) poster = { assetId: base.assetId, url: still.posterUrl };

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
    const bounds = useDisplayStore.getState().displays.find((d) => d.id === settings["stage.displayId"])?.bounds;
    const screenAspect = bounds && bounds.height > 0 ? bounds.width / bounds.height : 16 / 9;
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
      screenAspect,
    ];
    if (inputs.length === lastInputs.length && inputs.every((value, i) => Object.is(value, lastInputs[i]))) return;
    // A live song the musicians read is drawn at one size per row, measured before it goes up: the first time a song
    // is live the stage keeps its picture a frame or two longer, and never shows words that do not fit.
    const { base } = projection;
    const reads = !settings["stage.mirror"] && resolveStageLayout(settings["stage.layout"], true) === "musicians";
    const rows = stageLyricRows(screenAspect, TEXT_SCALE[settings["stage.textSize"]]);
    const live = base?.kind === "song" && reads && !unmeasurable.has(base.song) ? base.song : null;
    const songSizes = live ? measured(live, rows, settings["stage.chords"]) : null;
    if (live && !songSizes) return;
    lastInputs = inputs;
    const lyrics: StageLyricsFit = { screenAspect, songSizes };
    const output = stageOutputFor(
      projection,
      { verses, currentVerseIndex },
      posterUrl,
      {
        countdown,
        message: message && { text: message.text, urgent: message.urgent, seq: message.seq },
        settings,
        lyrics,
      },
    );
    // The stage panel's monitor draws what the stage was sent, not a second build of it.
    useStageStore.setState({ output });
    void api.stage.show(output);
  };
  const unmeasurable = new WeakSet<ResolvedSong>();
  /** The song's size for each row when known; otherwise it starts measuring it and pushes again once it is. */
  const measured = (live: ResolvedSong, rows: { current: number; next: number }, chords: boolean) => {
    const song = stageSong(live);
    const [currentAspect, nextAspect] = [rows.current * ROUNDING_HEADROOM, rows.next * ROUNDING_HEADROOM];
    const current = knownSongFit(song, STAGE_SONG_THEME, currentAspect, chords);
    const next = knownSongFit(song, STAGE_SONG_THEME, nextAspect, chords);
    if (current && next) return { current: current.sizeCqw, next: next.sizeCqw };
    const fit = (aspect: number) => fitSongSize(song, STAGE_SONG_THEME, aspect, chords);
    void Promise.all([fit(currentAspect), fit(nextAspect)])
      // A song that cannot be measured goes up at the floor size rather than the stage keeping an old picture
      // through the whole song.
      .catch(() => void unmeasurable.add(live))
      .finally(schedule);
    return null;
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(push);
  };

  // Whether the stage window is on its screen: the panel's dot, which says it until it is back, and a toast when a
  // screen coming or going is the reason (a cable, a monitor turned off).
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
    useDisplayStore.subscribe(schedule),
    stopStageScreen,
  ];
  schedule();
  return () => unsubscribe.forEach((off) => off());
}
