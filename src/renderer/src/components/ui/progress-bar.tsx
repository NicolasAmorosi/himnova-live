import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@renderer/lib/utils";

type Tone = "accent" | "success" | "danger";
type ProgressBarProps = HTMLAttributes<HTMLDivElement> & {
  /** 0..1. Values outside the range are clamped. */
  value: number;
  tone?: Tone;
};

const toneClassName: Record<Tone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  danger: "bg-danger",
};

/**
 * Determinate counterpart to `LinearLoader` (which stays for "we don't know
 * the total"). Used by deck conversion progress, the time-to-next-slide bar,
 * and video/audio playback position.
 */
export function ProgressBar({ className, tone = "accent", value, ...props }: ProgressBarProps) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={pct}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      {...props}
    >
      {/* No transition: a width that animates is a layout and a paint every frame, and the time-to-next-slide bar
          changes four times a second for the whole of every hymn — 21 % of a core of the control window plus 12 % of
          the GPU process, against 3.4 % + 2.6 % without it (2026-11-10 review, agent7-01). Four steps a second
          already read as continuous on a 4 px bar. */}
      <div className={cn("h-full rounded-full", toneClassName[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * A progress someone waits on: what is happening and the readout on one line,
 * the bar under them across the whole width, and a detail («41 of 146 MB»)
 * below. The caller words the readout, because a percentage is written
 * differently per language («28 %», «28%»).
 */
export function ProgressMeter({
  className,
  detail,
  label,
  readout,
  value,
  ...props
}: ProgressBarProps & { label: ReactNode; readout: string; detail?: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-1.5 text-xs text-muted-foreground", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 font-medium tabular-nums text-foreground">{readout}</span>
      </div>
      <ProgressBar className="h-1.5" value={value} {...props} />
      {detail ? <span className="tabular-nums text-subtle">{detail}</span> : null}
    </div>
  );
}
