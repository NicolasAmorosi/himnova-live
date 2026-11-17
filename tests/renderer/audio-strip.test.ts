/** The audio strips' pure parts: the meter's ballistics, where each bus really plays (`resolveBus`) and whether the two
 *  end up in the same device (D6). */
import { expect, test } from "vitest";
import { faderToGain, formatDb, gainToFader } from "@renderer/components/ui/fader";
import { SILENT_CHANNEL, isLit, stepMeterChannel } from "@renderer/components/ui/level-meter";
import {
  audioOutputsOf,
  findAudioOutput,
  resolveBus,
  sameAudioOutput,
  type AudioOutputs,
  type EngineNames,
} from "@renderer/lib/hooks/use-audio-outputs";
import type { AudioOutputChoice } from "@shared/types/audio";

test("a meter rises at once, falls back slowly, holds its peak, and stops at the floor", () => {
  let channel = stepMeterChannel(SILENT_CHANNEL, -12, 1000, 16);
  expect(channel).toEqual({ shown: -12, peak: -12, peakAt: 1000 });
  // Silence: half a second later the bar has fallen 12 dB, the peak still holds.
  channel = stepMeterChannel(channel, -Infinity, 1500, 500);
  expect(channel.shown).toBeCloseTo(-24, 6);
  expect(channel.peak).toBe(-12);
  // Past the hold the peak falls too, never under the bar.
  channel = stepMeterChannel(channel, -Infinity, 3000, 1500);
  expect(channel.shown).toBe(-60);
  expect(channel.peak).toBeCloseTo(-42, 6);
  channel = stepMeterChannel(channel, -Infinity, 6000, 3000);
  // Fails if the meter keeps animating forever in silence.
  expect(isLit(channel)).toBe(false);
});

const device = (deviceId: string, label: string, groupId: string) =>
  ({ deviceId, label, groupId, kind: "audiooutput", toJSON: () => ({}) }) as MediaDeviceInfo;
const outputs = audioOutputsOf([
  device("default", "Predeterminado - Altavoces", "g-speakers"),
  device("communications", "Comunicaciones - Altavoces", "g-speakers"),
  device("a1", "Altavoces", "g-speakers"),
  device("b2", "Scarlett 2i2", "g-scarlett"),
  { ...device("c3", "Auriculares", "g-phones"), kind: "audioinput" },
]);

test("Chromium's pseudo-outputs are not listed; the system's default is known by its device", () => {
  expect(outputs.devices.map((d) => d.label)).toEqual(["Altavoces", "Scarlett 2i2"]);
  expect(outputs.defaultDeviceId).toBe("a1");
  // By NAME, what the media engine can match too; a stale id still finds it.
  expect(findAudioOutput({ label: "Scarlett 2i2", deviceId: "old" }, outputs.devices)?.deviceId).toBe("b2");
});

/** D6, as `effects/audio-route.ts` decides it: each bus resolved to where it really plays, then compared. */
function sameAudioOutputOf(
  live: AudioOutputChoice | null,
  preview: AudioOutputChoice | null,
  list: AudioOutputs,
  engineNames: EngineNames = "none",
): boolean {
  const a = resolveBus(live, list.devices, engineNames);
  const b = resolveBus(preview, list.devices, engineNames);
  return sameAudioOutput(a.device, b.device, list);
}

test("PREVIEW shares LIVE's output when both end up in the same device (D6)", () => {
  const scarlett = { label: "Scarlett 2i2", deviceId: "b2" };
  const speakers = { label: "Altavoces", deviceId: "a1" };
  expect(sameAudioOutputOf(null, null, outputs)).toBe(true);
  // The default IS the speakers today, whichever side names them.
  expect(sameAudioOutputOf(null, speakers, outputs)).toBe(true);
  expect(sameAudioOutputOf(speakers, null, outputs)).toBe(true);
  expect(sameAudioOutputOf(scarlett, null, outputs)).toBe(false);
  expect(sameAudioOutputOf(scarlett, speakers, outputs)).toBe(false);
  expect(sameAudioOutputOf(speakers, speakers, outputs)).toBe(true);
});

