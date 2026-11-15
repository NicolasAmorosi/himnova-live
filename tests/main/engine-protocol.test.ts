import { expect, test } from "vitest";
import {
  EngineGate,
  jsonLineReader,
  matchEngineDevice,
  mpvVolume,
  ndiRouteLines,
  protoAfter,
  type EngineDevice,
} from "../../src/main/media/engine-protocol";

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

// Lines an engine-8 printed (darwin-arm64, 2026-11-15: a video told `device coreaudio/NOPE` and then ZoomAudioDevice,
// beside an NDI sender on the same missing output), whole and in their order; frames and most statuses left out.
const ENGINE_8_STDOUT = [
  '{"ev":"hello","proto":8}',
  '{"ev":"ready","gpu":"CGL Apple M3","adapter":""}',
  '{"ev":"audio-out","ok":false,"device":"coreaudio/NOPE"}',
  '{"ev":"loaded","duration":10.000,"width":1280,"height":720,"hasVideo":true,"hasAudio":true}',
  '{"ev":"status","time":0.000,"duration":0.000,"paused":false,"ended":false}',
  '{"ev":"slots","width":1280,"height":720,"handles":[370,504,505,578,581,585]}',
  '{"ev":"audio-out","ok":true,"device":"coreaudio/zoom.us.zoomaudiodevice.001"}',
  '{"ev":"level","peak":[-12.0,-12.0]}',
  '{"ev":"devices","list":[{"name":"auto","description":"Autoselect device"},{"name":"coreaudio/BuiltInSpeakerDevice","description":"MacBook Air Speakers"},{"name":"coreaudio/MSLoopbackDriverDevice_UID","description":"Microsoft Teams Audio"},{"name":"coreaudio/zoom.us.zoomaudiodevice.001","description":"ZoomAudioDevice"},{"name":"avfoundation/BuiltInSpeakerDevice","description":"MacBook Air Speakers"},{"name":"avfoundation/MSLoopbackDriverDevice_UID","description":"Microsoft Teams Audio"},{"name":"avfoundation/zoom.us.zoomaudiodevice.001","description":"ZoomAudioDevice"}]}',
  '{"ev":"status","time":1.700,"duration":10.000,"paused":true,"ended":false}',
  '{"ev":"level","peak":[-120.0,-120.0]}',
];
const NDI_8_STDOUT = [
  '{"ev":"hello","proto":8}',
  '{"ev":"ready","runtime":"NDI SDK APPLE 12:49:17 Apr 13 2026 6.3.2.0"}',
  '{"ev":"audio","state":"off","detail":"no output coreaudio/NOPE"}',
  '{"ev":"status","receivers":0}',
  '{"ev":"audio","state":"on"}',
  '{"ev":"audio","state":"on","level":-12}',
];

test("engine-8's stdout as it really prints it, split anywhere a pipe may", () => {
  const events: { ev: string }[] = [];
  const read = jsonLineReader<{ ev: string }>((event) => events.push(event));
  const text = ENGINE_8_STDOUT.join("\n") + "\n";
  for (let at = 0; at < text.length; at += 37) read(text.slice(at, at + 37));
  // Fails if a line is lost or merged with the next: the sound's state or a level would never reach main.
  expect(events.map((e) => e.ev)).toEqual(["hello", "ready", "audio-out", "loaded", "status", "slots", "audio-out", "level", "devices", "status", "level"]);
  // Fails if the engine prints `-inf` for silence (not JSON) or a level in another unit than dBFS.
  expect(events.filter((e) => e.ev === "level")).toEqual([
    { ev: "level", peak: [-12, -12] },
    { ev: "level", peak: [-120, -120] },
  ]);
  // A missing output is its own event, never an `error`: a file that still plays must not be reported broken.
  expect(events.filter((e) => e.ev === "audio-out")).toEqual([
    { ev: "audio-out", ok: false, device: "coreaudio/NOPE" },
    { ev: "audio-out", ok: true, device: "coreaudio/zoom.us.zoomaudiodevice.001" },
  ]);
  expect(events.some((e) => e.ev === "error")).toBe(false);
  // The `devices` answer is what the matcher below is tested against.
  expect(events.find((e) => e.ev === "devices")).toEqual({ ev: "devices", list: MAC });
});

