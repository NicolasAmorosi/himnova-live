## An engine taken over replays its last status, so a seek must rewrite it
**Area:** main (media engine)
**Trigger:** changing `MediaEngine.seek`, `retarget` or `takePreviewEngine`; anything that hands one engine process from
one session to another; a video that goes live and ends at once, with «Al terminar» putting the LOGO up

- GO LIVE on the video PREVIEW is showing does not start a new engine: `takePreviewEngine` (`engine-sessions.ts`)
  hands PREVIEW's process to the live session, seeks it to where the live video starts, and `retarget` replays
  `loadedInfo` and `lastStatus` so the new session knows where the engine stands without waiting for its next report.
- `lastStatus` is the engine's last report, not where it was just sent. A video parked at its end in PREVIEW had
  reported `ended: true`; the seek to 0:00 went out on the pipe, but `retarget` replayed «ended» before the engine
  answered, and the live session ended the video it had just started.
- It stayed hidden while the projector's push left after React drew: PREVIEW let the engine go first. Once the push
  left before the render (RR-01, `b54e6981`), GO LIVE took the engine first, and only the Windows E2E hit it
  (`settings.spec.ts:269`), on every run; the Mac never did.
- Fixed in `seek` (`52311bad`): the last status moves to where the engine was sent, without «ended», before the command
  goes out. Every caller of `seek` wants that; a later real report overwrites it. `tests/main/engine-retarget.test.ts`
  drives a fake engine that reports «ended» and fails without it (darwin only, a shell script plays the engine).
- Left open (owner, 2026-11-22 night): a video PREVIEW played to its end goes live with `startAtSeconds` at its
  duration, so there is no seek at all and it still ends at once (RN2-5); the fix would start it from 0:00.

**Last updated:** 2026-11-22
