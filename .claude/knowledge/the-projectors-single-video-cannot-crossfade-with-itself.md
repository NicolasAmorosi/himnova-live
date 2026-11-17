## The projector's single persistent `<video>` cannot crossfade with itself — and `videoRole` hands the OUTGOING role to the INCOMING element

**Area:** renderer / projection (`src/renderer/src/components/shared/output-view.tsx`,
`src/renderer/src/lib/actions/playback.ts`)
**Trigger:** any report that a projection transition "doesn't do what Settings says" or "always goes
through black"; before touching `videoRole`, `SceneLayer`, `LiveVideo` or the `key` on the
persistent `<video>`; before adding a new `TransitionStyle`.

Found on 2026-09-13 from a field report: with **crossfade (`crossfade`, 300 ms)** configured,
going live with a video while another video is live never crosses — it goes to black and back.

### The mechanism

`OutputView` keeps **one** `<video>`, outside the scene layers and keyed by
`output.videoUnderlay.epoch`. That is deliberate: it is what lets BLACK/LOGO *cover* a video without
unmounting the element, because repeatedly tearing down and rebuilding it is what produces
`PIPELINE_ERROR_DECODE (-12909)` (see
[worship-protocol-range-and-video-lifecycle.md](worship-protocol-range-and-video-lifecycle.md)).

A single element still has to know which side of a transition it is on, and `videoRole` decides:

```ts
layers.length < 2            ? "steady"
: layers[0]?.output.kind === "video" ? "leaving"    // evaluated FIRST
: layers[1]?.output.kind === "video" ? "entering"
: "steady";
```

On **video → video both branches are true**, and the first wins. But the element in the DOM is not
the outgoing one: `videoEpoch += 1` on every video go-live (`playback.ts`) re-keys the component, so
the old element is already gone and the **new** video is the one that gets `"leaving"` — i.e. the
fade-**out** keyframe. With `animation-fill-mode: both` it then sits pinned at opacity 0 until the
outgoing layer is dropped, at which point `videoRole` returns to `"steady"` and it snaps back to 1.

Both scene layers paint nothing in this case (`opaque = output.kind !== "video"` is false for both,
and `OutputScene` draws nothing for `kind: "video"`), so the black exposed underneath is
`OutputView`'s own `bg-black`.

Measured inside the projection window, sampling computed style per rAF (crossfade, 300 ms):

```
   0 ms | vid17  animation=none        opacity=1.000  z=1   ← video A, steady
5641 ms | vid8   animation=fade-out    opacity=1.000  z=0   ← A gone from the DOM; B mounts with the EXIT fade
5841 ms | vid8   animation=fade-out    opacity=0.232  z=0
5908 ms | vid8   animation=fade-out    opacity=0.024  z=0   ← the NEW video, nearly invisible
5974 ms | vid8   animation=none        opacity=1.000  z=1   ← hard pop
```

Cut, reverse fade, pop. It is not a crossfade with the wrong duration — it is the wrong element
playing the wrong half.

**Not style-specific:** `fade-through-black` maps the same `"leaving"` role to
`wa-scene-out-then-black`, which holds 0 for the second half, so the pop is worse.
**Not even change-specific:** the epoch bumps on *every* go-live, so re-sending the *same* video live
reproduces it.

### The other three combinations are fine — measured, not assumed

| Transition | What actually happens |
|---|---|
| image → video | real crossfade: image layer 1→0 at `z=0`, `<video>` 0→1 at `z=2`, simultaneous |
| video → image | the `<video>` unmounts in the same frame (`videoUnderlay` goes `null`), then the image layer fades in from black. The video's own pixels never fade — **a known, documented limit**, written in `OutputView`'s own comment |
| video → video | broken, above |

That table is the reason this is a one-branch bug and not an architecture problem.

### How to fix it, and what not to do

- **One line, today:** evaluate `layers[1]` (incoming) *before* `layers[0]` in `videoRole`. The new
  video then fades **in** from black and stops popping. Still through black, but no longer inverted.
- **The real fix:** freeze the outgoing video's last frame into the outgoing layer (draw it to a
  `<canvas>`/`ImageBitmap` at the moment the new output arrives, before the old element unmounts) and
  let the incoming `<video>` fade in over it. A real crossfade with **one live decoder**, which is
  what the current architecture exists to protect. 300 ms of a frozen frame is indistinguishable
  from a moving one on the half that is leaving.
- **Do not** remove `key={epoch}` to "reuse the element across videos". Swapping `src` on a playing
  element is the exact churn that produced `PIPELINE_ERROR_DECODE` here before.
- Mounting two `<video>` elements (one per layer — each `layer.output` already carries its own
  `videoUnderlay`) also works, but pays two simultaneous decoders for `durationMs` and has to keep
  the persistent element from remounting on a BLACK/LOGO toggle.

The LIVE monitor animates too (`mode === "monitor"`), so it shows the same defect — the monitor is
not lying, it is faithfully reproducing a broken projector.

Full report, all measurements, and the fix options in
the internal field-bug report of 2026-09-13
(`F2`).

**Last updated:** 2026-09-13

---

