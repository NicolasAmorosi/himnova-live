## libmpv drops the video track of a file loaded before its render context exists, and plays only the sound
**Area:** projection
**Trigger:** a media-engine file that plays its sound with no picture, a `loaded` event with `hasVideo: false` for a file that has video, the error `No video or audio streams selected`, or touching the `load` command in `native/engine/engine.cpp`

- **What was assumed:** `loadfile` can be sent as soon as `mpv_initialize()` returns; the render context (`mpv_render_context_create`, made on the render thread after the GPU device) can come a moment later. **What is true:** with `vo=libmpv`, a file whose video starts before the render context exists gets its video track deselected. mpv finds no VO to give it to, plays the audio, and never re-selects the video.
- **The evidence (2026-10-30, macOS, libmpv 0.41.0):** the first smoke test of `src/main/media/media-engine.ts` sent `load` right after spawning the engine.
  - A WMV played its sound for 10 s with `hasVideo: false` and not a single frame.
  - A silent MP4 failed outright: `engine-open`, `[cplayer] No video or audio streams selected`.
  - The spikes never hit this, because they created the render context first and only then loaded a file.
- **The fix:** `E.started` turns 1 once the render context exists (-1 if the GPU failed). The `load` command waits for it. A spare engine is started ahead of time, so the wait normally costs nothing.
- **Also:** at `MPV_EVENT_FILE_LOADED`, `dwidth`/`dheight` are still 0. The picture's displayed size only exists at the first `MPV_EVENT_VIDEO_RECONFIG`, which is where the engine sizes its ring.

**Last updated:** 2026-10-30
