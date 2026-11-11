## Vetoing a window's `close` during a quit cancels the whole quit — `will-quit` never comes, and `win.close()` does not bring it back
**Area:** build, data
**Trigger:** touching `app.on("will-quit")`/`app.on("before-quit")` in `src/main/index.ts`, anything in `src/main/windows/close-guard.ts` or `close-gate.ts`, or any cleanup that is supposed to run "on exit"; also before writing a CDP/automated test that closes the control window.

- **Claim:** `event.preventDefault()` inside `win.on("close")` does not *postpone* a quit, it
  **aborts** it. Electron stops the sequence there: no further windows are closed, `will-quit`
  never fires, and the app stays alive. Releasing the window afterwards with `win.close()` closes
  only that window — on macOS the app then lives on with no window at all, which looks exactly like
  a clean exit from the outside. To actually finish what the operator asked for, the answer has to
  call **`app.quit()` again**; `close-gate.ts` captures the intent in the pending close's `wasQuit` for
  precisely that reason.

- **What this cost, measured on 2026-09-14.** `closeDatabase()` was wired to `will-quit` (to
  checkpoint the WAL, `M27`). ⌘Q → guard vetoes → operator confirms → the app exits and everything
  looks right — but `worship.db-wal` (20 632 B) and `worship.db-shm` were still on disk afterwards,
  and a `console.log` at the top of the `will-quit` handler **never printed**. The database was
  never closed. The compounding bug was mine: the "I'm asking the operator" message cleared the
  same global `quitRequested` flag the later confirmation needed, so `allowClose` took the
  `win.close()` branch. After the fix, a clean exit **deletes** `-wal` and `-shm`, which is the
  observable signature of a real `sqlite.close()` on the last connection — that file pair
  surviving a quit is the fastest way to tell this regressed.

- **`window.close()` from the renderer does not fire the cancellable `close` event at all.** It
  tears the window down directly. Three attempts to exercise the guard through
  `Runtime.evaluate("window.close()")` over CDP all "passed straight through", and a `console.log`
  as the first statement of the `close` handler proved the handler simply never ran. Nothing in
  this app calls `window.close()`, so it is not a hole in the guard — but it **cannot be used to
  test one**. Drive the real path instead: `osascript -e 'tell application "System Events" to
  keystroke "q" using command down'` after making the app frontmost (`set frontmost of (first
  process whose name is "Electron") to true`). The same tool reads the menu back, which is how
  "Ventana has no Cerrar" (the Window menu has no Close item) was verified: `get name of menu items of menu 1 of menu bar item
  "Ventana" of menu bar 1` → `Minimizar, Zoom, missing value, Traer todo al frente`.

- **Consequence.** Quit-time cleanup belongs in `will-quit`, never `before-quit`, now that a close
  can be vetoed: `before-quit` fires while the operator is still reading the dialog and is free to
  answer "Cancel", so closing the database there would leave a perfectly alive app with no
  database. And whoever releases a vetoed close must resume the quit rather than close the window.
  Both halves are synchronous-only, for the reason in
  [nothing-asynchronous-survives-before-quit.md](nothing-asynchronous-survives-before-quit.md).

### Vetoing the control window's `close` was also too LATE (added 2026-10-14)

- **Believed:** vetoing the control window's `close` holds the quit until the operator answers.
  **True for the control window only.** By the time Electron delivers that `close`, it has already
  closed the projection window, which has no guard. Measured in the 2026-10-14 two-screen rehearsal:
  ⌘Q with an unsaved change, the dialog appeared, «Cancel» was clicked, and the app stayed alive
  with the toast «The projector window closed». The congregation's screen had gone dark behind
  a question whose answer was "don't". `shutdownSlides()` in `before-quit` had also already run,
  aborting the conversion in flight and the prewarm batch.
- **Fix:** `holdQuitUntilAnswered(event)` (`windows/close-guard.ts`), called first in `before-quit`.
  It `preventDefault()`s the quit itself while the control window is not cleared, then calls
  `win.close()` to start the existing guard. No window closes and no shutdown chore runs until the
  answer. "close" resumes with `app.quit()`; the second `before-quit` finds the window cleared and
  proceeds.
- **The renderer asks for two reasons now:** unsaved work, or something on air (an open projector
  with content, plates, BLACK or LOGO).
- **Known gap, left open on purpose:** once the renderer answers `hold`, the grace timer is gone.
  If the renderer dies while its dialog is up, main waits forever and only a force quit ends it.
  The 2026-10-14 driver produced it by `pkill`ing the renderer helpers. A real crash at that exact
  moment is rare.

**Last updated:** 2026-10-14
