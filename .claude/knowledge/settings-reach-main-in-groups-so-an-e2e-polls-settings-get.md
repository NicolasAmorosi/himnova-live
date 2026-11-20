## Settings reach main in groups, so an E2E polls `settings:get`

**Area:** renderer (`src/renderer/src/stores/settings.store.ts`), E2E
**Trigger:** an E2E that reads `settings:get` right after moving a control, a test that crashes the control page right
after launch, or anything that reads main's copy of what the control window just changed.

- Since 2026-11-20 (2026-11-15 audit, R16 and R24) the settings store merges at once but writes a burst as one
  `settings:set` every 300 ms (`PERSIST_EVERY_MS`); a lone change still goes at once. Main's copy can be up to 300 ms
  behind the window's. `quitRisks()` and `pagehide` flush, so a quit or a reload loses nothing.
- In the E2E: a read of `settings:get` right after a fader move or a toggle is `expect.poll`, never a plain `expect`.
  Three reads in `audio-strips.spec.ts` failed on Mac, Linux and Windows the first run after the change.
- The same shape, one level up: the control page gives main its live copy (`window:keepLiveCopy`) just after it is
  drawn. A test that crashed it right after the fixture saw EN VIVO got there first on Windows, and the page came
  back as a launch (drawn whole: a copy that fails to restore draws only an error), which says nothing. `control-recovery.spec.ts:490` waits for `window:liveCopy` first.
- Electron 45 rejects `executeJavaScript` on a page that is dying («Render frame was disposed before the request
  completed»); Electron 44 left it unanswered. A helper that reads a crashed page catches the rejection
  (`controlPage` in `control-recovery.spec.ts`). The app never calls `executeJavaScript`.

**Last updated:** 2026-11-20
