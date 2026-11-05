import { useEffect, useRef, useState } from "react";
import { useT, type Translate } from "@renderer/lib/i18n/i18n-provider";
import { Badge, Button, Callout, Caption, FieldRow, Monitor, Select } from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { classifyVideoProbe, type VideoProbeReason, type VideoProbeVerdict } from "@renderer/lib/video-probe";
import { assetUrl } from "@shared/urls";
import type { MediaAsset } from "@shared/types/media";
import type { GpuStatus, VideoDecoderReport } from "@shared/types/system";

/** How long the probe plays once it is actually playing: long enough for a
 *  stutter to show up in the dropped-frame count, short enough to wait for. */
const PROBE_PLAY_MS = 5000;
/** How long it waits for playback to START before measuring anyway — a file
 *  that takes longer than this to show a frame has answered the question. */
const PROBE_START_GRACE_MS = 5000;

const VERDICT_TONE: Record<VideoProbeVerdict, "info" | "warning" | "danger"> = {
  smooth: "info",
  risky: "warning",
  unsuitable: "danger",
};

type ProbeResult = {
  failed: boolean;
  width: number;
  height: number;
  dropped: number;
  total: number;
  decoder: VideoDecoderReport | null;
};

/** Chromium's feature strings: "enabled", "enabled_on", "enabled_readback"…
 *  are on; "disabled_software", "unavailable_off"… are not. */
function isFeatureOn(value: string): boolean {
  return value.startsWith("enabled");
}

/** Resolves once the video has played `PROBE_PLAY_MS`, or failed, or never
 *  started within the grace period — whichever comes first. `signal` settles
 *  it early without a measurement. */
