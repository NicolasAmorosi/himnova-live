import { useMemo } from "react";
import { OutputView } from "@renderer/components/shared/output-view";
import { timerOutputFor } from "@renderer/lib/utility-output";
import { editorRestingClock } from "@shared/timer";
import { isCountdownTool } from "@shared/types/timer";
import { INSTANT_TRANSITION } from "@shared/types/projection";
import type { TimerClock } from "@shared/types/timer";
import type { SceneDraft } from "./scene-draft";

/**
 * The scene as the projector would draw it, while it is being edited.
 *
 * The SAME `OutputView` the projection window and both confidence monitors
 * use, fed by the SAME `timerOutputFor` — which is the whole point, and the
 * rule from `CLAUDE.md`: a preview drawn by a second, simpler renderer is a
 * preview that can disagree with the projector, and the operator would only
 * find out in front of the congregation.
 *
 * The clock is the scene's RESTING value, not the armed timer's: this is the
 * editor, and a countdown here should read as its full duration rather than as
 * whatever is running elsewhere. `editorRestingClock` and not `initialClock`,
 * because «countdown to time» rests at zero for the rest of the day once
 * its hour has gone by — and a preview that falls into the end state on its
 * own is a preview that answers a question the operator did not ask.
 * `INSTANT_TRANSITION` keeps `epoch` fixed, so `OutputView`'s `sameEpoch`
 * short-circuit means typing a title re-renders the text without ever running
 * a scene transition — the fade the end state carries is its own, and does
 * play here (see `TimerScene`).
 *
 * `atEnd` swaps that resting clock for a countdown HELD AT ZERO — which is not
 * a preview mode but the very state the projector rests in when the count runs
 * out, so the end message, its own type and the two hides are drawn by exactly
 * the code that will draw them on the night. Without it the whole «When the countdown
 * ends» group would be configured blind.
 *
 * Only the picture: the editor's `EditorStage` frames it.
 */
export function ScenePreview({ atEnd, draft }: { atEnd: boolean; draft: SceneDraft }) {
  const output = useMemo(() => {
    const scene = { ...draft, id: 0 };
    // Held rather than running: a preview that kept counting into overrun
    // would move while the operator is reading the very line they are typing.
    const clock: TimerClock =
      atEnd && isCountdownTool(draft.tool)
        ? { mode: "countdown", state: "held", remainingMs: 0 }
        : editorRestingClock(draft.tool, draft.config, Date.now());
    return {
      ...timerOutputFor(scene, clock),
      videoUnderlay: null,
      slideVideo: null,
      plates: [],
      transition: INSTANT_TRANSITION,
    };
  }, [atEnd, draft]);

  return <OutputView mode="preview" output={output} />;
}
