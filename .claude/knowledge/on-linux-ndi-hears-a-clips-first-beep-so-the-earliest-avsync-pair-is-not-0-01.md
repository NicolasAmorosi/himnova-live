## On Linux, NDI hears a clip's first beep, so the earliest `avsync` pair is 0:00's, not 0:01's
**Area:** projection
**Trigger:** an NDI sound/picture check fails only on Linux, or by its first pair only; `ndi-probe avsync`'s `first`;
`ndi-start.spec.ts`'s cut test; the engine's `AUDIO_DELAY` on Linux

- Believed (2026-11-12): «0:00's own beep never reaches a receiver, any engine start», so `avsync`'s `first` was taken as
  0:01's pair. True on macOS and Windows, where the capture follows the app's processes and joins an engine late. On
  Linux the capture is the default output's monitor (`native/engine/ndi-audio-linux.cpp`): the whole computer, from the
  first instant. There 0:00's beep arrives, and `first` is 0:00's pair.
- Evidence (2026-11-13, the owner's CachyOS laptop, 2.8.1): in every run the first pair came 0.9 s before the second,
  every other gap 1.0 s. The cut test read −31…−78 ms (limit −45) while 0:01's pair was +7…+40. A wrapper around the
  packaged `media-engine` (`--log-level v`, stdin and stderr stamped with `date +%s.%3N`) showed main sending `volume
  100` + `pause 0` in the same millisecond as GO LIVE, mpv «starting audio playback» 31 ms later, and the clip's first
  frame reaching NDI ~110 ms after GO LIVE.
- So the 0:00 pair is real but different: the sound of the first frame leads its picture by up to ~80 ms, because the
  hold for an engine taken from PREVIEW (`holdUntilShown`, `src/main/media/engine-sessions.ts`) ends when the
  projector and the NDI window MOUNT the canvas, not when they draw its first frame. Not measurable over NDI on macOS
  or Windows. Holding until the first frame is drawn is open (2.9.0 list).
- Pick a pair by its time, never by `first`: the cut test now takes the first pair whose flash is ≥ GO LIVE + 500 ms
  and logs 0:00's apart. The probe's timecodes and the test's `Date.now()` share the sender's clock (same machine).
- Linux's engine `AUDIO_DELAY` (`native/engine/engine.cpp`) is the Mac's 65 ms, never measured there; Linux still
  lands inside EBU R37 (+6 ms fresh engine, +7…+40 taken from PREVIEW).
- Related: [libmpv gives no way to read its sound](libmpv-gives-no-way-to-read-its-sound-so-ndi-audio-captures-the-app-from-the-os.md).

**Last updated:** 2026-11-13