test("an engine-8 is held until hello, then hears every line in the order main wrote it", () => {
  const out: string[] = [];
  const gate = new EngineGate((line) => out.push(line));
  // What `load` with a device and the session's first commands write at once, before the engine has spoken.
  gate.send("device coreaudio/BuiltInSpeakerDevice", 8);
  gate.send("load 12 1 100 0 1 /media/song.mp4");
  gate.send("loop 1");
  gate.send("seek 30 exact");
  gate.send("pause 0");
  // Fails if anything reaches an engine that has not said what it speaks.
  expect(out).toEqual([]);
  const read = jsonLineReader<{ ev: string; proto?: number }>((event) => gate.heard(event));
  read(ENGINE_8_STDOUT[0] + "\n");
  // Fails if `loop`/`seek`/`pause` go out ahead of the `load` that waited (the load would undo them), or the device
  // after the file it should open on.
  expect(out).toEqual(["device coreaudio/BuiltInSpeakerDevice", "load 12 1 100 0 1 /media/song.mp4", "loop 1", "seek 30 exact", "pause 0"]);
  gate.send("volume 50");
  expect(out.at(-1)).toBe("volume 50");
  expect(gate.proto).toBe(8);
});

test("an engine-7 (no hello) never gets an engine-8 command, and its own lines keep their order", () => {
  const out: string[] = [];
  const gate = new EngineGate((line) => out.push(line));
  const asked: number[] = [];
  gate.send("device coreaudio/BuiltInSpeakerDevice", 8);
  gate.send("load 0 0 100 0 1 /media/a.mp4");
  gate.after((proto) => asked.push(proto));
  gate.send("pause 1");
  // engine-7's first line, as it printed it (2026-11-12).
  gate.heard({ ev: "ready", gpu: "CGL Apple M3", adapter: "" } as { ev: string });
  // Fails if `device` reaches it: it answers `engine-args` and its session is failed over a file that plays.
  expect(out).toEqual(["load 0 0 100 0 1 /media/a.mp4", "pause 1"]);
  expect(asked).toEqual([7]);
  gate.send("devices", 8);
  expect(out).toHaveLength(2);
  // A later event never changes what the first said.
  gate.heard({ ev: "hello", proto: 8 });
  expect(gate.proto).toBe(7);
});

