## A looping engine video on Windows loses the 3rd frame from its end — and it is not the loop, nor the decoder
**Area:** projection
**Trigger:** agent8-04 (frames lost per wrap of a looping engine video on Windows), touching `loop-file`/`keep-open` in `native/engine/engine.cpp`, or `qa-fix-loop.spec.ts`

- Measured 2026-11-10 on the owner's Windows PC with a 90-frame barcode AVI (`ndi-loop.avi`, 3 s; ffprobe's `nb_frames=1800` is a wrong AVI header — count with `-count_frames`) looping live and `native/ndi-probe count` over NDI, which now prints `skip a->b` / `wrap a->b` on stderr: the frame lost is **87 of 0–89** (now and then 88 or one mid-file), on 5–6 wraps of 7. The wrap 89→0 itself is clean, and the timeline never stalls (600 fresh frames in 20 s): one frame just never reaches the receiver.
- Three engines, 3 runs × 7 wraps each, same result: mpv's `loop-file=inf` (engine-5); our own loop — `keep-open` with `keep-open-pause=no` and a seek to 0 on `eof-reached`, so the file really ends first; and `hwdec=no` (3–5 lost instead of 5–6). So it is neither the loop seek nor d3d11va: something on Windows when the demuxer reaches the end ~3 frames before the last one is shown, in the engine's render/emit or downstream of it (main, the NDI window's pacer, the sender's one-in-flight `offer`). The Mac loses 0–1 in 7.
- Not pursued further: one 33 ms frame at a point where the picture jumps from end to start anyway. Next step if it matters: stamp each `frame` event with mpv's `time-pos` in a QA build to see whether frame 87 ever leaves the engine.

**Last updated:** 2026-11-10