test("a choice that is not plugged in plays through the system's default, so that is what is compared", () => {
  const gone = { label: "USB Headset", deviceId: "z9" };
  const other = { label: "Other Dongle", deviceId: "z8" };
  const speakers = { label: "Altavoces", deviceId: "a1" };
  const scarlett = { label: "Scarlett 2i2", deviceId: "b2" };
  // Unplugged LIVE + default PREVIEW: both end in the default, so shared (a name match alone said no).
  expect(sameAudioOutputOf(gone, null, outputs)).toBe(true);
  // Both unplugged, even different ones: both fall back to the default.
  expect(sameAudioOutputOf(gone, other, outputs)).toBe(true);
  // Unplugged beside the device the default is: shared; beside another device: not.
  expect(sameAudioOutputOf(gone, speakers, outputs)).toBe(true);
  expect(sameAudioOutputOf(gone, scarlett, outputs)).toBe(false);
});

test("two outputs of one interface are different devices, whatever their group says", () => {
  const interfaceOutputs = audioOutputsOf([
    device("default", "Predeterminado - Out 1-2", "g-iface"),
    device("o12", "Out 1-2", "g-iface"),
    device("o34", "Out 3-4", "g-iface"),
  ]);
  const out12 = { label: "Out 1-2", deviceId: "o12" };
  const out34 = { label: "Out 3-4", deviceId: "o34" };
  expect(sameAudioOutputOf(out12, out34, interfaceOutputs)).toBe(false);
  expect(sameAudioOutputOf(out12, out12, interfaceOutputs)).toBe(true);
  // LIVE on the system's default, which is «Out 1-2», and PREVIEW on «Out 3-4»: apart, so the NDI capture leaves
  // PREVIEW out. Fails if the default is told by its group: the same interface, so «shared».
  expect(sameAudioOutputOf(null, out34, interfaceOutputs)).toBe(false);
  expect(sameAudioOutputOf(out34, null, interfaceOutputs)).toBe(false);
  expect(sameAudioOutputOf(null, out12, interfaceOutputs)).toBe(true);
  // The label as this Mac's Chromium writes it.
  const mac = audioOutputsOf([
    device("default", "Default - MacBook Air Speakers (Built-in)", "g-mac"),
    device("m1", "MacBook Air Speakers (Built-in)", "g-mac"),
  ]);
  expect(mac.defaultDeviceId).toBe("m1");
  // A default whose label names no entry: its group is all there is.
  const unnamed = audioOutputsOf([device("default", "Default", "g-iface"), device("o12", "Out 1-2", "g-iface")]);
  expect(unnamed.defaultDeviceId).toBeNull();
  expect(sameAudioOutputOf(null, out12, unnamed)).toBe(true);
});

const zoom = device("z1", "ZoomAudioDevice (Virtual)", "g-zoom");
const teams = device("t1", "Microsoft Teams Audio (Virtual)", "g-teams");
const macOutputs = audioOutputsOf([
  device("default", "Predeterminado - MacBook Air Speakers (Built-in)", "g-mac"),
  device("m1", "MacBook Air Speakers (Built-in)", "g-mac"),
  zoom,
  teams,
]);
const zoomChoice = { label: "ZoomAudioDevice (Virtual)", deviceId: "z1" };
const zoomListed = macOutputs.devices.find((d) => d.deviceId === "z1");

test("a chosen output both sides can open: Chromium's id for the elements, the engine's name for its sessions", () => {
  const names = new Map([["z1", "coreaudio/zoom.us.zoomaudiodevice.001"]]);
  expect(resolveBus(zoomChoice, macOutputs.devices, names)).toEqual({
    out: { sinkId: "z1", engineDevice: "coreaudio/zoom.us.zoomaudiodevice.001" },
    state: "ok",
    device: zoomListed,
  });
  // The id moved (another USB port): found by its name, and the engine is asked by that name.
  expect(resolveBus({ ...zoomChoice, deviceId: "stale" }, macOutputs.devices, names).out.sinkId).toBe("z1");
  // No choice: the system's default for both, nothing to warn about.
  expect(resolveBus(null, macOutputs.devices, names)).toEqual({ out: { sinkId: "", engineDevice: null }, state: "ok", device: null });
});

