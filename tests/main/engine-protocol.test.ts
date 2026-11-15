import { expect, test } from "vitest";
import { jsonLineReader, matchEngineDevice, mpvVolume, protoAfter, type EngineDevice } from "../../src/main/media/engine-protocol";

test("the panel's volume reaches mpv on its cube-root scale", () => {
  // Fails if every engine file goes silent (M03), or if 30 % is sent linearly and plays at 2.7 %.
  expect([0, 0.3, 1].map(mpvVolume)).toEqual([0, 67, 100]);
  // Fails if a value out of 0..1 reaches mpv, which amplifies up to 130.
  expect([-1, 2].map(mpvVolume)).toEqual([0, 100]);
});

test("an event split across stdout chunks arrives once, whole; a line that is not JSON is skipped", () => {
  const events: unknown[] = [];
  const read = jsonLineReader((event) => events.push(event));
  read('{"ev":"status","time":8,"duration":8,"pau');
  read('sed":true,"ended":true}\nlibmpv: a warning\n{"ev":"fr');
  read('ame","slot":2}\n');
  // Fails if a partial line is parsed or dropped: an engine's `ended` (or a frame) would be lost.
  expect(events).toEqual([
    { ev: "status", time: 8, duration: 8, paused: true, ended: true },
    { ev: "frame", slot: 2 },
  ]);
});

test("an engine says its protocol first; one that starts with anything else is engine-7", () => {
  // Fails if an engine-7 (no hello) is sent `device`/`devices`: it answers `engine-args` and its session fails.
  expect(protoAfter(null, { ev: "ready" })).toBe(7);
  expect(protoAfter(null, { ev: "error" })).toBe(7);
  expect(protoAfter(null, { ev: "hello", proto: 8 })).toBe(8);
  // Fails if a later event overrides what the first one said.
  expect(protoAfter(8, { ev: "ready" })).toBe(8);
});

test("engine-8's stdout as it really prints it: hello, devices and levels", () => {
  const events: unknown[] = [];
  const read = jsonLineReader((event) => events.push(event));
  // Lines copied from a darwin-arm64 engine-8 (2026-11-15), split mid-line as a pipe may.
  read('{"ev":"hello","proto":8}\n{"ev":"devices","list":[{"name":"auto","description":"Autoselect device"},{"name":"core');
  read('audio/BuiltInSpeakerDevice","description":"MacBook Air Speakers"}]}\n{"ev":"level","peak":[-12.0,-32.0]}\n');
  read('{"ev":"level","peak":[-120.0,-120.0]}\n');
  expect(events).toEqual([
    { ev: "hello", proto: 8 },
    {
      ev: "devices",
      list: [
        { name: "auto", description: "Autoselect device" },
        { name: "coreaudio/BuiltInSpeakerDevice", description: "MacBook Air Speakers" },
      ],
    },
    // Fails if the engine prints `-inf` for silence (not JSON) or a level in another unit than dBFS.
    { ev: "level", peak: [-12, -32] },
    { ev: "level", peak: [-120, -120] },
  ]);
});

// mpv's `audio-device-list` and Chromium's `audiooutput` labels, as each system printed them (2026-11-15).
const MAC: EngineDevice[] = [
  { name: "auto", description: "Autoselect device" },
  { name: "coreaudio/BuiltInSpeakerDevice", description: "MacBook Air Speakers" },
  { name: "coreaudio/MSLoopbackDriverDevice_UID", description: "Microsoft Teams Audio" },
  { name: "coreaudio/zoom.us.zoomaudiodevice.001", description: "ZoomAudioDevice" },
  { name: "avfoundation/BuiltInSpeakerDevice", description: "MacBook Air Speakers" },
  { name: "avfoundation/MSLoopbackDriverDevice_UID", description: "Microsoft Teams Audio" },
  { name: "avfoundation/zoom.us.zoomaudiodevice.001", description: "ZoomAudioDevice" },
];

test("macOS: Chromium's label without its transport, against Core Audio's names only", () => {
  const match = (deviceId: string, label: string) => matchEngineDevice({ deviceId, label }, MAC, "darwin");
  // Fails if the `avfoundation/` twin makes it ambiguous, or Chromium's « (Built-in)» is compared as part of the name.
  expect(match("74c78103d005", "MacBook Air Speakers (Built-in)")).toBe("coreaudio/BuiltInSpeakerDevice");
  expect(match("0dbbafa1fa0a", "ZoomAudioDevice (Virtual)")).toBe("coreaudio/zoom.us.zoomaudiodevice.001");
  // A USB device's (vid:pid).
  expect(
    matchEngineDevice(
      { deviceId: "x", label: "Scarlett 2i2 USB (1235:8210)" },
      [...MAC, { name: "coreaudio/AppleUSBAudioEngine:Focusrite:Scarlett 2i2 USB:Y8000000:1,2", description: "Scarlett 2i2 USB" }],
      "darwin",
    ),
  ).toBe("coreaudio/AppleUSBAudioEngine:Focusrite:Scarlett 2i2 USB:Y8000000:1,2");
  // Chromium's own name differs from Core Audio's here: no guess.
  expect(match("109a70a41bdc", "Microsoft Teams Audio Device (Virtual)")).toBeNull();
  // Chromium's default is the engine's.
  expect(match("default", "Default - MacBook Air Speakers (Built-in)")).toBe("auto");
});

test("two engine devices with the same name, or none: no match", () => {
  const twins: EngineDevice[] = [
    { name: "wasapi/{0.0.0.00000000}.{a}", description: "Speakers (USB Audio Device)" },
    { name: "wasapi/{0.0.0.00000000}.{b}", description: "Speakers (USB Audio Device)" },
  ];
  // Fails if a bus is split between two devices that only share a name.
  expect(matchEngineDevice({ deviceId: "x", label: "Speakers (USB Audio Device)" }, twins, "win32")).toBeNull();
  expect(matchEngineDevice({ deviceId: "x", label: "Headphones" }, twins, "win32")).toBeNull();
  expect(matchEngineDevice({ deviceId: "communications", label: "Communications - Speakers (USB Audio Device)" }, twins, "win32")).toBeNull();
  // Windows keeps its parentheses: they are part of the friendly name.
  expect(matchEngineDevice({ deviceId: "x", label: "Speakers (USB Audio Device)" }, twins.slice(0, 1), "win32")).toBe("wasapi/{0.0.0.00000000}.{a}");
});