function playFor(video: HTMLVideoElement, signal: AbortSignal): Promise<"done" | "error" | "aborted"> {
  return new Promise((resolve) => {
    let timer = setTimeout(() => finish("done"), PROBE_START_GRACE_MS);
    const onPlaying = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish("done"), PROBE_PLAY_MS);
    };
    const onError = () => finish("error");
    const onAbort = () => finish("aborted");
    function finish(outcome: "done" | "error" | "aborted") {
      clearTimeout(timer);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    }
    video.addEventListener("playing", onPlaying, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function reasonText(t: Translate, reason: VideoProbeReason): string {
  switch (reason.kind) {
    case "noFrames":
      return t("settings.probeReasons.noFrames");
    case "cpuDecode":
      return t("settings.probeReasons.cpuDecode", { height: String(reason.height) });
    case "dropped":
      return t("settings.probeReasons.dropped", { percent: String(reason.percent) });
    case "decoderUnknown":
      return t("settings.probeReasons.decoderUnknown");
  }
}

/**
 * The rows under «Performance» that describe the machine rather than set a
 * preference: which GPU draws the app, whether Chromium is decoding video on
 * it, the two `chrome://` pages that say more, and «Test video».
 *
 * The probe plays in the CONTROL window, visibly and muted. Visibly because an
 * element nobody can see is not decoded like one that is; in this window
 * because it is the one the operator is sitting at — the projector is never
 * touched. Both windows share one GPU process, so whether a file decodes in
 * hardware here is whether it does there.
 */
export function PerformanceDiagnostics() {
  const t = useT();
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
  const [videos, setVideos] = useState<MediaAsset[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [probeSrc, setProbeSrc] = useState<string | null>(null);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let alive = true;
    void api.system
      .gpuStatus()
      .then((status) => {
        if (alive) setGpu(status);
      })
      .catch(() => undefined);
    void api.library
      .list("video")
      .then((list) => {
        if (alive) setVideos(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Runs one probe per `probeSrc`. Aborting (unmount, or StrictMode's
  // rehearsal of one) settles the wait without measuring and without ending
  // the CDP session: whichever run is real still owns it.
  useEffect(() => {
    const video = videoRef.current;
    if (!probeSrc || !video) return;
    const controller = new AbortController();
    void playFor(video, controller.signal).then(async (outcome) => {
      if (outcome === "aborted") return;
      const quality = video.getVideoPlaybackQuality();
      const measured = {
        failed: outcome === "error",
        width: video.videoWidth,
        height: video.videoHeight,
        dropped: quality.droppedVideoFrames,
        total: quality.totalVideoFrames,
      };
      video.pause();
      const decoder = await api.system.probeEnd(video.currentSrc || probeSrc).catch(() => null);
      if (controller.signal.aborted) return;
      setResult({ ...measured, decoder });
      setProbeSrc(null);
    });
    return () => controller.abort();
  }, [probeSrc]);

  // Leaving Settings mid-probe must not leave the CDP session attached.
  const probingRef = useRef(false);
  probingRef.current = probeSrc !== null;
  useEffect(
    () => () => {
      if (probingRef.current) void api.system.probeEnd("").catch(() => undefined);
    },
    [],
  );

  async function startProbe() {
    if (selectedId === null) return;
    setResult(null);
    // `false` is not a failure: the verdict then rests on frames alone.
    await api.system.probeBegin().catch(() => false);
    // A unique url, so the pipeline's `kLoad` for THIS element can be told
    // apart from the LIVE monitor playing the same file. The query is ignored
    // by `worship://asset/<id>`.
    setProbeSrc(`${assetUrl(selectedId)}?probe=${Date.now()}`);
  }

  const running = probeSrc !== null;
  const activeDevices = gpu?.devices.filter((device) => device.active) ?? [];
  const deviceLabel =
    gpu === null || gpu.devices.length === 0
      ? t("settings.gpuUnknown")
      : [
          ...activeDevices.map((device) => device.name),
          ...gpu.devices
            .filter((device) => !device.active)
            .map((device) => t("settings.gpuInactive", { name: device.name })),
        ].join(" · ");

  const classified = result
    ? classifyVideoProbe({
        hardware: result.decoder?.hardware ?? null,
        dropped: result.dropped,
        total: result.total,
        height: result.height,
      })
    : null;

  return (
    <>
      <FieldRow description={t("settings.gpuDesc")} label={t("settings.gpu")}>
        <Caption>{deviceLabel}</Caption>
      </FieldRow>

      {gpu ? (
        <FieldRow label={t("settings.videoDecode")}>
          <Badge title={gpu.videoDecode} variant={isFeatureOn(gpu.videoDecode) ? "success" : "danger"}>
            {isFeatureOn(gpu.videoDecode) ? t("settings.featureOn") : t("settings.featureOff")}
          </Badge>
        </FieldRow>
      ) : null}

      {gpu ? (
        <FieldRow label={t("settings.gpuCompositing")}>
          <Badge title={gpu.gpuCompositing} variant={isFeatureOn(gpu.gpuCompositing) ? "success" : "danger"}>
            {isFeatureOn(gpu.gpuCompositing) ? t("settings.featureOn") : t("settings.featureOff")}
          </Badge>
        </FieldRow>
      ) : null}

      <FieldRow description={t("settings.internalsDesc")} label={t("settings.internals")}>
        <Button onClick={() => void api.system.openInternals("gpu")} variant="outline">
          {t("settings.internalsGpu")}
        </Button>
        <Button onClick={() => void api.system.openInternals("media-internals")} variant="outline">
          {t("settings.internalsMedia")}
        </Button>
      </FieldRow>

      <FieldRow description={t("settings.probeDesc")} label={t("settings.probe")}>
        <Select
          className="min-w-48"
          disabled={running || videos.length === 0}
          onChange={(value) => setSelectedId(Number(value))}
          options={videos.map((video) => ({ label: video.name, value: String(video.id) }))}
          placeholder={videos.length === 0 ? t("settings.probeNoVideos") : t("settings.probeChoose")}
          value={selectedId === null ? "" : String(selectedId)}
        />
        <Button disabled={running || selectedId === null} onClick={() => void startProbe()} variant="outline">
          {running ? t("settings.probeRunning") : t("settings.probeRun")}
        </Button>
      </FieldRow>

      {running || result ? (
        <div className="flex items-start gap-4 px-4 py-3">
          {running ? (
            <Monitor className="w-64 shrink-0 p-0">
              <video
                autoPlay
                className="size-full object-contain"
                muted
                playsInline
                preload="auto"
                ref={videoRef}
                src={probeSrc}
              />
            </Monitor>
          ) : null}
          {result && classified ? (
            <Callout className="flex-1" tone={result.failed ? "danger" : VERDICT_TONE[classified.verdict]}>
              <p>{result.failed ? t("settings.probeFailed") : t(`settings.probeVerdicts.${classified.verdict}`)}</p>
              {result.failed
                ? null
                : classified.reasons.map((reason) => <p key={reason.kind}>{reasonText(t, reason)}</p>)}
              <Caption>
                {t("settings.probeDetails", {
                  width: String(result.width),
                  height: String(result.height),
                  // Chromium's profile already names its codec ("h264 high").
                  codec: result.decoder?.profile ?? result.decoder?.codec ?? "?",
                  decoder: result.decoder?.decoderName
                    ? `${result.decoder.decoderName} (${
                        result.decoder.hardware ? t("settings.probeHardware") : t("settings.probeSoftware")
                      })`
                    : t("settings.probeUnknown"),
                  mbps: result.decoder?.bitrate ? (result.decoder.bitrate / 1_000_000).toFixed(1) : "?",
                })}
              </Caption>
            </Callout>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
