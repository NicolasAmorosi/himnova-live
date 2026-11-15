import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { DEFAULT_AUDIO_OUT, type AudioBus, type AudioOut, type AudioOutputChoice } from "@shared/types/audio";

export type AudioOutputDevice = { deviceId: string; label: string; groupId: string };

/** This computer's audio outputs as Chromium lists them, and which one the system's default is: its entry
 *  (`defaultDeviceId`) or, when it cannot be told, its physical device (`defaultGroupId`). */
export type AudioOutputs = { devices: AudioOutputDevice[]; defaultDeviceId: string | null; defaultGroupId: string | null };

/** Chromium's pseudo-entries: they name another device of the list, never one of their own. */
const PSEUDO_IDS = new Set(["default", "communications"]);

export function audioOutputsOf(list: readonly MediaDeviceInfo[]): AudioOutputs {
  const outputs = list.filter((device) => device.kind === "audiooutput");
  const devices = outputs
    .filter((device) => !PSEUDO_IDS.has(device.deviceId) && device.label !== "")
    .map(({ deviceId, label, groupId }) => ({ deviceId, label, groupId }));
  const fallback = outputs.find((device) => device.deviceId === "default");
  // Labelled «Default - <the real entry's label>» (Electron 44 on a Mac, 2026-11-15): that entry, the longest label
  // when two end alike. Its `groupId` alone takes «Out 1-2» and «Out 3-4» of one interface for the same output.
  const real = devices
    .filter((device) => fallback?.label.endsWith(` - ${device.label}`))
    .sort((a, b) => b.label.length - a.label.length)[0];
  return { devices, defaultDeviceId: real?.deviceId ?? null, defaultGroupId: fallback?.groupId ?? null };
}

/** The chosen device in the list: by its name (what the media engine can match too), its id breaking a tie. */
export function findAudioOutput(choice: AudioOutputChoice, devices: readonly AudioOutputDevice[]): AudioOutputDevice | null {
  const named = devices.filter((device) => device.label === choice.label);
  return named.find((device) => device.deviceId === choice.deviceId) ?? named[0] ?? null;
}

/** Why a chosen output is not used, and the bus plays through the system's default instead: not plugged in; plugged
 *  in but the media engine has no single device of that name, or one side could not open it (`unusable`); or the
 *  engine has not said its name for it yet (`pending`, asked again until it does). */
export type AudioBusState = "ok" | "missing" | "unusable" | "pending";

/** Where a bus really plays (`effects/audio-route.ts`): `device` is the chosen one when it is used, null for the
 *  system's default. */
export type AudioBusRoute = { out: AudioOut; state: AudioBusState; device: AudioOutputDevice | null };

export const DEFAULT_ROUTE: AudioBusRoute = { out: DEFAULT_AUDIO_OUT, state: "ok", device: null };

/** The media engine's name for each chosen output, by Chromium `deviceId` («auto» for the default; null when it has
 *  none or more than one), or its answer when it has none to give (`EngineOutputNames`). */
export type EngineNames = ReadonlyMap<string, string | null> | "none" | "pending";

/**
 * A bus's route from its choice, Chromium's devices and the media engine's name for each of them. `engine` "none":
 * this build's engine cannot choose an output (none, or older than engine-8), so only Chromium moves; "pending": it has
 * not answered, so nothing moves yet. A chosen output the two sides cannot both use, or one of them could not open
 * (`refused`, by label), sends the whole bus to the default: one bus is never split across two devices.
 */
export function resolveBus(
  choice: AudioOutputChoice | null,
  devices: readonly AudioOutputDevice[],
  engine: EngineNames,
  refused: ReadonlySet<string> = new Set(),
): AudioBusRoute {
  if (choice === null) return DEFAULT_ROUTE;
  const device = findAudioOutput(choice, devices);
  if (device === null) return { ...DEFAULT_ROUTE, state: "missing" };
  if (refused.has(device.label)) return { ...DEFAULT_ROUTE, state: "unusable" };
  if (engine === "pending") return { ...DEFAULT_ROUTE, state: "pending" };
  if (engine === "none") return { out: { sinkId: device.deviceId, engineDevice: null }, state: "ok", device };
  const name = engine.get(device.deviceId) ?? null;
  if (name === null) return { ...DEFAULT_ROUTE, state: "unusable" };
  return { out: { sinkId: device.deviceId, engineDevice: name === "auto" ? null : name }, state: "ok", device };
}