### Resolved 2026-09-14 — the frozen frame, and the one place the pixels are still reachable

Both halves of the recommended fix are in: `videoRole` now asks the **incoming** layer first (the
mounted element is always the one belonging to the output that just arrived, by construction), and
the side that leaves is a still of the outgoing video's last frame.

The non-obvious part is **where** that frame can be captured. By the time `OutputView`'s layer
effect runs, the old `<video>` is gone: React has already committed the re-key, and a passive
effect runs after the browser has painted the frame where the element simply is not there. The only
hook that still reaches it is a **`useLayoutEffect` cleanup with empty deps inside `LiveVideo`** —
layout cleanups run in the mutation phase, in the same commit that removes the node, while it still
holds decoded pixels. Two details make it reliable:

- read the element from a ref that is **never nulled** (`lastElementRef`), because React detaches
  the `ref` callback in that same phase;
- the capture must be a `<canvas>` + `drawImage` and the canvas node mounted directly
  (`FrozenFrame` uses `replaceChildren` in a layout effect). `toDataURL` is tens of milliseconds of
  synchronous work at the exact instant a transition starts; `drawImage` is a blit. A fresh canvas
  per capture, so a transition arriving mid-flight cannot repaint the frame the previous one is
  still fading out. Nothing ever reads the canvas back, so the cross-origin taint `worship://`
  causes is irrelevant.

`SceneLayer`'s `opaque` had to learn about it too: a video layer is normally transparent so the
persistent `<video>` shows through, but one holding a frozen frame **is** the picture and needs
black behind it for `object-contain` letterboxing.

Measured on the LIVE monitor (same `OutputView`, and the only surface that can be measured — the
projection window is occluded behind the control window and runs no rAF, see
[occluded-electron-window-has-no-rendering-lifecycle.md](occluded-electron-window-has-no-rendering-lifecycle.md)).
Video A (epoch 1) → video B (epoch 2), crossfade 300 ms, both confirmed `kind: "video"` through
`projection:getSnapshot`:

```
  27 ms | capa[FRAME 3840x2160] fade-out 1.000  ·  video fade-in 0.000
 159 ms | capa[FRAME 3840x2160] fade-out 0.614  ·  video fade-in 0.386
 309 ms | capa[FRAME 3840x2160] fade-out 0.009  ·  video fade-in 0.991
 349 ms | steady 1.000                          ·  video steady 1.000
```

Simultaneous, complementary, no black and no pop — against `1.000 → 0.024 → pop to 1.000` before.
It also fixes **video → image**, which this entry's table listed as a documented limitation: that
side now has real pixels to fade out too.

**Last updated:** 2026-09-14

---

### Still a black frame until 2026-10-23 — the measurement above started 27 ms too late

A field report after launch: «se pierde un frame o se ve un frame negro», mostly with videos. The
2026-09-14 table's first sample is at 27 ms, and the frame was before it.

**How it was seen.** Per-frame truth is the compositor, not the DOM: a CDP screencast of the
projection window (`Page.startScreencast`, 240×135 JPEG, ack every frame) piped through the bundled
FFmpeg as MJPEG with `scale=1:1:flags=area` gives one mean-luma byte per painted frame
(`brightnessDuring` in `tests/e2e/media.spec.ts`). Leaving a video, before the fix:

```
video → image   131 | 0 (20 ms) | 115 … 87 … 116      black frame in 10 of 12 runs
image → video   116 … 95 … 131                         the dip, every crossfade
```

A rAF DOM probe running at the same time made the black frame **disappear** (0 of 8) — it shifted
the timing of the race it was meant to observe. Never trust a per-frame probe that runs inside the
page it measures.

**Cause 1, the black frame.** `LiveVideo` reads `output.videoUnderlay` straight from props, while
the scene layers only change in `OutputView`'s layer effect. On the render that delivers the new
scene the old `<video>` is already unmounted and `layers` still holds only the old, transparent
video layer with no frozen frame. That effect was a `useEffect`, and a projector push arrives over
IPC — not a discrete event — so React runs it after the browser may already have painted that
render. Now a `useLayoutEffect`: its `setState` re-renders synchronously before paint (0 black
frames in 24 runs). The frame capture still works, because the `<video>`'s layout cleanup runs in
the mutation phase of the same commit, before the parent's layout effects.

**Cause 2, the dip.** «Crossfade» faded the incoming layer in AND the outgoing one out, so the
black behind both showed through: `αB + (1−α)²A`, 75% brightness at the midpoint for two equal
pictures. Between opaque scenes the leaving side now holds (`wa-scene-hold`, `incomingCovers` in
`transitionStyle`), and the `<video>` got `bg-black` so a letterboxed one also covers the stage. A
time scene's text blocks are transparent and still fade both ways.

**Left as is:** the frozen frame of an **untagged SD** video draws darker than the video itself
(the test clip: 131 live, 116 as a `drawImage` copy — the canvas and the compositor pick different
YUV matrices for an untagged stream). A BT.709-tagged 1080p clip matched (117 vs 116). It only
shows during the 300 ms the frame fades out.

**Last updated:** 2026-10-23
