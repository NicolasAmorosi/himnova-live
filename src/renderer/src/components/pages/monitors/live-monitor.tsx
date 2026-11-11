import { useMemo } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Monitor } from "@renderer/components/ui";
import { OutputView } from "@renderer/components/shared/output-view";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { mediaTargetKey } from "@shared/types/projection";
import { useLiveVideoPoster } from "@renderer/lib/hooks/use-live-video-poster";

const VIDEO_TARGET_KEY = mediaTargetKey({ kind: "video" });
const SLIDE_VIDEO_TARGET_KEY = mediaTargetKey({ kind: "slideVideo" });

/** What the congregation is seeing, rendered by the same component the
 *  projection window uses — so the monitor can't lie. Its status text (BLACK,
 *  LOGO, slide counter…) lives in the column header, not here — see
 *  `useLiveStatus` in `MonitorsColumn.tsx`. The deck transport used to render
 *  as this monitor's footer; it's a sibling row in `MonitorsColumn` now so a
 *  deck's controls can never shrink the stage itself — see `Monitor`.
 *
 * A live video actually plays here too, not just a frozen frame — it's a
 * second, independently decoding `<video>` (this window's own process can't
 * share the projector's decoder), kept in sync via `liveVideoStatus`, the
 * same `mediaStatus` report the media transport bar already reads. See
 * `OutputView`'s `LiveVideo` for the drift correction itself.
 *
 * Unless `monitors.liveVideoMotion` is off: then no copy is decoded here at
 * all, and the stage shows the video's thumbnail under a notice saying why. */
export function LiveMonitor() {
  const t = useT();
  // selectOutputMemo keeps object identity stable across unrelated store
  // updates, so the default comparator is enough here — without it,
  // useSyncExternalStore sees a "new" snapshot every render and loops
  // ("Maximum update depth exceeded").
  const output = useProjectionStore(selectOutputMemo);
  const presentationOpen = useProjectionStore((s) => s.presentationOpen);
  const liveVideoStatus = useProjectionStore((s) => s.mediaStatus[VIDEO_TARGET_KEY] ?? null);
  // The same job for a video embedded in the live slide, which decodes here as
  // its own second copy exactly like the full-screen one does.
  const slideVideoStatus = useProjectionStore((s) => s.mediaStatus[SLIDE_VIDEO_TARGET_KEY] ?? null);
  // The record, not a derived array: a selector returning a fresh array on
  // every call makes `useSyncExternalStore` see a new snapshot each render and
  // loop. `mediaErrors` only changes when the projector actually reports
  // something, so the memo below runs approximately never.
  const mediaErrors = useProjectionStore((s) => s.mediaErrors);
  const reportedErrorUrls = useMemo(
    () => Object.values(mediaErrors).map((error) => error.url),
    [mediaErrors],
  );
  // LOGO with nothing to show. The projector is black and correct — the logo
  // is simply not configured yet — so this is a notice and not an error, and
  // it names the way out instead of the symptom. Only once the operator ASKED
  // for the logo (2026-11-04 redesign, P5): resting on the logo with nothing
  // live is how every launch starts, and a band there was an alarm before the
  // operator had done anything.
  //
  // Gated on `loaded` because `logoUrl` is mirrored from the settings
  // (`App.tsx`) and starts null: without it, every launch would flash "No logo
  // set" for as long as the first `settings:get` takes, on a machine that
  // has one.
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const overlay = useProjectionStore((s) => s.overlay);
  const base = useProjectionStore((s) => s.base);
  // A logo scene with a name or a background of its own is something to show
  // (2026-11-05); only a bare black one is "no logo".
  const logoMissing =
    settingsLoaded &&
    overlay === "logo" &&
    output.kind === "logo" &&
    output.url === null &&
    output.scene.name === null &&
    output.scene.background.kind === "solid" &&
    output.scene.background.color === "#000000";

  // The monitor's own copy of the live video, or a still of it (`useLiveVideoPoster`,
  // fetched only with the setting off). Local to this
  // monitor on purpose: `selectOutput` is what the projector reads.
  const videoMotion = useSettingsStore((s) => s.settings["monitors.liveVideoMotion"]);
  const liveVideoAssetId = useProjectionStore((s) => (s.base?.kind === "video" ? s.base.assetId : null));
  const liveVideoUrl = useProjectionStore((s) => (s.base?.kind === "video" ? s.base.url : null));
  const posterUrl = useLiveVideoPoster(videoMotion ? null : liveVideoAssetId);
  const videoStill = videoMotion
    ? undefined
    : {
        posterUrl,
        videoUrl: liveVideoUrl,
      };
  // Only while the stage is actually showing the still: under BLACK/LOGO the
  // stage is what it says it is.
  const stillNotice =
    videoStill !== undefined && (output.kind === "video" || output.slideVideo !== null);

  return (
    <Monitor
      className="p-0"
      empty={presentationOpen ? t("live.noSignal") : t("live.disconnected")}
      onAir={presentationOpen && overlay === "none" && base !== null}
    >
      {/* `black` and a logo-less LOGO both render as an empty stage, which is
          exactly right — that IS what the projector is showing. The two cases
          where an empty stage would not be the whole truth get a band over it
          instead: a file that failed to load (`errorLabel`/
          `reportedErrorUrls`) and a LOGO with no logo to show
          (`noticeLabel`). */}
      <OutputView
        // A slide or a picture is shown, not played: said as what it is (2026-11-10 review, agent5-08).
        errorLabel={output.kind === "slide" || output.kind === "image" ? t("media.showError") : t("media.loadError")}
        liveVideoStatus={liveVideoStatus}
        mode="monitor"
        noticeDetail={
          logoMissing ? t("live.logoMissingHint") : stillNotice ? t("live.videoMotionOffHint") : undefined
        }
        noticeLabel={logoMissing ? t("live.logoMissing") : stillNotice ? t("live.videoMotionOff") : undefined}
        output={output}
        reportedErrorUrls={reportedErrorUrls}
        slideVideoStatus={slideVideoStatus}
        videoStill={videoStill}
      />
    </Monitor>
  );
}
