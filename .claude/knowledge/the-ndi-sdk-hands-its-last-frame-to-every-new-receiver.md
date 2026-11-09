## The NDI SDK hands the last frame it sent to every new receiver, however old
**Area:** projection
**Trigger:** changing when the NDI output sends frames (`native/engine/ndi.cpp`'s send loop, `IDLE_FRAME_MS` in `src/main/ndi/ndi-output.ts`), or a receiver that shows an old picture for an instant on connecting

- An NDI sender with no connections that stops calling `send_send_video_v2` still keeps its last frame, and gives it to the next receiver **the moment it connects** (first frame in 0.01 s while the engine was sending nothing — measured 2026-11-09 with the engine driven by a C harness that went quiet).
- With "nothing sent while nobody watches" (to save the encoder's third of a core), that frame was the last one anybody saw — minutes old. OBS with DistroAV can disconnect a hidden source and reconnect it on a scene change, so that stale frame goes **on air**.
- What the output does instead: with no receivers, main offers a frame at most every 500 ms and the engine encodes each new one **once** (never repeated at the frame rate). The SDK's kept frame is never older than half a second, and a still page costs nothing. A first receiver then gets a fresh frame within a frame or two (see [the offscreen window's frames](an-offscreen-shared-texture-window-paints-a-texture-only-for-a-real-frame.md)).
- Encoding cost does not depend on the picture or on receivers (NDI plan §6.2): ~41 % of an M3 core at 1080p30 for BGRX, 37 % for UYVY, 45 % for NV12 — the conversion is not the cost, SpeedHQ is, so the texture stays BGRA and is sent as BGRX (no alpha plane).

**Last updated:** 2026-11-09
