## A store field `selectOutput` reads must also be an input of `selectOutputMemo`, or the projector keeps a stale output
**Area:** projection
**Trigger:** adding a field to `projection.store.ts` that `selectOutput` (or a helper it calls, like `selectVideoUnderlay` or `logoKind`) reads; a setting that applies to the next scene but not to the one already live

- `selectOutputMemo` (`src/renderer/src/stores/projection.store.ts`) hands back the cached `ProjectionOutput`
  while every value in `outputInputs()` is `Object.is`-equal to the last call. `selectOutput` itself reads the
  whole state, so it can read a field the memo does not list — and then a change to ONLY that field returns
  the old object: no push, no new output, nothing on the projector.
- It shipped in 2.5.0: `videoEnd` (the «Al terminar un video» setting) fed `VideoUnderlay.loop`, but was not in
  `OutputInputs`. Choosing «Repetir en bucle» with a video already live did nothing until the next video. The
  unit test called `selectOutput`, not the memo, and the E2E chose the setting BEFORE sending the video live,
  so both passed. Fixed on 2026-11-05 (`97c33d1`) with `state.videoEnd === "loop"` as an input — the derived
  value, not the field, so «logo»/«black»/«hold» changes do not rebuild the output.
- So: every new field `selectOutput` depends on goes into `OutputInputs` and `outputInputs()` in the same
  change (the same for `logoScene`), and its test changes the field with something ALREADY live and reads
  `selectOutputMemo`, the path the app uses.

**Last updated:** 2026-11-05
