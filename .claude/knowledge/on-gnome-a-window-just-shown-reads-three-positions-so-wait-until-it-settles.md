## On GNOME, a window just shown reads three positions in ~30 ms, so wait until it settles before asserting where it is
**Area:** build
**Trigger:** an E2E on Linux that reads a window's bounds right after showing or moving it (`getBounds()`, `projectorWindow()`); a position check that fails most of the time on CachyOS and never on the Mac or Windows

- Believed: after `show()` the bounds are the ones asked for. Measured on CachyOS (GNOME on X11 through XWayland,
  scale 2.0, 2026-11-18): within ~30 ms of showing, the windowed projector read the requested position, then 0,0,
  then its final one. `screens.spec.ts:90` failed 17 of 20, in the branch and in `main` alike: the test, not the app.
- The final position is not the requested one either: GNOME puts its own title bar (32 px) where the window was
  asked to go, and the app centres the content, not the frame, so the bounds sat 46.5 px low.
- What to do: read twice 100 ms apart inside `expect(...).toPass()` and assert only once both agree
  (`expectMovableOnControlScreen` in `tests/e2e/screens.spec.ts`), with a y tolerance that covers a window manager's
  title bar (64 px there; the corner A14 guards against is 164 px off). 20 of 20 after.
- Related: [Electron runs a GNOME Wayland session on XWayland](electron-runs-a-gnome-wayland-session-on-xwayland.md).

**Last updated:** 2026-11-18
