## mpv cannot open some macOS outputs for a mono file unless its output is forced to stereo
**Area:** projection
**Trigger:** an engine session on a chosen output (`device`, `setEngineAudioDevices`) that plays silent, or an `audio-out` `ok:false` for a device that works with other files; testing output routing on a Mac with the E2E suite's tones (all mono)

- **Measured 2026-11-15 (M3: the engine-8 and Homebrew's mpv 0.41 alike):** a mono WAV sent to `coreaudio/zoom.us.zoomaudiodevice.001` fails with `[ao/coreaudio] unable to set the input channel layout on the audio unit (-50)` and «Could not open/initialize audio device -> no sound»; the same tone in stereo opens and plays there (`kAudioDevicePropertyDeviceIsRunningSomewhere` = 1, its NDI tap reads it). mpv with `--audio-channels=stereo` opens it for the mono file too. The built-in speakers take mono either way, so a test on them never sees it.
- **What it costs:** the device works for one file and not the next. With the engine reporting `audio-out` `ok:false`, the control window refuses that output for the session (`effects/audio-route.ts`) and the whole bus goes to the default, so one mono file would move the room's sound off a device that plays every stereo file fine. The engine forcing a stereo output (`audio-channels`), or upmixing before the output, removes the case; until then, a routing test on a Mac uses a stereo file (`tests/e2e/audio-outputs.spec.ts`'s `stereoTone`).
- Chromium has no such problem (it mixes to the device's layout), and its `deviceId` for an output is the same in the control window and the projector (same origin): `setSinkId` with the id the control window listed works in the projection window.

**Last updated:** 2026-11-15
