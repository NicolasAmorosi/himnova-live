## With the stage open, `getAllWindows()[0]` is not the control window, and a programmatic move sends no `moved` on macOS
**Area:** build
**Trigger:** an E2E that moves, resizes or reads "the control window" from `app.electron.evaluate`; a test of what follows the operator's screen (`control-window.ts`'s `moved` → `syncStageWindow`, `displays-changed`); a window test that passes alone and does nothing with the stage screen assigned

- `BrowserWindow.getAllWindows()[0]` is the control window only while it is the only window. Measured 2026-11-14
  on the Mac with the stage screen assigned and the control window reloaded: the list was
  `["stage.html", "index.html"]`, so a test "moving the control window" moved the stage and asserted on nothing.
  Several older specs in `screens.spec.ts` still use `[0]` before any stage exists, which is why they work. Find
  the control window by its URL (`webContents.getURL().endsWith("/index.html")`).
- On macOS, `setBounds`/`setPosition` from code emits neither `move` nor `moved` (measured: zero events after
  moving the control window onto another display, though `getDisplayMatching` reported the new display). Only a
  real drag does. The app reacts to the operator's screen changing on `moved` alone, so a test of that reaction
  must emit it after moving: `control.emit("moved")`, which is what the OS sends when a drag ends.
- Both together made the test of "the control window dragged onto the stage's screen" fail twice for reasons
  unrelated to the code under test (`screens.spec.ts`, 2026-11-14).

**Last updated:** 2026-11-14
