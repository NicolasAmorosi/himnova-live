## Windows 11 ignores `timeBeginPeriod` in a windowless process that plays no sound, so a silent video judders
**Area:** projection
**Trigger:** a video from the media engine (`native/engine/`) that stutters on Windows only, above all one with no audio track; or touching the start of `main()` in `native/engine/engine.cpp`

- **What was assumed:** `timeBeginPeriod(1)` gives the engine 1 ms timers, as it always did. **What is true on Windows 11:** a process with no visible window that is not playing sound gets the default 15.6 ms timer resolution anyway. The engine has no window by design, so the only thing that kept it "audible" was the video's own soundtrack.
- **The evidence (2026-10-30, the owner's Windows 11 PC, i7-11700F + RTX 4060 Ti, libmpv shinchiro 20261021):**
  - A 60 fps H.264 clip **without audio** lost 1 frame in 12, all along the video. In the window, 12 frames arrived 15.5 ms apart and then there was a 31 ms gap. The same clip with audio, and the same file on macOS and Linux, did not.
  - Inside the engine, `mpv_render_context_render()` (which blocks until each frame's due time) waited 15.3 / 30.8 / 46 ms: multiples of the 15.6 ms tick.
  - mpv options changed nothing: `video-sync=desync` and `display-fps-override=60` were measured with the same result. `display-resample` renders with no pacing at all and is not an option.
- **The fix:** `SetProcessInformation(ProcessPowerThrottling)` with `ControlMask = EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION` and `StateMask = 0`. That opts the process out of both the ignored timer requests and EcoQoS, which a windowless process may also get. Measured right after: the silent 60 fps clip lost 1 frame only where it loops, and a silent 30 fps clip lost none.
- **Never remove that call.** A test run with audio will not show the regression; only a silent video on Windows does. Any other windowless helper process that paces itself with timers needs the same call.
- Related: the measurements are in the plan `2026-10-25-reproduccion-instantanea` (maintainer docs, «Avance» of 2026-10-30).

**Last updated:** 2026-10-30
