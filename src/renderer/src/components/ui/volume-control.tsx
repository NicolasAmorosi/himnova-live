import { cn } from "@renderer/lib/utils";
import { Icon } from "./icon";
import { IconButton } from "./icon-button";
import { useMuteToggle } from "./use-mute-toggle";

type VolumeControlProps = {
  className?: string;
  /** Names the pair for a screen reader — "Volume for <track>". Both the mute
   *  button and the slider get it, because a bare "Volume" repeated once per
   *  live track says nothing about which one. */
  label: string;
  /** What the slider announces at 0, e.g. "Mute" / "Unmute". */
  muteLabel: string;
  onChange: (volume: number) => void;
  tone?: "accent" | "audio";
  /** 0..1. */
  value: number;
};

const accent: Record<NonNullable<VolumeControlProps["tone"]>, string> = {
  accent: "accent-accent",
  audio: "accent-badge-audio",
};

/**
 * Level control for one live media target: a mute toggle and a slider.
 *
 * A native `<input type="range">` rather than the hand-rolled slider
 * `MediaScrubber` is. The scrubber exists because a seek bar has to paint a
 * position it is *ahead of* (the drag, before the projector confirms it) and
 * because it carries clock semantics; a volume slider has neither problem, and
 * the native element brings keyboard support, `pointercancel` handling and
 * screen-reader semantics that would otherwise be ~80 lines of duplicated
 * pointer code. Its color comes from `accent-color`, so the tokens still own
 * the palette.
 *
 * Muting is `volume = 0` with the previous level remembered here, not a
 * separate flag: one number crosses IPC, and nothing can get out of step with
 * the element's own `volume`.
 */
export function VolumeControl({ className, label, muteLabel, onChange, tone = "accent", value }: VolumeControlProps) {
  const muted = value === 0;
  const toggleMute = useMuteToggle(value, onChange);

  return (
    <div className={cn("flex shrink-0 items-center gap-1", className)}>
      <IconButton
        aria-label={muteLabel}
        aria-pressed={muted}
        onClick={toggleMute}
        size="xs"
        variant="ghost"
      >
        <Icon name={muted ? "volumeOff" : "volume"} />
      </IconButton>
      <input
        aria-label={label}
        aria-valuetext={`${Math.round(value * 100)}%`}
        className={cn("h-1 w-14 cursor-pointer", accent[tone])}
        max={100}
        min={0}
        onChange={(event) => onChange(Number(event.currentTarget.value) / 100)}
        step={1}
        type="range"
        value={Math.round(value * 100)}
      />
    </div>
  );
}
