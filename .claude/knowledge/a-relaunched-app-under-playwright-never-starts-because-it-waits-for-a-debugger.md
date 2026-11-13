## A relaunched app under Playwright never starts: it inherits `--inspect=0` and waits for a debugger
**Area:** build
**Trigger:** an E2E around `app.relaunch()` (restore a backup, a future restart-to-apply): the app quits and the next instance never shows up, with nothing in `main.log`

- Playwright's `_electron.launch` starts Electron as `Electron -r …/playwright-core/lib/server/electron/loader.js --inspect=0 --remote-debugging-port=0 <app> …`. `app.relaunch()` reuses that `argv`, so the new process loads the same loader and stops at «Waiting for the debugger to disconnect…»: alive, windowless, holding the profile, forever. Seen on 2026-11-13 with «Restaurar y reiniciar» (`backups:restore`): the staged copy was never applied, and 3 processes of the throwaway profile were still there 35 s later.
- In the suite, stub it before the gesture: `app.electron.evaluate(({ app }) => { app.relaunch = () => undefined; })`, wait for `app.exited`, and start the next instance with `relaunch(app)` on the same profile (`tests/e2e/backups.spec.ts`).
- That stub hides the real path, so verify it once outside Playwright: start `out/` with the plain Electron binary and `--remote-debugging-port=9333`, drive the control window with `chromium.connectOverCDP`, and read the profile's files afterwards. That run measured the window back 1.5 s after the click, with the copy in place. Kill the relaunched process by its `--user-data-dir` when done.

**Last updated:** 2026-11-13
