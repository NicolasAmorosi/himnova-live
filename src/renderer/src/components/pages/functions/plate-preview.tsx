import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Button } from "@renderer/components/ui";
import { EditorStage } from "@renderer/components/shared/editor-screen";
import { OutputView } from "@renderer/components/shared/output-view";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { plateOutputFor } from "@renderer/lib/plate-output";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { platesCollide, type PlateStyle } from "@shared/types/overlay";
import type { PlateDraft } from "./plate-draft";

/** How long the plate stays off after «Test exit» before it comes back. */
const EXIT_TEST_REST_MS = 1000;

const NO_ANIMATION: PlateStyle["animation"] = { style: "none", durationMs: 0 };

/**
 * Where the animation test is. `PlateLayer` animates a plate when it MOUNTS
 * (entrance) and when it leaves the list (exit), so both tests are driven by
 * what this component hands it:
 *
 * - `shown`: the draft, as it is.
 * - `leaving`: no draft — the layer plays the exit.
 * - `reentering` / `returning`: the draft with its animation off, for ONE
 *   commit. A plate with no animation leaves and mounts instantly, which is
 *   what lets the entrance test take the plate down without an exit, and the
 *   exit test bring it back without an entrance. `reentering` then remounts it
 *   under a new `take` so the real entrance plays; `returning` keeps it.
 */
type Stage = "shown" | "leaving" | "reentering" | "returning";

/**
 * The plate being edited, drawn by the projector's own `OutputView` over what
 * is live right now — the other plates that are up included, so the operator
 * sees which one it would take down. The draft replaces the plate it collides
 * with (`platesCollide`), which is exactly what showing it would do.
 *
 * `mode="preview"`: muted, and never a scene transition, so typing a name
 * re-renders text without anything fading. Its two test buttons replay the
 * plate's own entrance and exit here only — nothing reaches the projector.
 *
 * It is the editor's whole canvas — the stage, the two tests under it and the
 * reason «Save» is off — because the tests drive the very state the picture is
 * drawn from.
 */
export function PlatePreview({ draft, id, warning }: { draft: PlateDraft; id: number | null; warning: string | undefined }) {
  const t = useT();
  const live = useProjectionStore(selectOutputMemo);
  const [stage, setStage] = useState<Stage>("shown");
  // Negative, so the drawn plate's key can never be a live plate's id.
  const [take, setTake] = useState(-1);

  // Layout effect, not effect: the one-commit stages must be replaced before
  // the browser paints them, or «Test entrance» flashes the plate at rest.
  useLayoutEffect(() => {
    if (stage === "reentering") setTake((current) => current - 1);
    if (stage === "reentering" || stage === "returning") setStage("shown");
  }, [stage]);

  useEffect(() => {
    if (stage !== "leaving") return;
    const timer = setTimeout(() => setStage("returning"), draft.style.animation.durationMs + EXIT_TEST_REST_MS);
    return () => clearTimeout(timer);
  }, [stage, draft.style.animation.durationMs]);

  const output = useMemo(() => {
    const others = live.plates.filter((p) => p.id !== id && !platesCollide(p, draft));
    if (stage === "leaving") return { ...live, plates: others };
    const plate = plateOutputFor({ ...draft, id: take });
    const still = stage === "shown" ? plate : { ...plate, style: { ...plate.style, animation: NO_ANIMATION } };
    return { ...live, plates: [...others, still] };
  }, [draft, id, live, stage, take]);

  const testable = draft.style.animation.style !== "none" && draft.style.animation.durationMs > 0;

  return (
    <EditorStage
      below={
        <>
          <Button disabled={!testable} onClick={() => setStage("reentering")} size="sm" variant="outline">
            {t("plates.testEnter")}
          </Button>
          <Button disabled={!testable || stage === "leaving"} onClick={() => setStage("leaving")} size="sm" variant="outline">
            {t("plates.testExit")}
          </Button>
          <span>{t("plates.previewHint")}</span>
        </>
      }
      warning={warning}
    >
      <OutputView mode="preview" output={output} />
    </EditorStage>
  );
}
