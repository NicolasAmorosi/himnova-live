## A picture cut on every edge of a projector is overscan, and a Windows screen reads in scaled units
**Area:** projection
**Trigger:** a church reports «the picture comes out cut on the projector» or «the app takes a weird resolution»; Settings shows a screen size no screen has (1536x864, 1280x720 on a 1920 panel); anyone proposing that the app set the screen's resolution

- **How it was told apart (2026-11-21).** From two phone photos, the LIVE monitor and the wall: eight landmarks
  (start of a word, a bee, the sun, a mouth, a flower) mapped through a homography from each photo's four corners to
  a unit square, then a scale and offset fitted per axis. Result: zoom 1.10 on BOTH axes, ~5 % lost on every edge
  (5.8/4.5 % horizontal, 4.5/5.5 % vertical), residual < 0.015. A window larger than its screen cuts the right and
  bottom only; an aspect or zoom mode cuts one axis. Even on four edges is the projector (or TV) overscanning a
  1920x1080 «TV timing», and the owner confirmed the Windows desktop was cut too. The app drew the whole picture:
  every image is `object-contain` in `OutputView`.
- **1536x864 was 1920x1080 at Windows' 125 %.** Electron's `Display.bounds` are DIPs. The label now says the mode in
  pixels plus the scale on Windows and Linux (`resolutionLabel`, «1920x1080 · 125 %»); on macOS, since 2026-11-25
  (owner), the pixels plus the points its own settings show («2940x1912 · se ve como 1470x956»); it kept the points
  alone until then. Rendering was never affected: Chromium draws at device pixels.
- **The app cannot fix it at the source.** Electron has no API to set a display mode (it would be native code per
  OS, changing the church's PC), and 1920x1080 overscans on that projector anyway. The fix that always works is the
  projector's own «overscan» menu; the app's is Settings ▸ Screens ▸ «Ajuste del proyector»: the picture laid out
  at 80–100 %, centred, per screen (`projection.fit`, keyed by name and mode in pixels, never by id), with a test
  pattern whose arrows touch each edge. Only the projector window gets it (`projector-fit`, pulled on mount like the
  snapshot); the monitors, the NDI copy and the stage never do.
- **Evidence for next time:** main.log has `[projector] full screen on «<name>» WxH at x,y, <pixels> px at <scale> %`
  per projector window, and a `the window is … its screen …` warning if a full-screen window does not cover its
  screen 3 s after showing.
- **Known limit, noted not fixed:** the pixel size is DIPs × scale, exact for 1920x1080 at 125/150/175 %. A mode whose
  DIP size is fractional (2560 at 150 % is 1706.67) can read one pixel off («2561x1440») and key its fit apart per
  scale. On Windows `screen.dipToScreenRect` might give it exactly; unverified, since only the Mac was at hand.

**Last updated:** 2026-11-25
