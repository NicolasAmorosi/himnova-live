## An offscreen shared-texture window hands out a texture only for a real frame — `invalidate()` makes none, and `stopPainting()` stops the page's clock
**Area:** projection
**Trigger:** touching `src/main/ndi/ndi-output.ts`, or any `BrowserWindow` with `webPreferences.offscreen: { useSharedTexture: true }` whose `paint` textures go somewhere (Electron 44)

- `webContents.invalidate()` does fire `paint` at once (+0 ms measured), but with a shared texture that event has **`event.texture === undefined`**. Electron's docs say it "generates a new one through the paint event"; it does not carry a frame. A still page then paints nothing more, so a receiver that connects to a still slide got nothing until something moved (9.7 s in one run). Measured 2026-11-09 on the Mac.
- `stopPainting()` with nobody watching looked like the cheap idle: it also **freezes the page's clock** — CSS transitions and the 300 ms crossfade stop where they are. The first frame after `startPainting()` was the picture from before the last change (the image while a video had been live for 6 s). Keep painting on: each texture released at once costs main ~nothing (phase 0, §6.2 of the NDI plan).
- What does yield a textured frame on demand: **`stopPainting(); startPainting();` back to back** (`drawFreshFrame()`), first frame in 0.01–0.05 s. Used for a first receiver and after a paint dropped while a frame was in flight (the last frame of a fade).
- Windows clamps even an offscreen window to the screen (1024×768 over SSH, 1920×1032 under a taskbar) and a frame eats into it: `frame: false`, `useContentSize: true` and **`setContentSize(w, h)` after creating it** (`enableLargerThanScreen` alone is not enough). And a hidden window created before the control window loads becomes Playwright's `firstWindow()` on Windows: create it on the control window's `did-finish-load`.
- Hold a texture only until it is read, never longer: Chromium's pool is small. One in flight; paints meanwhile are released.

**Last updated:** 2026-11-09
