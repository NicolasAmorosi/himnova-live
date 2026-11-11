## mpv publishes `dwidth` only after its first frame renders, so a ring made on `VIDEO_RECONFIG` costs 200 ms of every first frame — and an MPEG-2's aspect is not in its container
**Area:** projection
**Trigger:** touching the ring creation or the event loop in `native/engine/engine.cpp`, or the time from GO LIVE to an engine video's first frame

- The engine made its texture ring when `VIDEO_RECONFIG` brought `dwidth`/`dheight`, and the render thread renders nothing without a ring. mpv's trace (`--log-level v`) showed the VO configured at ~183 ms, then nothing until `[vo/libmpv] mpv_render_context_render() not being called or stuck.` at ~393 ms: libmpv waits up to 200 ms for the first render before it publishes the size — a mutual wait. First frame ~465 ms after `load`.
- Observing the properties instead of `mpv_get_property` changed nothing (the hypothesis that the sync get blocked was wrong). Making the ring at `FILE_LOADED` from the container's size × `current-tracks/video/demux-par` (rotation from `demux-rotation`) did: first frame ~230 ms.
- **Only when `demux-par` exists.** An MPEG-2 (a DVD's `.mpg`/`.vob`) keeps its aspect in the stream: `demux-par` is unavailable and the container says 720×576 for a picture shown 1024×576 — a ring of that size letterboxes the picture inside it, smaller and windowboxed. Those files still wait for `dwidth` (slower, right). H.264 in AVI/TS, DV in AVI have it.
- Also learned there: mpv 0.41's `deinterlace` defaults to `no`; `auto` inserts `bwdif` only for frames flagged interlaced (`[userdeint] (disabled)` for a progressive one).

**Last updated:** 2026-11-10
