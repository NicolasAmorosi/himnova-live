## `nativeImage`'s two thumbnail routes are not interchangeable: one blocks the main thread, the other lies about what it returned
**Area:** renderer / main (media)
**Trigger:** touching `src/main/media/thumbnail-service.ts`, adding any image/video thumbnailing, or investigating a stutter in the projection window while the library grid is being browsed.

- **Believed:** `nativeImage.createFromPath(p).resize({width}).toJPEG(q)` is the obvious way to
  make a thumbnail, and `createThumbnailFromPath` is the special case needed only for video
  (its docs frame it as a video/document previewer). Both were assumed to be roughly equivalent
  in cost.

- **Measured** on 2026-09-11, macOS 15 (Darwin 25.6.0), Electron's own binary, against a real
  3840×2160 PNG (10 MB) and a 1280×720 MP4. A 10 ms heartbeat interval measured the worst gap
  between ticks — i.e. the longest the main thread (and therefore the projection window) was
  frozen:

  | route | 10× 4K PNG | worst main-thread stall |
  |---|---|---|
  | `createFromPath` + `resize` + `toJPEG` | 782 ms | the entire 782 ms — the heartbeat never ran at all |
  | same, with `setImmediate` between each | 814 ms | 192 ms |
  | `createThumbnailFromPath` | 35 ms | ~14 ms (idle baseline was 20 ms) |

  One 4K PNG costs ~80-110 ms synchronously on the first route. `createThumbnailFromPath` is the
  OS thumbnailer (QuickLook / the Windows shell), genuinely off-thread, and the OS caches it:
  first call ~118 ms, subsequent ones ~3.5 ms. It also decodes GIF (and by the same route WebP
  and HEIC), which `createFromPath` returns `isEmpty()` for.

- **Two traps in the fast route, both invisible from the docs:**
  1. For a file it cannot parse, it does **not** throw and is **not** empty — it returns the
     **generic Finder/Explorer document icon**, at 512×512, ignoring the `maxSize` that was
     passed. A corrupt `.png` therefore renders a macOS document icon inside the library tile.
  2. `image.getSize()` reports the size that was *requested*, not the bitmap that came back:
     asked for `{width:320,height:320}` it answers `320×320` for an image whose real JPEG is
     `320×180`. It cannot be used to detect trap 1, or for anything else.

  The only honest source is the encoded bytes. `readJpegSize()` in
  `src/main/media/thumbnail-service.ts` walks the JPEG's SOF marker for the real dimensions, and
  `renderViaOsThumbnailer` rejects any result that exceeds the requested `maxSize` — that
  overflow *is* the signal that an icon was substituted for a thumbnail.

- **Consequence.** Prefer `createThumbnailFromPath` for images as well as video, keep
  `createFromPath` + `resize` only as the Linux/declined-file fallback, and never trust
  `getSize()` on a thumbnailer result. A synchronous decode of library media on the main thread
  is the same class of mistake as the full-file read in
  [prewarm-lru-grace-and-linked-audio-full-file-read.md](prewarm-lru-grace-and-linked-audio-full-file-read.md):
  it is invisible in development with three files and freezes the projector with six hundred.
  The 404 that a rejected thumbnail produces is deliberate — the renderer paints the fallback
  with its own theme tokens (`asset-tile.tsx`'s `resolveThumbUrl`), which is also why the
  thumbnail URL must carry a cache-buster
  ([stable-capability-url-needs-a-cache-buster-to-refresh.md](stable-capability-url-needs-a-cache-buster-to-refresh.md)).

- **Superseded on 2026-11-18 (R14).** Neither route makes thumbnails any more: the media engine draws every one
  (`--inspect --frame`) and main only encodes its pixels. The measurements above stay as the reason a decode never
  runs in main; what the engine does instead is in
  [an-inspecting-libmpv-answers-like-ffprobe-but-each-build-has-gaps.md](an-inspecting-libmpv-answers-like-ffprobe-but-each-build-has-gaps.md).

**Last updated:** 2026-11-18