test("the NDI sender's route: both lines every time, the device last, none to an older sender", () => {
  const route = { device: "wasapi/{9c2f3d2e-1b44-4c1e-8d2f-0e6b2a7f1c33}", previewApart: true };
  // Fails if a sender without `hello` gets a line: on Windows it answers `done` and main releases a texture it reads.
  expect(ndiRouteLines(7, route)).toBe("");
  expect(ndiRouteLines(8, route)).toBe("preview-apart 1\naudio-device wasapi/{9c2f3d2e-1b44-4c1e-8d2f-0e6b2a7f1c33}\n");
  // Fails if an unchanged route is dropped: a capture whose device came back would stay off for the session.
  expect(ndiRouteLines(8, route)).toBe(ndiRouteLines(8, { ...route }));
  expect(ndiRouteLines(8, { device: null, previewApart: false })).toBe("preview-apart 0\naudio-device auto\n");
  // The sender's own lines as it printed them parse as the events `NdiSender` reads.
  const events: unknown[] = [];
  jsonLineReader((event) => events.push(event))(NDI_8_STDOUT.join("\n") + "\n");
  expect(events).toHaveLength(NDI_8_STDOUT.length);
  expect(events[2]).toEqual({ ev: "audio", state: "off", detail: "no output coreaudio/NOPE" });
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

// mpv's list on the Windows test PC (engine-8, 2026-11-15): `wasapi/` + only the endpoint id's last part, as mpv prints it.
const WINDOWS: EngineDevice[] = [
  { name: "auto", description: "Autoselect device" },
  { name: "wasapi/{1be4f41e-1f18-427d-a0a2-cae026f33de4}", description: "Altavoces (Steam Streaming Speakers)" },
  { name: "wasapi/{44260f36-a085-4072-b2a3-b2e18e9d8bf7}", description: "Realtek Digital Output (Realtek(R) Audio)" },
  { name: "wasapi/{4a1309b7-1e86-426b-a211-ccfa704899a4}", description: "GS25F2 (NVIDIA High Definition Audio)" },
  { name: "wasapi/{91d1eb51-611a-4229-8e73-9adc72985dc2}", description: "Altavoces (Steam Streaming Microphone)" },
  { name: "wasapi/{c6c24068-94da-4193-8581-6e796b1e48df}", description: "PHL 221V8 (NVIDIA High Definition Audio)" },
  { name: "openal", description: "Default (openal)" },
];

test("Windows: the friendly name as it is, parentheses included", () => {
  const match = (label: string) => matchEngineDevice({ deviceId: "x", label }, WINDOWS, "win32");
  // Fails if the name is cut at its parentheses (two Steam outputs would be one) or `openal` is taken.
  expect(match("Altavoces (Steam Streaming Speakers)")).toBe("wasapi/{1be4f41e-1f18-427d-a0a2-cae026f33de4}");
  expect(match("Altavoces (Steam Streaming Microphone)")).toBe("wasapi/{91d1eb51-611a-4229-8e73-9adc72985dc2}");
  expect(match("GS25F2 (NVIDIA High Definition Audio)")).toBe("wasapi/{4a1309b7-1e86-426b-a211-ccfa704899a4}");
  expect(match("Altavoces")).toBeNull();
  expect(matchEngineDevice({ deviceId: "communications", label: "Comunicaciones - Altavoces (Steam Streaming Speakers)" }, WINDOWS, "win32")).toBeNull();
});

test("two engine devices with the same name, or none: no match", () => {
  const twins: EngineDevice[] = [
    { name: "wasapi/{6f1a0c2e-5b8d-4e3a-9c71-2d4f8e0b1a95}", description: "Speakers (USB Audio Device)" },
    { name: "wasapi/{b3e9d7a4-0c62-41f5-8e2b-7a9c3d5f6e18}", description: "Speakers (USB Audio Device)" },
  ];
  // Fails if a bus is split between two devices that only share a name.
  expect(matchEngineDevice({ deviceId: "x", label: "Speakers (USB Audio Device)" }, twins, "win32")).toBeNull();
  expect(matchEngineDevice({ deviceId: "x", label: "Headphones" }, twins, "win32")).toBeNull();
  expect(matchEngineDevice({ deviceId: "x", label: "Speakers (USB Audio Device)" }, twins.slice(0, 1), "win32")).toBe(
    "wasapi/{6f1a0c2e-5b8d-4e3a-9c71-2d4f8e0b1a95}",
  );
});

// mpv's list on the Linux test PC (CachyOS, PipeWire 1.6.10 with pipewire-pulse, 2026-11-15), its alsa plugins trimmed.
const SPEAKER = "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Speaker__sink";
const HDMI1 = "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI1__sink";
const LINUX: EngineDevice[] = [
  { name: "auto", description: "Autoselect device" },
  { name: "pipewire", description: "Default (pipewire)" },
  { name: `pipewire/${HDMI1}`, description: "Raptor Lake-P/U/H cAVS HDMI / DisplayPort 1 Output (Stereo)" },
  { name: `pipewire/${SPEAKER}`, description: "Raptor Lake-P/U/H cAVS Speaker" },
  { name: `pulse/${HDMI1}`, description: "Raptor Lake-P/U/H cAVS HDMI / DisplayPort 1 Output (Stereo)" },
  { name: `pulse/${SPEAKER}`, description: "Raptor Lake-P/U/H cAVS Speaker" },
  { name: "alsa", description: "Default (alsa)" },
  { name: "alsa/pipewire", description: "PipeWire Sound Server" },
  { name: "alsa/sysdefault:CARD=sofhdadsp", description: "sof-hda-dsp, /Default Audio Device" },
];

test("Linux: the pulse/ and pipewire/ twins are one device, pulse/ first", () => {
  const match = (label: string, list = LINUX) => matchEngineDevice({ deviceId: "x", label }, list, "linux");
  // Fails if the twin makes every name ambiguous (no match at all), or the bare «pipewire» default is taken for a sink.
  expect(match("Raptor Lake-P/U/H cAVS Speaker")).toBe(`pulse/${SPEAKER}`);
  expect(match("Raptor Lake-P/U/H cAVS HDMI / DisplayPort 1 Output (Stereo)")).toBe(`pulse/${HDMI1}`);
  // An mpv built without pulse (its list has no `pulse/` at all): the `pipewire/` twin.
  expect(match("Raptor Lake-P/U/H cAVS Speaker", LINUX.filter((d) => !d.name.startsWith("pulse/")))).toBe(`pipewire/${SPEAKER}`);
  expect(match("PipeWire Sound Server")).toBeNull();
});
