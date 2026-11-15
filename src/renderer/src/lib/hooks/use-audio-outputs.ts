import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { useSettingsStore } from "@renderer/stores/settings.store";
import type { AudioBus, AudioOutputChoice } from "@shared/types/audio";

export type AudioOutputDevice = { deviceId: string; label: string; groupId: string };

/** This computer's audio outputs as Chromium lists them, and which physical device the system's default is. */
export type AudioOutputs = { devices: AudioOutputDevice[]; defaultGroupId: string | null };

/** Chromium's pseudo-entries: they name another device of the list, never one of their own. */
const PSEUDO_IDS = new Set(["default", "communications"]);

export function audioOutputsOf(list: readonly MediaDeviceInfo[]): AudioOutputs {
  const outputs = list.filter((device) => device.kind === "audiooutput");
  return {
    devices: outputs
      .filter((device) => !PSEUDO_IDS.has(device.deviceId) && device.label !== "")
      .map(({ deviceId, label, groupId }) => ({ deviceId, label, groupId })),
    defaultGroupId: outputs.find((device) => device.deviceId === "default")?.groupId ?? null,
  };
}

/** The chosen device in the list: by its name (what the media engine can match too), its id breaking a tie. */
export function findAudioOutput(choice: AudioOutputChoice, devices: readonly AudioOutputDevice[]): AudioOutputDevice | null {
  const named = devices.filter((device) => device.label === choice.label);
  return named.find((device) => device.deviceId === choice.deviceId) ?? named[0] ?? null;
}

/** Where a bus actually plays: a device of the list, or the system's default (no choice, or a choice that is not
 *  plugged in: Chromium and the engine both fall back to the default). */
function resolveOutput(choice: AudioOutputChoice | null, devices: readonly AudioOutputDevice[]): AudioOutputDevice | null {
  return choice === null ? null : findAudioOutput(choice, devices);
}

/** Whether the two buses end up in the same device (D6: PREVIEW is then heard in the room, and in the NDI®). Each is
 *  resolved to where it really plays first, then compared by `deviceId`: two outputs of one interface («Out 1-2»,
 *  «Out 3-4») share a `groupId` and are different. The `groupId` only tells which physical device the system's
 *  default is, when the other bus names a device. */
export function sameAudioOutput(
  live: AudioOutputChoice | null,
  preview: AudioOutputChoice | null,
  outputs: AudioOutputs,
): boolean {
  const a = resolveOutput(live, outputs.devices);
  const b = resolveOutput(preview, outputs.devices);
  if (a === null && b === null) return true;
  if (a !== null && b !== null) return a.deviceId === b.deviceId;
  const device = a ?? b;
  return device !== null && outputs.defaultGroupId !== null && device.groupId === outputs.defaultGroupId;
}

/** The outputs, read again whenever one is plugged in or out. Empty until Chromium answers, and where it has no
 *  `mediaDevices` at all. */
export function useAudioOutputs(): AudioOutputs {
  const [outputs, setOutputs] = useState<AudioOutputs>({ devices: [], defaultGroupId: null });
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
