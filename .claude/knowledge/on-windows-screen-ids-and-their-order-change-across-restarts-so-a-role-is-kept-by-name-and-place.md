## On Windows, screen ids and their order change across restarts, so a screen's role is kept by its name and place
**Area:** projection
**Trigger:** a saved `projection.displayId` or `stage.displayId` that matches no screen after a restart; an E2E that assumes which row or number a screen gets in Settings ▸ Screens; anything keyed on `Display.id` across launches

- Believed: Electron's `Display.id` is stable for a monitor. Measured on the owner's Windows PC (three monitors,
  Electron 44): after the restart of 2026-11-18 all three ids changed (`115815580` became `989985988`, and so on), and
  after the one of 2026-11-19 they changed again (`3864087225`, ...) and `screen.getAllDisplays()` came back in another
  order: the operator's screen listed third, where it had been first. The same Electron build saw the new ids, so it is
  Windows, not Electron. Each monitor's `label` (`GS25F2`, `PHL 221V8`, `LG FULL HD`) and bounds stayed the same.
- Consequence up to 2.12.0: with three screens the stage stayed off (`chooseStageDisplay` found no screen with its id)
  and the projector took the first free screen in the OS's order, which could be the musicians'.
- What to do: each role keeps its screen's print (`DisplayPrint`, label and bounds) while that screen is connected, and
  main finds a lost id again by it, at launch and on every change of screens (`reconcileDisplayRoles` in
  `src/main/windows/projector-screen.ts`, the pure `recognizeDisplay` in `projector-display-choice.ts`). The size
  alone tells nothing apart (all three are 1920x1080); two monitors of one model need the place too; a screen with no
  name is never recognized, and anything less certain changes nothing.
- In an E2E, never assume a screen's row number in Settings or that the projector's row is «2»: read it
  (`projectorScreenRow` in `tests/e2e/screens.spec.ts`). `screens.spec.ts`'s roles test failed 3 of 3 against 2.12.0
  on that PC on 2026-11-19 for exactly that.

**Last updated:** 2026-11-19
