/**
 * Which device the system's default output is, on Linux (`media/system-default-output.ts`): Chromium's «default» entry
 * there is just «Default», so the sound server says it, and Chromium labels each output with the sink's description.
 * Read from what `pactl` really printed on the Linux test PC.
 */
import { expect, test } from "vitest";
import { sinkDescriptionFromJson, sinkDescriptionFromText, systemDefaultOutputLabel } from "../../src/main/media/system-default-output";
import { PACTL_DEFAULT_SINK, PACTL_SINKS_JSON, PACTL_SINKS_TEXT } from "../fixtures/pactl-sinks";

const SPEAKER = "Raptor Lake-P/U/H cAVS Speaker";

test("the default sink's description, from pactl's JSON and from its text alike", () => {
  expect(sinkDescriptionFromJson(PACTL_SINKS_JSON, PACTL_DEFAULT_SINK)).toBe(SPEAKER);
  // Fails if a property line («device.description = …», «device.profile.description = …») is read as the sink's own.
  expect(sinkDescriptionFromText(PACTL_SINKS_TEXT, PACTL_DEFAULT_SINK)).toBe(SPEAKER);
  expect(sinkDescriptionFromJson(PACTL_SINKS_JSON, "easyeffects_sink")).toBe("Easy Effects Sink");
  expect(sinkDescriptionFromText(PACTL_SINKS_TEXT, "easyeffects_sink")).toBe("Easy Effects Sink");
});

test("a sink that is not listed, or an answer that is not what pactl prints, is unknown", () => {
  expect(sinkDescriptionFromJson(PACTL_SINKS_JSON, "gone")).toBeNull();
  expect(sinkDescriptionFromText(PACTL_SINKS_TEXT, "gone")).toBeNull();
  // pactl 15 has no `--format`: it prints its usage, not JSON.
  expect(sinkDescriptionFromJson("pactl: unrecognized option '--format=json'", PACTL_DEFAULT_SINK)).toBeNull();
  expect(sinkDescriptionFromJson('{"name":"x"}', "x")).toBeNull();
  expect(sinkDescriptionFromText("", PACTL_DEFAULT_SINK)).toBeNull();
});

test.skipIf(process.platform === "linux")("anywhere but Linux nothing is asked", async () => {
  expect(await systemDefaultOutputLabel()).toBeNull();
});
