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
  type AudioOutputDevice,
} from "@renderer/lib/hooks/use-audio-outputs";
import { useAudioRouteStore } from "@renderer/stores/audio-route.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { AudioBus, AudioOutputChoice } from "@shared/types/audio";

const OUTPUT_KEY = { live: "audio.output.live", preview: "audio.output.preview" } as const;

/** A bus that just stopped (or started again) playing through its chosen output, said once (D3: never a sound the
 *  operator cannot place). A choice the operator just changed is not «back»: he is looking at it. */
function announce(
  bus: AudioBus,
  before: AudioBusRoute | null,
  beforeChoice: AudioOutputChoice | null,
  now: AudioBusRoute,
  choice: AudioOutputChoice | null,
): void {
  const was = before?.state ?? "ok";
  if (now.state === was || choice === null) return;
  const params = { output: t(bus === "live" ? "audio.liveOutput" : "audio.previewOutput"), name: choice.label };
  if (now.state === "missing") toast.warning(t("audio.toastMissing", params));
  else if (now.state === "unusable") toast.warning(t("audio.toastUnusable", params));
  else if (beforeChoice?.label === choice.label) toast.info(t("audio.toastBack", params));
}

/**
 * Where each bus plays (owner, 2026-11-15, plan §2 «Salidas»): the control window decides, from the chosen output
 * (`audio.output.<bus>`), Chromium's devices and the media engine's name for each, and everything else applies it.
 * LIVE's route goes into `projection.store` (so every `ProjectionOutput` carries it: the projector moves its elements,
 * main its engine sessions and the NDI® capture), PREVIEW's to main (`audioRoute:set`) and to this window's own
 * elements (`App`). Resolved again when a device comes or goes and when a choice changes: a chosen device that comes
 * back is used again by itself. Applies with the strips off too (D3).
 *
 * An output the engine names but cannot open (its session says so: `audio-out`) is refused for the session, which
 * sends its bus to the default whole; it is tried again only once it has left Chromium's list and come back.
 */
export function startAudioRouteEffects(): () => void {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (!media) return () => undefined;
  let stopped = false;
  let request = 0;
  let resolved = false;
  let choices: Record<AudioBus, AudioOutputChoice | null> = { live: null, preview: null };
  /** Engine names an engine could not open, with the Chromium label they were matched to and whether it has since
   *  left the list; and the last resolution's names, to find that label. */
  const refused = new Map<string, { label: string; gone: boolean }>();
  let labelOf = new Map<string, string>();

  const resolve = async (): Promise<void> => {
    const { settings, loaded } = useSettingsStore.getState();
    if (!loaded) return;
    const mine = ++request;
    const next = { live: settings[OUTPUT_KEY.live], preview: settings[OUTPUT_KEY.preview] };
    const outputs = audioOutputsOf(await media.enumerateDevices());
    const labels = new Set(outputs.devices.map((device) => device.label));
    for (const [name, entry] of refused) {
      if (!labels.has(entry.label)) entry.gone = true;
      else if (entry.gone) refused.delete(name);
    }
    const chosen = [...new Set([next.live, next.preview].map((c) => (c ? findAudioOutput(c, outputs.devices) : null)))].filter(
      (d): d is AudioOutputDevice => d !== null,
    );
    const names = chosen.length ? await api.audioRoute.matchOutputs(chosen.map(({ deviceId, label }) => ({ deviceId, label }))) : [];
    if (stopped || mine !== request) return;
    const engineNames =
      names && new Map(chosen.map((device, i) => [device.deviceId, refused.has(names[i] ?? "") ? null : (names[i] ?? null)]));
    if (names) labelOf = new Map(chosen.flatMap((device, i) => (names[i] ? [[names[i], device.label] as const] : [])));
    const live = resolveBus(next.live, outputs.devices, engineNames);
    const preview = resolveBus(next.preview, outputs.devices, engineNames);
    const shared = sameAudioOutput(live.device, preview.device, outputs.defaultGroupId);

    const before = resolved ? useAudioRouteStore.getState() : null;
    useAudioRouteStore.setState({ live, preview, shared });
    useProjectionStore.getState().setLiveAudioOut(live.out);
    void api.audioRoute.set({ preview: preview.out.engineDevice, previewApart: !shared });
    announce("live", before?.live ?? null, choices.live, live, next.live);
    announce("preview", before?.preview ?? null, choices.preview, preview, next.preview);
    choices = next;
    resolved = true;
  };
  const run = () =>
    void resolve().catch((error: unknown) => console.warn("[audio] could not resolve the outputs", error));

  run();
  media.addEventListener("devicechange", run);
  const offAudioOut = onIpc("audio-out", ({ device, ok }) => {
    const label = labelOf.get(device);
    if (ok || label === undefined || refused.has(device)) return;
    console.warn(`[audio] the engine could not play through ${device}: its bus goes to the default`);
    refused.set(device, { label, gone: false });
    run();
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
    media.removeEventListener("devicechange", run);
    offAudioOut();
    unsubscribe();
  };
}
