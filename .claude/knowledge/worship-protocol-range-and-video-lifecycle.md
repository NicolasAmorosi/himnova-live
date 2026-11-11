## `worship://` needs real Range support — and the projector's `<video>` lifecycle

**Area:** main (`protocol/worship-protocol.ts`, `serveFile` in `protocol/serve-file.ts`) | renderer (`components/shared/output-view.tsx`,
`stores/projection.store.ts`, `shared/types/projection.ts`)
**Trigger:** Any report of "the video plays for a second and freezes", a video that won't play
after a few tries, broken/impossible seeking, a video progress bar that can't scrub, or before
touching `serveFile`, the `<video>` element, or the BLACK/LOGO overlay path.

Found in the 2026-09-08 session. **Read this before blaming Electron, the GPU or the codec** —
the first two hypotheses in that session (hardware-decoder session churn; a React remount race)
were both wrong-or-incomplete, and only measuring the element proved the real cause.

### The bug: `serveFile` ignored the request's `Range` header

`serveFile` used to delegate to `net.fetch(pathToFileURL(filePath), …)` **without forwarding the
request headers**, so every request was answered `200` with the whole file, no matter what byte
range Chromium asked for. The old source comment claiming "net.fetch's own Range handling is
what lets `<video>`/`<audio>` seek" was simply false.

Two consequences, one cosmetic and one severe:

1. **Seeking was structurally impossible** for every video and audio file in the app. The media
   element reported an *empty* seekable range.
2. **Playback died with a decode error.** Whenever Chromium's media pipeline re-requested at an
   offset — after the element was recreated, or once its media cache held only part of a large
   file — it received bytes from offset 0 while believing they belonged at the offset it asked
   for. The decoder was fed misaligned data and failed with
   `PIPELINE_ERROR_DECODE: … Code=-12909 … VTDecompressionOutputCallback`
   (`kVTVideoDecoderBadDataErr`). Symptom: the video plays ~1 s, freezes, and never recovers
   until the app restarts. Reproducibly by the **third** play of a 2.36 GB file, and immediately
   when interleaving video ↔ PowerPoint (more re-reads ⇒ more misalignment).

### The measurement that settles it

This one read distinguishes "source can't seek" from every other theory. Run it in the
projection window while a video is live:

```js
const v = document.querySelector("video");
({ duration: v.duration,
   seekable: v.seekable.length ? [v.seekable.start(0), v.seekable.end(0)] : [],
   buffered: v.buffered.length ? [v.buffered.start(0), v.buffered.end(0)] : [],
   err: v.error && v.error.message })
```

- Broken: `seekable: [0, 0]` — the source is not seekable at all.
- Correct: `seekable: [0, <duration>]`.

Note `video.error.message` is **only** on the element. It never reaches the terminal, which is
why the operator sees no error at all. The
`sysctlbyname for kern.hv_vmm_present failed with status -1` line that keeps getting blamed is
benign Chromium hypervisor-probe noise, printed once at launch before any video exists.

### The fix

`serveFile(request, filePath, extraHeaders?)` now implements range semantics itself and no
longer uses `net.fetch` at all:

- parses `Range` (`bytes=a-b`, `bytes=a-`, suffix `bytes=-n`); `416` + `Content-Range: bytes */size`
  for an unsatisfiable one
- `206` with `Content-Range` and `Content-Length` for a partial request, `200` with
  `Content-Length` otherwise; **`Accept-Ranges: bytes` on both** — without it Chromium never even
  attempts a range request and treats the stream as unseekable
- bodies stream via `fs.createReadStream(path, {start, end})` → `Readable.toWeb()`; cancellation
  propagates, so no fd leak (verified with `lsof` after many plays: one fd, the live stream)
- an explicit MIME table replaces `net.fetch`'s sniffing. **Unknown extension ⇒ omit
  `Content-Type` entirely** rather than assert `application/octet-stream`, which would make
  Chromium refuse an otherwise playable file. Every extension in `ASSET_EXTENSIONS` is covered.
- `HEAD` returns headers with no body; `stat` replaced a synchronous `existsSync` (no sync IO on
  main's event loop during a service)

**Every route goes through it** (`asset`, `logo`, `deck`, `deck-audio`, `raster`), so adding a
route means passing `request` through too.

### The projector's `<video>` lifecycle (`output-view.tsx`)

`selectOutput` collapses to `{kind:"black"}`/`{kind:"logo"}` when an overlay is up, which throws
away the fact that a video is the *base* content. `ProjectionOutput` therefore carries a
`videoUnderlay: {url, epoch} | null` field on **every** variant, computed straight from
`state.base` and independent of the overlay (`ProjectionOutputKind` is the union; the exported
`ProjectionOutput` intersects it with that field). It exists so the element can stay mounted
under an overlay instead of being destroyed and rebuilt on every BLACK/LIVE toggle.

The `LiveVideo` component owns the resulting rules:

- **Mounted while `videoUnderlay` is non-null**, hidden with `hidden` (not unmounted) when
  covered. It unmounts only when the base genuinely stops being that video (a deck, an image,
  CLEAR).
- **Keyed by `epoch`**, so pressing GO LIVE again on the same video restarts it from the
  beginning — but an overlay toggle never changes the key.
- **BLACK/LOGO pauses it and holds its position; uncovering resumes from there.** This is
  product-decided operator behaviour (asked for explicitly). `autoPlay` only applies to a
  freshly loaded element, so the transitions are driven imperatively in an effect.
  **Update (2026-09-09):** a deck's own soundtrack now follows the same rule too (see
  `projection-sync.ts`'s `toAudioTrackPush` and `deck-autoplay.ts`'s `isFrozenByCover`). Only a
  standalone audio asset sent live is still meant to keep playing through an overlay.
- `useMediaStatusReporter` is keyed off `videoUnderlay?.epoch`, not `output.kind === "video"`, so
  it doesn't tear its listeners down every time an overlay covers the video.

### How this was verified (reuse it)

Driven against the running app over CDP (`--remote-debugging-port=9222`, raw `WebSocket`, see
root `HANDOFF.md` for the technique). The scenarios that must stay green:

| Scenario | Was |
|---|---|
| 4 consecutive GO LIVE presses on the same video | died on the 3rd |
| 4 rounds of video ↔ PowerPoint | died on the 1st |
| BLACK/LOGO pause → hold position → resume | ran on unseen behind the overlay |
| 8 rounds mixing overlays, replays and the PPT | — |
| seek to mid-file and keep playing | impossible (`seekable: [0,0]`) |
| PPT slides still decode (WebP, 1920×1080) | — |

**Last updated:** 2026-09-08
