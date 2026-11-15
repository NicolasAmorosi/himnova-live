/** The audio strips' pure parts: the meter's ballistics and which device each bus ends up in (D6). */
import { expect, test } from "vitest";
import { SILENT_CHANNEL, isLit, stepMeterChannel } from "@renderer/components/ui/level-meter";
import { audioOutputsOf, findAudioOutput, sameAudioOutput } from "@renderer/lib/hooks/use-audio-outputs";

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
  expect(outputs.defaultGroupId).toBe("g-speakers");
  // By NAME, what the media engine can match too; a stale id still finds it.
  expect(findAudioOutput({ label: "Scarlett 2i2", deviceId: "old" }, outputs.devices)?.deviceId).toBe("b2");
});

test("PREVIEW shares LIVE's output when both end up in the same device (D6)", () => {
  const scarlett = { label: "Scarlett 2i2", deviceId: "b2" };
  const speakers = { label: "Altavoces", deviceId: "a1" };
  expect(sameAudioOutput(null, null, outputs)).toBe(true);
  // The default IS the speakers today, whichever side names them.
  expect(sameAudioOutput(null, speakers, outputs)).toBe(true);
  expect(sameAudioOutput(speakers, null, outputs)).toBe(true);
  expect(sameAudioOutput(scarlett, null, outputs)).toBe(false);
  expect(sameAudioOutput(scarlett, speakers, outputs)).toBe(false);
  expect(sameAudioOutput(speakers, speakers, outputs)).toBe(true);
});

test("a choice that is not plugged in plays through the system's default, so that is what is compared", () => {
  const gone = { label: "USB Headset", deviceId: "z9" };
  const other = { label: "Other Dongle", deviceId: "z8" };
  const speakers = { label: "Altavoces", deviceId: "a1" };
  const scarlett = { label: "Scarlett 2i2", deviceId: "b2" };
  // Unplugged LIVE + default PREVIEW: both end in the default, so shared (a name match alone said no).
  expect(sameAudioOutput(gone, null, outputs)).toBe(true);
  // Both unplugged, even different ones: both fall back to the default.
  expect(sameAudioOutput(gone, other, outputs)).toBe(true);
  // Unplugged beside the device the default is: shared; beside another device: not.
  expect(sameAudioOutput(gone, speakers, outputs)).toBe(true);
  expect(sameAudioOutput(gone, scarlett, outputs)).toBe(false);
});

test("two outputs of one interface are different devices, whatever their group says", () => {
  const interfaceOutputs = audioOutputsOf([
    device("default", "Predeterminado - Out 1-2", "g-iface"),
    device("o12", "Out 1-2", "g-iface"),
    device("o34", "Out 3-4", "g-iface"),
  ]);
  const out12 = { label: "Out 1-2", deviceId: "o12" };
  const out34 = { label: "Out 3-4", deviceId: "o34" };
  expect(sameAudioOutput(out12, out34, interfaceOutputs)).toBe(false);
  expect(sameAudioOutput(out12, out12, interfaceOutputs)).toBe(true);
});
