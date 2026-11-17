## An engine video's first frame comes before its bar knows the duration, so a key pressed then does nothing
**Area:** projection
**Trigger:** an E2E that presses a key or drags `MediaScrubber` right after a video played by the media engine appears in PREVIEW (EN VIVO was not checked); a Windows-only "the seek did nothing" failure; touching the engine's `status` emission in `native/engine/engine.cpp`

- Believed: once PREVIEW's engine canvas is 1920 wide (its first frame drawn), the PREVIEW bar is ready to seek. Not
  true. For a video, the bar's length comes only from `preview-video-status` (`usePreviewEngine` in
  `src/renderer/src/lib/hooks/use-preview-engine-video.ts`; `PreviewMediaBar` probes a duration for audio only). The
  engine writes a `status` on a pause or end change, on a seek that landed (`MPV_EVENT_PLAYBACK_RESTART`) or on its
  250 ms tick, and **not** when `duration` changes. The frame travels by its own path and can arrive first.
- Until that status lands, `MediaScrubber` is `seekable === false` (`duration > 0` is required): `aria-disabled`,
  `tabindex=-1`, `aria-valuemax=0`, and `handleKeyDown` returns, so End, Home and the arrows are lost without a trace.
  Measured on the owner's Windows PC (2026-11-17, 45 runs of `media-engine.spec.ts:49` against the 2.11.0 package):
  the 4 failures all read `valuemax=0` at the press and `valuemax=30` 200 ms later; the 41 passes read 30 at the press.
  The Mac and Linux never hit it in any run (why not was not measured).
- It surfaced when `eb523a09` (what goes live leaves PREVIEW) made the test pick the video again and press End right
  after its first frame; before, End came after the whole GO LIVE wait. It was noted as a possible 2.11 regression
  ("2 of 10"; one of the two was really an `EPERM` removing the temp profile) until the bar was read around the press.
- Do: wait for the bar's length before driving it, `await expect(scrubber).toHaveAttribute("aria-valuemax", "30")`
  (as `media-engine.spec.ts` and `settings.spec.ts:278` do). Do not read "frame drawn" as "transport ready". For a
  human operator the gap is at most about 300 ms (the 250 ms tick, in a loop that wakes every 50 ms:
  `mpv_wait_event(E.mpv, 0.05)`). If it ever matters, the fix is at the source: make a `duration` change set
  `changed` in the engine's event loop (it needs a new `engine-<n>`).
- Related: [the-welcome-opens-after-en-vivo-so-isvisible-right-after-a-launch-misses-it.md](the-welcome-opens-after-en-vivo-so-isvisible-right-after-a-launch-misses-it.md),
  another Windows "known flaky" that was the test racing the app.

**Last updated:** 2026-11-17
