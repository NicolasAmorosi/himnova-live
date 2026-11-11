## Recording the app: CDP screencast frames are CSS-sized, and the projector ignores an emulated size

**Area:** tests (`tests/e2e/support/recorder.ts`, `tests/e2e/tutorials.record.ts`, `support/demo.ts`)
**Trigger:** Before changing `npm run tutorials`, filming any window of the app, or trusting a size you set with
`Emulation.setDeviceMetricsOverride` on a window the app places itself.

Found 2026-11-11, building the landing's tutorial videos.

- **`Page.startScreencast` hands frames at the CSS size** (1440×900 for a control window laid out at 1440×900 @2×),
  even with `deviceScaleFactor: 2` and a `maxWidth`/`maxHeight` of twice that — unlike `Page.captureScreenshot`, which
  honours the emulated ratio (the screenshots are 2×). Enough for a 1080p video with a camera zoom up to ~1.6; for more,
  lay the window out smaller or use screenshots.
- **Frames arrive only when something repaints**, at the display's rate (~100/s on this Mac with video playing):
  `everyNthFrame` 2 for the control window, 1 for the projector (fades and videos), and each frame's
  `metadata.timestamp` is wall-clock seconds, so both windows and the pointer log share one clock.
- **The projector window doesn't keep an emulated 1920×1080**: the first frames come at 16:9, then the app places the
  window (single screen = framed, at the screen's shape) and the frames turn 16:10. Neither emulation nor
  `setContentSize` sticks. Film it at its own size: 16:9 content is letterboxed in a 16:10 window, so cropping the frame
  to 16:9 gives exactly what a 16:9 projector shows.
- **A native drag never appears in a screencast** (the drag image is the OS's). `rec.drag()` logs the dragged box and
  the composer draws a copy of it under the pointer. Playwright's `mouse.down/move/up` does start an HTML5 drag in
  Chromium, so a library tile really lands in the schedule.
- **BLACK and LOGO are not toggles** (`setOverlayDirect` returns early on the state already shown); only the B/L keys
  toggle. A script that "clicks BLACK again" films nothing — LIVE brings the content back.
