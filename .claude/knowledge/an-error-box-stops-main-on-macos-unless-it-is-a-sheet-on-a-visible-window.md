## An error box stops main on macOS unless it is a sheet on a visible window, and the async API does not change that
**Area:** main process
**Trigger:** showing any dialog from main (`dialog.showErrorBox`, `dialog.showMessageBox`, `reportCrash` in `main/index.ts`), above all one that can appear mid-service

- **Measured 2026-11-15 (audit probes `sonda-errorbox`, `sonda-messagebox`, Electron 44 on an M3):** from the moment `showErrorBox` opens until somebody clicks, main serves nothing: 0 timer ticks and 0 IPC. GO LIVE, NEGRO and LOGO are IPC, and the engine's frames and the NDI output's paints go through main, so the picture freezes while the engine's sound goes on.
- **`showMessageBox` without a parent is no better on macOS**, although it returns a promise: with no visible parent Electron runs it with `runModal`, and the call does not even return (0 ticks, 0 IPC).
- **With the visible control window as parent it is a sheet, and main keeps running:** 64 ticks and 75 IPC in 3.8 s, one pause of ~0.4 s as the sheet opens. A hidden or minimized parent falls back to the blocking box. Windows (where the async box runs on another thread) and Linux were not measured.
- **What the app does since (audit A23):** `reportCrash` shows a sheet on the control window when it is alive and visible, and `showErrorBox` only before there is one (a failed start). E2E: `robustness.spec.ts`, «an uncaught error in main is said in a box that leaves main serving the control window».

**Last updated:** 2026-11-16
