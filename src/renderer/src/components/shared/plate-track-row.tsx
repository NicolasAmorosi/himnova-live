import { MediaTrackRow } from "@renderer/components/shared/media-track-row";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { useTimerNow } from "@renderer/lib/hooks/use-timer-now";
import { goLive } from "@renderer/lib/actions/playback";
import { hidePlate } from "@renderer/lib/actions/overlays";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { countdownElapsedSeconds } from "@shared/timer";
import { DEFAULT_TIMER_FORMAT, type TimerClock } from "@shared/types/timer";
import type { Plate } from "@shared/types/overlay";

/** A clock that never ticks, for a plate with no auto-hide — `useTimerNow`
 *  cannot be called behind a branch, and a held clock arms no timer. */
const NO_CLOCK: TimerClock = { mode: "countdown", state: "held", remainingMs: 0 };

type PlateTrackRowProps = {
  /** Takes the plate off THIS column: the preview cursor under PREVIEW, the
   *  projector in the LIVE panel. */
  onDelete: () => void;
  /** The LIVE panel's row: `onDelete` takes it off the projector. */
  offAir?: boolean;
  plate: Plate;
  /** The preview row only: its own GO LIVE, or «Hide» once it is up. The
   *  LIVE row's X already takes it down, and a second button doing the same
   *  would be noise. */
  withLiveButton?: boolean;
};

/**
 * A plate as a row of the media transport, under the PREVIEW monitor and in
 * the LIVE media panel. Both read the same live state, so they can never
 * disagree on whether it is up, covered, or how long it has left.
 *
 * «Covered» is spelled out on the row because the stage cannot say it: a plate
 * that is up under BLACK, LOGO or an empty stage is invisible to the room, and
 * one sent while covered stays invisible until the stage is uncovered.
 *
 * A plate that hides itself carries the video rows' transport line: how long
 * it has been up, a read-only bar, and its total. Before it goes up the bar
 * rests at 0 — the total alone tells the operator it will not stay.
 */
export function PlateTrackRow({ offAir = false, onDelete, plate, withLiveButton = false }: PlateTrackRowProps) {
  const t = useT();
  const up = useProjectionStore((s) => s.livePlates.some((live) => live.id === plate.id));
  const hideClock = useProjectionStore((s) => (up ? s.plateHideClocks[plate.id] : undefined));
  const covered = useProjectionStore((s) => s.overlay !== "none" || s.base === null);
  const now = useTimerNow(hideClock ?? NO_CLOCK, DEFAULT_TIMER_FORMAT);
  const { autoHide } = plate.style;

  return (
    <MediaTrackRow
      hint={covered ? t(up ? "overlays.coveredHint" : "overlays.willBeCoveredHint") : undefined}
      kind="plate"
      label={plate.name}
      offAir={offAir}
      onDelete={onDelete}
      onGoLive={withLiveButton && !up ? () => void goLive() : undefined}
      onTakeDown={withLiveButton && up ? () => hidePlate(plate.id) : undefined}
      currentSeconds={hideClock ? countdownElapsedSeconds(hideClock, now, autoHide.afterMs) : 0}
      durationSeconds={autoHide.enabled ? autoHide.afterMs / 1000 : undefined}
      paused={hideClock?.mode === "countdown" && hideClock.state === "held"}
    />
  );
}
