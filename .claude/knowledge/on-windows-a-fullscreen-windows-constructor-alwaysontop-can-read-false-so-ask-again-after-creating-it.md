## On Windows, a fullscreen window's constructor `alwaysOnTop` can read false, so ask again after creating it
**Area:** projection
**Trigger:** a window that must stay above everything (projector, stage screen) on Windows; `isAlwaysOnTop()` false in a test or a probe; a new output window built with `alwaysOnTop: true` in its options

- Believed: `new BrowserWindow({ alwaysOnTop: true, fullscreen: true })` leaves the window on top. Measured on the
  owner's Windows PC (3 monitors, 2026-11-18): the stage screen opened fullscreen on its own display read
  `isAlwaysOnTop()` false from creation on, on every probe, although its options asked for it.
  `screens.spec.ts:268` failed 3 of 3 there with the app at fault, also with a package of the previous `main`.
- The projector never showed it because `projection-window.ts` already calls
  `win.setAlwaysOnTop(true, "screen-saver")` after creating the window. `stage-window.ts` now does the same when the
  stage has its own screen (`if (!own)`), shipped in 2.12.0: 6 of 6 after.
- Not measured: whether another window ever actually covered the stage. The rule is cheap anyway: any output window
  that must stay on top asks again with `setAlwaysOnTop(true, "screen-saver")` once created, never trusting the
  constructor alone. A probe of it must skip a window whose `webContents` is already destroyed (a stage being
  replaced is still listed: «Object has been destroyed»).

**Last updated:** 2026-11-18
