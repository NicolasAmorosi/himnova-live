import { useMemo } from "react";
import { MediaTrackRow } from "@renderer/components/shared/media-track-row";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { useTimerNow } from "@renderer/lib/hooks/use-timer-now";
import { resetTimer, seekTimer, toggleTimer } from "@renderer/lib/actions/utility";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { clockForScene, useUtilityStore } from "@renderer/stores/utility.store";
import { countdownElapsedSeconds, formatTimerClock, hasReachedZero, isTimerRunning } from "@shared/timer";
import type { UtilityScene } from "@shared/types/utility";

const MS_PER_SECOND = 1_000;

type UtilityTrackRowProps = {
  /** Takes the scene off THIS column — the projector for the LIVE row, the
   *  preview cursor for the centre one. The only prop that differs between the
   *  two, which is the point: everything else about a time scene reads and
   *  behaves identically wherever the row is. */
  onDelete: () => void;
  /** The LIVE panel's row: `onDelete` takes it off the projector. */
  offAir?: boolean;
  scene: UtilityScene;
};

/**
 * A time scene as a row of the media transport — the whole control surface of
 * a countdown, a clock or a stopwatch, in the two columns where the operator
 * is already looking.
 *
 * It is rendered by `LiveMediaPanel` and by the centre column's preview bar,
 * with the same controls in both, so a scene can be driven before it is
 * projected and after it is. `clockForScene` is what makes that safe: the two
 * rows can be on screen at once for the same scene, and both read the
 * projector's copy of the clock when there is one, so they can never show two
 * numbers for one timer.
 *
 * ## Which tool gets which control
 *
 * - **Pause and restart** belong to the two tools that have something to
 *   start: `countdown` and `stopwatch`. A wall clock and a countdown to a time
 *   of day are always running by definition, and a disabled play button is an
 *   invitation to press something that cannot mean anything.
 * - **The seek bar** belongs to `countdown` alone — the only tool with a total
 *   for a position to be inside. A stopwatch and a clock have no end; a
 *   countdown to a time of day has no start, and dragging it would mean
 *   editing the scene's target hour, which is the editor's job.
 * - **The readout** belongs to all four, because every one of them is a number
 *   the operator has to be able to read without looking at the projector.
 */
export function UtilityTrackRow({ offAir = false, onDelete, scene }: UtilityTrackRowProps) {
  const t = useT();
  const base = useProjectionStore((s) => s.base);
  const run = useUtilityStore((s) => s.run);

  // Memoized, and load-bearing rather than an optimization: for a scene with
  // no clock of its own `clockForScene` builds a fresh object, and
  // `useTimerNow` below sets state on every tick. Without a stable identity
  // the tick would change that effect's dependency, which would re-arm the
  // tick, which would set state again — a hot loop rather than one re-render
  // per second.
  //
  // Resolving against today's midnight instead of the current instant is what
  // keeps the memo honest: an un-armed "countdown to 10:00" depends on the
  // DATE and nothing finer, so this is stable through every tick and still
  // re-resolves for an app that was left open overnight.
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const clock = useMemo(() => clockForScene(base, run, scene, startOfDay), [base, run, scene, startOfDay]);

  const now = useTimerNow(clock, scene.config.format);
  const running = isTimerRunning(clock);
  const ended = hasReachedZero(clock, now);
  // START or RESUME: the bit `TimerClock` does not carry. A live scene
  // was started on its way to the projector (`ensureStarted`), even after the
  // armed slot has moved on to another scene.
  const started = run?.sceneId === scene.id ? run.started : base?.kind === "utility" && base.sceneId === scene.id;
  const hasTransport = scene.tool === "countdown" || scene.tool === "stopwatch";
  const hasBar = scene.tool === "countdown";

  return (
    <MediaTrackRow
      currentSeconds={hasBar ? countdownElapsedSeconds(clock, now, scene.config.durationMs) : 0}
      durationSeconds={hasBar ? scene.config.durationMs / MS_PER_SECOND : undefined}
      kind="utility"
      label={scene.name}
      offAir={offAir}
      onDelete={onDelete}
      onRestart={hasTransport ? () => resetTimer(scene) : undefined}
      onSeek={
        hasBar ? (seconds) => seekTimer(scene, scene.config.durationMs - seconds * MS_PER_SECOND) : undefined
      }
      onTogglePause={hasTransport ? () => toggleTimer(scene) : undefined}
      pauseLabel={t("utilities.pause")}
      paused={!running}
      playLabel={started ? t("utilities.resume") : t("utilities.start")}
      readout={formatTimerClock(clock, now, scene.config.format)}
      readoutNote={ended ? t("utilities.finished") : undefined}
      readoutTone={ended ? "danger" : running ? "default" : "muted"}
    />
  );
}
