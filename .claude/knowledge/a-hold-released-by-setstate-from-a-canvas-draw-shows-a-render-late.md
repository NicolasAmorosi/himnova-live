## A hold released by `setState` from a canvas draw shows a render late, so the frames drawn meanwhile are never seen
**Area:** projection
**Trigger:** something kept hidden until its first frame (the video hold in `OutputView`, `handleVideoFirstFrame`); a cut or fade into a video that seems to start a few frames into the clip; an `onFirstFrame`-style callback that calls `setState`

- `EngineVideo`'s `present()` draws a frame and calls `onFirstFrame` → `releaseHold()` → `setHeld(false)`. Called from a `requestAnimationFrame` callback (the paced path) or an IPC listener, that state change is **not** committed in the same frame: React renders it in a later task, after the browser has composited this frame with the entering video still at opacity 0 (a cut) or its animation still paused (a fade). An engine starts with a burst of frames, so by the time the canvas shows, it has already drawn the next one or two out of sight.
- Measured over NDI with a barcode clip (2026-11-12, `ndi-start.spec`'s cut test): a cut showed the clip from frame #2; with `flushSync(releaseHold)` from #1 (#0 was drawn for PREVIEW by the engine GO LIVE took over). Without it the test's first flash at 0:00 was missed entirely and the «first frame» read 1067 ms.
- Rule: whatever must become visible in the same frame a canvas draws needs a synchronous commit (`flushSync` from an event or rAF callback — never during render or an effect) or a direct style write; React state alone lands a render late.

**Last updated:** 2026-11-12
