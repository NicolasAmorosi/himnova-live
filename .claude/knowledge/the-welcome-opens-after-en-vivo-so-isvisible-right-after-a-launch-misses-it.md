## The welcome opens after EN VIVO shows, so `isVisible()` right after a launch misses it
**Area:** renderer
**Trigger:** an E2E that relaunches a profile whose welcome was never closed, or a test that glances for a dialog right after `WorshipApp.launch`; on Windows, `screens.spec.ts`'s «the next launch keeps it so» timing out on `waitForEvent("window")`

- `welcome.pending` stays `true` until the welcome is closed (skipped or finished), and `App` opens it only after `loadSettings()` resolves. `WorshipApp.launch` returns once EN VIVO is visible, which is BEFORE that: a profile relaunched with the welcome pending shows it a moment later, every time.
- `screens.spec.ts:108` checked `welcomeAgain.isVisible()` (instantaneous) on the second launch: on a fast Mac it usually caught the dialog, on the owner's Windows PC it read `false`, the welcome then opened and swallowed the `l` meant to open the projector, and the test waited 30 s for a window. It was logged as «the known flaky test» in the 2.8.0 and 2.8.1 runs (1 of 4) until it failed 2 of 3 on 2026-11-13; the failure screenshot showed the welcome open.
- Fix: click «Saltar la bienvenida» unconditionally (Playwright waits for it). Windows: 25/25 after. Whenever a dialog is known to come, wait for it; `isVisible()` is only for one that may or may not exist, and then it needs a settle point.

**Last updated:** 2026-11-13
