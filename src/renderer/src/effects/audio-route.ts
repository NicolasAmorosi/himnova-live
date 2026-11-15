import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { t } from "@renderer/lib/i18n/i18n-provider";
import { toast } from "@renderer/lib/toast";
import {
  audioOutputsOf,
  findAudioOutput,
  resolveBus,
  sameAudioOutput,
  type AudioBusRoute,
  type AudioBusState,
  type AudioOutputDevice,
  type EngineNames,
} from "@renderer/lib/hooks/use-audio-outputs";
import { useAudioRouteStore } from "@renderer/stores/audio-route.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { AudioBus, AudioOutputChoice } from "@shared/types/audio";

const OUTPUT_KEY = { live: "audio.output.live", preview: "audio.output.preview" } as const;
/** How soon an engine that has not named the outputs yet is asked again (main already waited for it ~6 s). */
const PENDING_RETRY_MS = 2000;

/** What a bus last settled on, never `pending`: the state a toast compares with, and the choice it had. */
type Settled = { state: AudioBusState; choice: AudioOutputChoice | null };

/** A bus that just stopped (or started again) playing through its chosen output, said once (D3: never a sound the
 *  operator cannot place). A choice the operator just changed is not «back»: he is looking at it. Waiting for the
 *  engine's answer is not a change: the strip says it, and what comes after is compared with what came before. */
function announce(bus: AudioBus, before: Settled | null, now: AudioBusRoute, choice: AudioOutputChoice | null): void {
  const was = before?.state ?? "ok";
  if (now.state === "pending" || now.state === was || choice === null) return;
  const params = { output: t(bus === "live" ? "audio.liveOutput" : "audio.previewOutput"), name: choice.label };
  if (now.state === "missing") toast.warning(t("audio.toastMissing", params));
  else if (now.state === "unusable") toast.warning(t("audio.toastUnusable", params));
  else if (before?.choice?.label === choice.label) toast.info(t("audio.toastBack", params));
}

/**
 * Where each bus plays (owner, 2026-11-15, plan §2 «Salidas»): the control window decides, from the chosen output
 * (`audio.output.<bus>`), Chromium's devices and the media engine's name for each, and everything else applies it.
 * Both buses' engine outputs go to main in one `audioRoute:set` (its engine sessions and the NDI® capture); LIVE's
 * whole route also goes into `projection.store` (every `ProjectionOutput` carries it: the projector moves its
 * elements), PREVIEW's to this window's own elements (`App`). Resolved again when a device comes or goes and when a
 * choice changes: a chosen device that comes back is used again by itself. Applies with the strips off too (D3).
 *
 * An engine that has not named the outputs yet keeps both buses whole on the default (`pending`) and is asked again
 * until it does. An output one side could not open (an engine session's `audio-out`, a window's `setSinkId`:
 * `audio-sink-failed`) is refused for the session, which sends its bus to the default whole; it is tried again only
 * once it has left Chromium's list and come back.
 */
export function startAudioRouteEffects(): () => void {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (!media) return () => undefined;
  let stopped = false;
  let request = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const settled: Record<AudioBus, Settled | null> = { live: null, preview: null };
  /** Outputs refused for the session, by Chromium label, and whether each has since left the list; and the Chromium
   *  label of each engine name the last answer gave, to find the one an `audio-out` names. */
  const refused = new Map<string, { gone: boolean }>();
  let labelOf = new Map<string, string>();

  const resolve = async (): Promise<void> => {
    const { settings, loaded } = useSettingsStore.getState();
    if (!loaded) return;
    clearTimeout(retry);
    const mine = ++request;
    const next = { live: settings[OUTPUT_KEY.live], preview: settings[OUTPUT_KEY.preview] };
    const outputs = audioOutputsOf(await media.enumerateDevices());
    const labels = new Set(outputs.devices.map((device) => device.label));
    for (const [label, entry] of refused) {
      if (!labels.has(label)) entry.gone = true;
      else if (entry.gone) refused.delete(label);
    }
    const chosen = [...new Set([next.live, next.preview].map((c) => (c ? findAudioOutput(c, outputs.devices) : null)))].filter(
      (d): d is AudioOutputDevice => d !== null,
    );
    const answer = chosen.length ? await api.audioRoute.matchOutputs(chosen.map(({ deviceId, label }) => ({ deviceId, label }))) : [];
    if (stopped || mine !== request) return;
    const engine: EngineNames = Array.isArray(answer)
      ? new Map(chosen.map((device, i) => [device.deviceId, answer[i] ?? null]))
      : answer;
    if (Array.isArray(answer)) {
      labelOf = new Map(chosen.flatMap((device, i) => (answer[i] ? [[answer[i], device.label] as const] : [])));
    }
    const unusable = new Set(refused.keys());
    const live = resolveBus(next.live, outputs.devices, engine, unusable);
    const preview = resolveBus(next.preview, outputs.devices, engine, unusable);
    const shared = sameAudioOutput(live.device, preview.device, outputs.defaultGroupId);

    // Main first and in one message: the projector's copy of LIVE's route leaves on the next microtask, and a route
    // half old, half new would move the NDI® capture twice.
    void api.audioRoute.set({ live: live.out.engineDevice, preview: preview.out.engineDevice, previewApart: !shared });
    useAudioRouteStore.setState({ live, preview, shared });
    useProjectionStore.getState().setLiveAudioOut(live.out);
    for (const [bus, route] of [["live", live], ["preview", preview]] as const) {
      announce(bus, settled[bus], route, next[bus]);
      if (route.state !== "pending") settled[bus] = { state: route.state, choice: next[bus] };
    }
    if (live.state === "pending" || preview.state === "pending") retry = setTimeout(run, PENDING_RETRY_MS);
  };
  const run = () =>
    void resolve().catch((error: unknown) => console.warn("[audio] could not resolve the outputs", error));
  const refuse = (label: string | undefined, why: string) => {
    if (label === undefined || refused.has(label)) return;
    console.warn(`[audio] ${why} ${label}: its bus goes to the default`);
    refused.set(label, { gone: false });
    run();
  };

  run();
  media.addEventListener("devicechange", run);
  const offAudioOut = onIpc("audio-out", ({ device, ok }) => {
    if (!ok) refuse(labelOf.get(device), "the engine could not play through");
  });
  const offSinkFailed = onIpc("audio-sink-failed", ({ sinkId }) => {
    const { live, preview } = useAudioRouteStore.getState();
    const label = [live.device, preview.device].find((device) => device?.deviceId === sinkId)?.label;
    refuse(label, "a window could not play through");
  });
  const unsubscribe = useSettingsStore.subscribe((state, previous) => {
    if (
      state.loaded !== previous.loaded ||
      state.settings[OUTPUT_KEY.live] !== previous.settings[OUTPUT_KEY.live] ||
      state.settings[OUTPUT_KEY.preview] !== previous.settings[OUTPUT_KEY.preview]
    ) {
      run();
    }
  });
  return () => {
    stopped = true;
    clearTimeout(retry);
    media.removeEventListener("devicechange", run);
    offAudioOut();
    offSinkFailed();
    unsubscribe();
  };
}