test("a chosen output that is unplugged, or that the engine cannot open, sends the WHOLE bus to the default", () => {
  // Unplugged: neither Chromium nor the engine is pointed at it.
  expect(resolveBus({ label: "Scarlett 2i2", deviceId: "b2" }, macOutputs.devices, new Map())).toEqual({
    out: { sinkId: "", engineDevice: null },
    state: "missing",
    device: null,
  });
  // Plugged in, but the engine has none of that name, or two (`matchEngineDevice` says null): Chromium could play
  // there, and does not, or one bus would sound in two places.
  for (const names of [new Map<string, string | null>([["t1", null]]), new Map<string, string | null>()]) {
    expect(resolveBus({ label: "Microsoft Teams Audio (Virtual)", deviceId: "t1" }, macOutputs.devices, names)).toEqual({
      out: { sinkId: "", engineDevice: null },
      state: "unusable",
      device: null,
    });
  }
  // A bus sent to the default for that reason shares the default's device with a PREVIEW left there (D6).
  expect(sameAudioOutputOf({ label: "Microsoft Teams Audio (Virtual)", deviceId: "t1" }, null, macOutputs, new Map([["t1", null]]))).toBe(true);
  expect(sameAudioOutputOf(zoomChoice, null, macOutputs, new Map([["z1", "coreaudio/zoom.us.zoomaudiodevice.001"]]))).toBe(false);
});

test("an engine that cannot choose an output (older than engine-8, or none) leaves its sessions on the default", () => {
  // Only Chromium moves; the engine is never sent a name it does not understand.
  expect(resolveBus(zoomChoice, macOutputs.devices, "none")).toEqual({ out: { sinkId: "z1", engineDevice: null }, state: "ok", device: zoomListed });
  // «auto»: the engine's own word for the default, never sent as a device.
  expect(resolveBus(zoomChoice, macOutputs.devices, new Map([["z1", "auto"]])).out.engineDevice).toBeNull();
});

test("an engine that has not answered, or an output one side refused, moves neither side", () => {
  // Fails if Chromium goes to the chosen output while the engine's files stay on the default: one bus, two devices.
  expect(resolveBus(zoomChoice, macOutputs.devices, "pending")).toEqual({ out: { sinkId: "", engineDevice: null }, state: "pending", device: null });
  // Unplugged says so first: that is what the operator can act on.
  expect(resolveBus({ label: "Scarlett 2i2", deviceId: "b2" }, macOutputs.devices, "pending").state).toBe("missing");
  // A window's `setSinkId` or an engine session failed on it: refused by its name, whatever the engine answered.
  const refused = new Set(["ZoomAudioDevice (Virtual)"]);
  for (const engine of ["none", "pending", new Map([["z1", "coreaudio/zoom.us.zoomaudiodevice.001"]])] as const) {
    expect(resolveBus(zoomChoice, macOutputs.devices, engine, refused)).toEqual({ out: { sinkId: "", engineDevice: null }, state: "unusable", device: null });
  }
});

test("the faders move on OBS's log scale: a fade by hand reaches silence gradually, and a level sits where it was left", () => {
  const db = (position: number): number => 20 * Math.log10(faderToGain(position));
  expect([faderToGain(0), faderToGain(1), gainToFader(0), gainToFader(1)]).toEqual([0, 1, 0, 1]);
  // OBS's own numbers (`log_def_to_db`): −18.7 dB halfway, −6.2 at three quarters, −96 just above the bottom.
  expect(db(0.5)).toBeCloseTo(-18.74, 2);
  expect(db(0.75)).toBeCloseTo(-6.18, 2);
  expect(db(1e-9)).toBeCloseTo(-96, 2);
  // A linear fader's last tenth went from −20 dB to silence; this one is at −71 dB at 0.1.
  expect(db(0.1)).toBeLessThan(-60);
  expect(formatDb(faderToGain(0.5))).toBe("−19 dB");

  // Every step of the 0..100 range is a louder gain than the one below it, and comes back to its own step: a level
  // saved from a fader opens tomorrow with the fader where the hand left it.
  let previous = -1;
  for (let step = 0; step <= 100; step++) {
    const gain = faderToGain(step / 100);
    expect(gain).toBeGreaterThan(previous);
    expect(Math.round(gainToFader(gain) * 100)).toBe(step);
    previous = gain;
  }
  // A level saved before this scale (the old linear 50 %, −6 dB) stands at three quarters.
  expect(Math.round(gainToFader(0.5) * 100)).toBe(75);
});
