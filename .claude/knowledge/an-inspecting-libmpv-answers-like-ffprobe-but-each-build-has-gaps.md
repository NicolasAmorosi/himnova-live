## An inspecting libmpv answers like ffprobe, but each build has gaps, and a gap comes back as a missing picture, not an error
**Area:** media (engine)
**Trigger:** touching `native/engine/inspect.cpp`, `src/main/media/engine-inspect.ts` or `parseProbe` in
`src/main/media/media-compat.ts`; a thumbnail or a pixel format missing on one system only.

- **Believed:** libmpv opens what FFmpeg opens, so the engine's `--inspect` mode (R14, 2026-11-18: FFmpeg left the
  app) would answer the same everywhere, and `vo=image` would write the thumbnail.

- **Measured** on 2026-11-18 with 48 files (every container and codec the app meets) through the old ffprobe path
  and the engine, macOS (our libmpv), Windows (shinchiro), Ubuntu 22.04 (libmpv 0.34, FFmpeg 4.4) and CachyOS
  (mpv 0.42): the same playback decision for all 48 on all four. What differed, each found the hard way:
  1. **`vo=image` needs an encoder, and the macOS libmpv has none** (`native/libmpv-mac/build.sh`,
     `--disable-encoders`). The picture comes from `screenshot-raw video` (an `mpv_node` with `w`, `h`, `stride`,
     `data`; `bgr0` is the only format mpv 0.34 gives, its fourth byte padding, set to 255), and main encodes the
     JPEG with `nativeImage.createFromBitmap(...).toJPEG()`: a few ms for 320 px.
  2. **Any `start`, 0 included, is a seek.** On a short MPEG-TS, `start=0` decoded no picture at all: no
     `video-dec-params`, no frame, exit 0. `start` is set only when above 0, and main asks again from 0 when the
     picture from 1 s does not come (`renderThumbnail` in `thumbnail-service.ts`).
  3. **The macOS libmpv had no dav1d.** An AV1 file loaded (format and tracks right) and decoded nothing: no pixel
     format, no thumbnail. FFmpeg's own `av1` decoder only drives hardware, and inspecting decodes in software.
     `native/libmpv-mac/build.sh` builds dav1d 1.5.4 into it since engine-11 (`--enable-libdav1d`); Windows' and
     the distros' libmpv already had it. `videoPlaysNatively` still treats AV1 with an unknown pixel format as
     Chromium's, the decision ffprobe gave, for a libmpv built without it.
  4. **EXIF orientation is FFmpeg's, by version.** FFmpeg 4.4 (Ubuntu 22.04) does not export it, so a portrait
     photo's thumbnail lies on its side there, as it did with `nativeImage`. FFmpeg 6.1 (Ubuntu 24.04), CachyOS's,
     the macOS and the Windows builds turn it upright.
  5. **mpv's names are not ffprobe's:** `file-format` says `mkv` for `matroska,webm`; `video-dec-params/pixelformat`
     drops the native-endian `le` (`yuv420p10`) and reads a JPEG-range `yuvj420p` as `yuv420p`; cover art is a
     video track flagged `albumart`. `parseProbe` maps them, so stored ffprobe rows and new ones decide the same
     (`MEDIA_PROBE_VERSION` stayed 2).

  6. **libavcodec's default threads froze what was on air.** Four inspecting engines decoding a 4K HEVC (a phone's
     video, from 1 s) stopped the playing engine for up to 1.8 s on Windows (its frame log: 36 frames in 5.7 s),
     spawned by the app or straight from a test alike; photos alone, none. Each decoder takes a thread per core
     (~17 on an i7-11700F), and a background priority alone made it worse (1.0 to 1.8 s, the burst twice as long).
     `vd-lavc-threads=1` removed the freeze and made the burst faster (8 videos in 1.4 to 2.9 s instead of 5.7);
     the background priority (`PROCESS_MODE_BACKGROUND_BEGIN`, `PRIO_DARWIN_BG`, nice 19, set before
     `mpv_create`) took the 7 remaining gaps of 55 to 90 ms away when photos and videos came together.
  7. **`screenshot-raw` has no alpha, so a transparent PNG came out on black** (`bgr0`'s fourth byte is padding):
     a dark logo vanished. The picture is laid on mid gray inside mpv's own filter chain, after the scale:
     `format=rgba,premultiply=inplace=1,lutrgb=a=negval,colorchannelmixer=ra=0.5:ga=0.5:ba=0.5,format=rgb24`, which
     is c·α + 127.5·(1−α) with filters FFmpeg 4.4 has; an opaque picture comes through unchanged (±2). **The final
     `format=rgb24` is not optional:** the chain leaves the inverted alpha behind (0 where the picture is opaque),
     newer mpv drops it from the screenshot, and mpv 0.34 (Ubuntu 22.04) applied it: every photo and video came out
     black there while the transparent logos were right, so the three systems we test on all passed. Found only by
     running the engine itself in an Ubuntu 22.04 container; `ffmpeg` 4.4 with the same chain was right.
  8. **On Windows each `spawn()` costs main 7 to 24 ms** (median 12): `CreateProcess` is synchronous. Twenty photos
     at once showed main gaps of 48 to 154 ms there, with no gap in what the room saw. A persistent inspector, or
     spawning from a worker, is the fix if it ever matters.

- **What it bought:** main's worst event-loop gap while a 12 MP photo's thumbnail is made, Linux: 107 to 160 ms
  with `nativeImage` in main, 25 ms with the engine; 20 photos at once, 313 ms to 22 ms. macOS 19 and 22 ms,
  Windows 19 and 48 ms. Each thumbnail costs an engine process start instead: 125 to 430 ms per photo, off main.
  What the room sees while 8 4K HEVC videos and 20 12 MP photos get thumbnails, from the playing engine's frame
  log: Linux went from 9 frames over 50 ms (worst 424 ms, main decoding photos) to none.

- **Consequence:** a new question for `--inspect` gets checked on every build, against a file that exercises it,
  and on the oldest libmpv the Linux engine loads: Ubuntu 22.04's 0.34, which `native/build.sh`'s
  `himnova-linux-engine-build` image already carries (`docker run` it with the built engine mounted). A missing
  `video` or `frame` in the answer is a normal reply (no decoder, no picture there), never an error.
  An engine that exits 1 with nothing on stdout (Linux with no libmpv) cannot inspect anything:
  `engine-inspect.ts` stops asking for the session (`cannotStart`).

Related: [nativeimage-thumbnail-blocking-and-generic-icon.md](nativeimage-thumbnail-blocking-and-generic-icon.md),
[a-linux-engine-built-on-debian-12-needs-glibc-2-36-and-libmpv-does-not-bring-libopengl.md](a-linux-engine-built-on-debian-12-needs-glibc-2-36-and-libmpv-does-not-bring-libopengl.md).

**Last updated:** 2026-11-18
