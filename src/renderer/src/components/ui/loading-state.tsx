import type { ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { Icon, type IconName } from "./icon";
import { LinearLoader } from "./linear-loader";
import { ProgressBar } from "./progress-bar";

type LoadingStateTone = "busy" | "queued" | "failed";
/** `stage` sits on the monitor's black stage (light text in both themes, same
 *  reason `Monitor`'s own empty-state text is `text-white/60`); `panel` sits
 *  on a normal `bg-surface`/`bg-card` panel. */
type LoadingStateSurface = "stage" | "panel";

type LoadingStateProps = {
  /** A `<Button>` or two: cancel, retry, locate. */
  action?: ReactNode;
  className?: string;
  hint?: string | undefined;
  icon?: IconName;
  /** 0..1 for a determinate bar, `null` for indeterminate, `undefined` for
   *  no bar at all. */
  progress?: number | null | undefined;
  surface?: LoadingStateSurface;
  title: string;
  tone?: LoadingStateTone;
};

const surfaceTextClassName: Record<LoadingStateSurface, string> = {
  stage: "text-white",
  panel: "text-foreground",
};
const surfaceHintClassName: Record<LoadingStateSurface, string> = {
  stage: "text-white/60",
  panel: "text-subtle",
};
const surfaceTrackClassName: Record<LoadingStateSurface, string> = {
  stage: "bg-white/15",
  panel: "bg-muted",
};
const toneIconClassName: Record<LoadingStateTone, string> = {
  busy: "text-accent-ink",
  queued: "text-muted-foreground",
  failed: "text-danger-ink",
};
const toneBarTone: Record<LoadingStateTone, "accent" | "danger"> = {
  busy: "accent",
  queued: "accent",
  failed: "danger",
};

/**
 * One shared shape for "something is converting/queued/failed" — the deck
 * conversion status is the reason this exists (it has to render identically
 * on the black monitor stage and on a normal panel, per the "monitors never
 * lie to the operator" rule), but anything else with a determinate/indeterminate
 * progress + retry/cancel action fits here too.
 */
export function LoadingState({
  action,
  className,
  hint,
  icon = "spinner",
  progress,
  surface = "panel",
  title,
  tone = "busy",
}: LoadingStateProps) {
  return (
    <div
      aria-live="polite"
      className={cn(
        // `m-auto`: centred in whatever holds it, like `EmptyState` — in a
        // panel's flex column it sat in the top-left corner (owner, 2026-11-05).
        "m-auto flex w-full max-w-xs flex-col items-center gap-2 px-4 text-center",
        surfaceTextClassName[surface],
        className,
      )}
    >
      <Icon
        className={cn("size-6", toneIconClassName[tone], icon === "spinner" && "motion-safe:animate-spin")}
        name={icon}
      />
      <p className="text-sm font-medium">{title}</p>
      {progress === null ? (
        <LinearLoader className={cn("w-full", surfaceTrackClassName[surface])} />
      ) : progress !== undefined ? (
        <ProgressBar
          className={cn("w-full", surfaceTrackClassName[surface])}
          tone={toneBarTone[tone]}
          value={progress}
        />
      ) : null}
      {/* `select-text` against the app-wide `user-select: none`: a hint is
          static prose, never a drag handle, and this is where the crash
          screen prints `error.message` — the one string the operator has to
          be able to copy to report what happened. */}
      {hint ? <p className={cn("text-xs select-text", surfaceHintClassName[surface])}>{hint}</p> : null}
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