/** Whether two buses play through the same device (D6: PREVIEW is then heard in the room, and in the NDI®), each
 *  where it really plays (`AudioBusRoute.device`, null the default). Two outputs of one interface («Out 1-2», «Out
 *  3-4») share a `groupId` and are different: the default is compared by its entry, by `groupId` only when its entry
 *  could not be told. */
export function sameAudioOutput(
  a: AudioOutputDevice | null,
  b: AudioOutputDevice | null,
  { defaultDeviceId, defaultGroupId }: Pick<AudioOutputs, "defaultDeviceId" | "defaultGroupId">,
): boolean {
  if (a !== null && b !== null) return a.deviceId === b.deviceId;
  const device = a ?? b;
  if (device === null) return true;
  if (defaultDeviceId !== null) return device.deviceId === defaultDeviceId;
  return defaultGroupId !== null && device.groupId === defaultGroupId;
}

/** The outputs, read again whenever one is plugged in or out. Empty until Chromium answers, and where it has no
 *  `mediaDevices` at all. */
export function useAudioOutputs(): AudioOutputs {
  const [outputs, setOutputs] = useState<AudioOutputs>({ devices: [], defaultDeviceId: null, defaultGroupId: null });
  useEffect(() => {
    const media = navigator.mediaDevices as MediaDevices | undefined;
    if (!media) return;
    let current = true;
    // A slower, older answer must not overwrite a newer one (two plug events in a row).
    let latest = 0;
    const read = () => {
      const request = ++latest;
      media.enumerateDevices().then(
        (list) => {
          if (current && request === latest) setOutputs(audioOutputsOf(list));
        },
        (error: unknown) => console.warn("[audio] could not list the outputs", error),
      );
    };
    read();
    media.addEventListener("devicechange", read);
    return () => {
      current = false;
      media.removeEventListener("devicechange", read);
    };
  }, []);
  return outputs;
}

const SYSTEM_DEFAULT = "";
/** The chosen device while it is not plugged in: still listed, so the operator sees what was chosen. */
const UNPLUGGED = "unplugged";

/** One bus's output picker, the same choices for the strip's menu and Settings ▸ Sound: the system's default, then
 *  every output; picking one writes `audio.output.<bus>` (the routing reads it from there). */
export function useAudioOutputPicker(bus: AudioBus, outputs: AudioOutputs) {
  const t = useT();
  const choice = useSettingsStore((s) => s.settings[bus === "live" ? "audio.output.live" : "audio.output.preview"]);
  const update = useSettingsStore((s) => s.update);
  const chosen = choice ? findAudioOutput(choice, outputs.devices) : null;
  const systemLabel = t("audio.systemDefault");

  const options = [
    { label: systemLabel, value: SYSTEM_DEFAULT },
    ...outputs.devices.map((device) => ({ label: device.label, value: device.deviceId })),
    ...(choice && !chosen ? [{ label: t("audio.unplugged", { name: choice.label }), value: UNPLUGGED }] : []),
  ];

  const choose = (value: string) => {
    if (value === UNPLUGGED) return;
    const device = outputs.devices.find((candidate) => candidate.deviceId === value);
    const next = device ? { label: device.label, deviceId: device.deviceId } : null;
    void (bus === "live" ? update({ "audio.output.live": next }) : update({ "audio.output.preview": next }));
  };

  return {
    choose,
    /** What the bus sounds through, said in words. */
    name: choice === null ? systemLabel : choice.label,
    options,
    value: choice === null ? SYSTEM_DEFAULT : (chosen?.deviceId ?? UNPLUGGED),
  };
}
