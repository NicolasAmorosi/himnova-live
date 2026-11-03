## On Windows, Playwright's `electron.process()` is a `cmd.exe`, not the app
**Area:** build
**Trigger:** an E2E test that kills, samples or signals the app (`process().kill`, `pid`), or a test that passes on macOS/Linux and fails on Windows right after a kill or a relaunch

- `_electron.launch` always spawns Electron with `shell: true` on `win32` (playwright-core
  `coreBundle.js`, the `if (process.platform === "win32") { shell = true; ... }` before
  `launchProcess`). So `app.process()` is `cmd.exe` and Electron main is ITS child. On macOS and
  Linux it is Electron main itself, which is why nothing showed up there.
- Measured on the owner's PC, 2026-11-03: during `robustness.spec` «survives the app being killed»,
  main's parent was a `cmd.exe` whose parent was `node`. `app.process().kill("SIGKILL")` ended the
  `cmd` and the `exit` event fired, but main stayed up with the single-instance lock, so the relaunch
  quit at once with code 0 (`electron.launch: Target page, context or browser has been closed`,
  `<process did exit: exitCode=0>`), and the app was left running after the suite.
- The app was never at fault: `Stop-Process -Force` on main's own pid ends every child (renderer,
  GPU, `media-engine.exe`) and a relaunch opens normally.
- Kill or sample the app by `WorshipApp.mainPid` (`tests/e2e/support/app.ts`, read with
  `app.evaluate(() => process.pid)` at launch), never by `electron.process().pid`.

**Last updated:** 2026-11-03
