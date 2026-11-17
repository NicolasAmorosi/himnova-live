## On Windows, an animation in a full-screen window on a screen slower than the primary blocks Chromium's GPU thread, and Chromium's video freezes
**Area:** projection
**Trigger:** a `<video>` that stalls or freezes (`readyState` 2, the position stuck) while the stage shows a message or a countdown; any CSS animation or transition added to `stage.html` or another full-screen window; choosing between Chromium and the media engine for a file on Windows

- Believed: a blinking red stage message is cheap, and a video freezing beside it must be the video's own fault.
  True (measured 2026-11-16 on the owner's PC: control on a 200 Hz primary, projector at 75 Hz, stage on a 60 Hz LG,
  RTX 4060 Ti): Chromium on Windows paces every window on the PRIMARY screen's vblank (`GpuVSyncThread`). A full-screen
  window on a slower screen that animates anything, even a 48 px box, is presented through a DXGI swap chain
  (`DXGISwapChainImageBacking::Present` in a `contentTracing` trace). Its queue fills, each present blocks ~14 to 16 ms,
  and `CrGpuMain` sits blocked 84 to 97% of the time. Chromium's `D3D11VideoDecoder::DoDecode` runs on that thread, so
  the room's `<video>` drops to `readyState` 2 and its position stops. The window showing the video uses
  `DCompSurfaceImageBacking` and never blocks; it starves anyway.
- It is not the stage's page: a bare `data:` full-screen window on the 60 Hz screen with a pulsing box froze it too.
  With the primary at 60 Hz nothing froze. Any PC whose primary is faster than the stage's screen is exposed.
- What did not work: `--enable-features=DXGISwapChainPresentInterval0` (that backing already presents at interval 0);
  `--fake-vsync-rate=60` (no freeze, but Windows' Sleep rounding runs the clock at ~57.5 Hz and every Chromium video
  drops ~2 frames a second, alert or not). Animating in steps (`step-end`) is clean only below about half the screen's
  refresh per window, and two animations add up: 30 changes a second on the 60 Hz LG were clean, 40 dropped frames,
  two out of phase at 30 froze. Not tried: `DXGIWaitableSwapChain`.
- What works: the media engine (libmpv, its own process, `d3d11va` on its own D3D11 device). Driven through the app's
  own buttons on the owner's PC (`drive-red.mjs` + `engine-all.mjs` in the maintainer's audit tools, 2026-11-16), the
  projector's engine canvas painted the same with the red message as without it: 30 a second for a 30 fps and for a
  60 fps file, 25 for the «Océano» song background (25 fps) while slides changed under it. So on Windows the engine
  plays every video (`ENGINE_PLAYS_EVERY_PICTURE` and `playsOnEngine` in `src/main/media/media-compat.ts`, owner's
  decision). A library `<audio>` stays on Chromium: with the red message up its position kept 1 s a second.
- The price: an engine source over 40 fps goes up at half its rate (`FramePacer`, owner 2026-11-10), so on Windows a
  60 fps file now shows at 30 where Chromium showed 60 (until a stage animation froze it).
- What still shows the block: with the red message up, the projector's `requestAnimationFrame` falls from 200 to ~155
  a second (~120 during a slide's fade) and the control window's to 60. The owner watched the 30 fps run and saw it
  smooth; the 60 fps file and the song were driven and measured with nobody watching.
- Measuring trap: reading the engine canvas back (`getImageData` every 10 ms) waits on the same blocked GPU thread. It
  dragged the projector's rAF to ~50 and a 60 fps file's painted frames to ~24, which looked like the engine losing
  frames. Count the page's own `drawImage` calls on the canvas instead (`canvas[data-frame-key]`).
- Never put a Chromium `<video>` back on air on Windows without this in mind, and measure a new stage animation with
  a video live on the owner's three screens. The E2E suite passes `--chromium-video` (its specs read `<video>`), so a
  green Windows run does not exercise this path; `media-engine.spec.ts` checks the switch with `--engine-video`.

**Last updated:** 2026-11-16
