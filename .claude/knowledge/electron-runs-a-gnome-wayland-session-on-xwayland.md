## Electron 44 runs a GNOME Wayland session on XWayland, so X11 is the media engine's real Linux path
**Area:** projection
**Trigger:** testing the media engine (or anything GPU-shared, like `sharedTexture`) on Linux; an Electron that dies at launch with `ERROR:ui/aura/env.cc:246] The platform failed to initialize.  Exiting.`; deciding which Linux display path a fix or a test has to cover

- **What was assumed:** in a GNOME session, which is Wayland, the app runs as a Wayland client, so the engine's frames take the Wayland import path. **What is true:** the packaged app picks X11 and runs on XWayland. Measured on 2026-10-30 on CachyOS GNOME (Electron 44.3, the Linux package from `npm run package:linux`), with both `WAYLAND_DISPLAY` and `DISPLAY` set as a desktop session has them: the GPU process and the renderers carry `--ozone-platform=x11`.
- **With only `WAYLAND_DISPLAY` set**, as a hand-built environment over SSH tends to be, Electron does not fall back to Wayland. It dies at once with `The platform failed to initialize.  Exiting.`: a whole E2E pass failed that way, and it says nothing about the app.
- **Consequence:** XWayland is the case to test for a Linux user. Native Wayland only happens if forced (`--ozone-platform=wayland`) or if a future Electron changes its default. To test it, point `WORSHIP_E2E_EXECUTABLE` at a wrapper script that adds the flag. On 2026-10-30 `tests/e2e/conversion.spec.ts` passed 9/9 in both modes, with the engine's linear dmabufs.

**Last updated:** 2026-10-30
