import type { CSSProperties } from "react";
import { cn } from "@renderer/lib/utils";
import { useTimerNow } from "@renderer/lib/hooks/use-timer-now";
import { OutputView } from "@renderer/components/shared/output-view";
import { countdownTone, formatCountdown, type CountdownTone } from "@shared/stage";
import { formatWallClock } from "@shared/timer";
import type { ProjectionOutput, StageOutput } from "@shared/types/projection";
import type { StageCountdown, StageMessage } from "@shared/types/stage";
import type { TimerClock, TimerFormat } from "@shared/types/timer";

const WALL: TimerClock = { mode: "clock" };
const FORMAT_24: TimerFormat = { hour12: false, showSeconds: false, hideZeroHours: true, overrun: true };
const FORMAT_12: TimerFormat = { ...FORMAT_24, hour12: true };
const COUNTDOWN_FORMAT: TimerFormat = { hour12: false, showSeconds: true, hideZeroHours: true, overrun: true };

/** A size in `cqw` times the stage's text size (Settings ▸ Screens). */
const sized = (cqw: number): CSSProperties => ({ fontSize: `calc(${cqw}cqw * var(--stage-scale))` });

const TONE_CLASS: Record<CountdownTone, string> = {
  normal: "text-success-ink",
  warn: "text-warning-ink",
  alert: "text-danger-ink",
  over: "rounded-md bg-danger px-[2cqw] text-danger-foreground",
};

/** A 16:9 frame drawn by the projector's own renderer, as a muted monitor. */
function Frame({ output, videoStill }: { output: ProjectionOutput | null; videoStill: StageOutput["videoStill"] | undefined }) {
  return (
    <div className="w-full overflow-hidden rounded-md border border-white/25 bg-black">
      <div className="aspect-video w-full">
        {output ? <OutputView mode="monitor" output={output} videoStill={videoStill} /> : null}
      </div>
    </div>
  );
}

function Clock({ hour12, cqw }: { hour12: boolean; cqw: number }) {
  const format = hour12 ? FORMAT_12 : FORMAT_24;
  const now = useTimerNow(WALL, format);
  return (
    <time className="leading-none font-semibold tabular-nums" style={sized(cqw)}>
      {formatWallClock(now, format)}
    </time>
  );
}

/** The count, coloured by what is left; it blinks three times entering red and again at zero (`key` remounts it,
 *  which restarts the animation). Past zero it keeps counting up, red: it never stops nor disappears. */
function Countdown({ countdown, cqw, fit = false }: { countdown: StageCountdown; cqw: number; fit?: boolean }) {
  const now = useTimerNow(countdown.clock, COUNTDOWN_FORMAT);
  const tone = countdownTone(countdown, now);
  const text = formatCountdown(countdown.clock, now);
  // The preacher's: as large as fits — `H:MM:SS` is wider than `MM:SS`, and the height is the stage's own.
  const style: CSSProperties = fit
    ? { fontSize: `calc(min(${cqw}cqw, ${(cqw * 5) / Math.max(5, text.length)}cqw, 38cqh) * var(--stage-scale))` }
    : sized(cqw);
  return (
    <span
      className={cn(
        "leading-none font-bold tabular-nums",
        TONE_CLASS[tone],
        (tone === "alert" || tone === "over") && "wa-stage-blink",
      )}
      data-tone={tone}
      key={tone}
      role="timer"
      style={style}
    >
      {text}
    </span>
  );
}

/** A band at the foot, in both layouts and whatever they hold: one message at a time, until it is taken off. */
function MessageBand({ message }: { message: StageMessage }) {
  return (
    <div
      className={cn(
        "shrink-0 px-[2cqw] py-[1.2cqw] text-center leading-tight font-bold [overflow-wrap:anywhere]",
        message.urgent
          ? "wa-stage-blink-forever bg-danger text-danger-foreground"
          : "wa-stage-blink bg-warning text-warning-foreground",
      )}
      key={message.seq}
      role="status"
      style={sized(4.5)}
    >
      <span className="line-clamp-2">{message.text}</span>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <span className="rounded-md bg-on-air px-[1cqw] py-[0.4cqw] font-bold" style={sized(1.8)}>
      {text}
    </span>
  );
}

/** What is live (large), the time, and what comes next. A countdown sits beside the time, as large: in «Auto» a
 *  verse projected mid-sermon brings this layout, and the preacher still has to read it from the pulpit. */
function Musicians({ stage }: { stage: StageOutput | null }) {
  return (
    <div className="grid h-full grid-cols-[3fr_2fr] items-center gap-[2cqw] p-[2cqw]">
      <Frame output={stage?.current ?? null} videoStill={stage?.videoStill} />
      <aside className="flex min-w-0 flex-col gap-[1.5cqw]">
        <div className="flex items-center justify-between gap-[1cqw]">
          <Clock cqw={stage?.countdown ? 6 : 7} hour12={stage?.hour12 ?? false} />
          {stage?.countdown ? (
            <Countdown countdown={stage.countdown} cqw={6} />
          ) : stage?.notice ? (
            <Notice text={stage.notice} />
          ) : null}
        </div>
        {stage?.countdown && stage.notice ? (
          <div>
            <Notice text={stage.notice} />
          </div>
        ) : null}
        <p className="font-medium tracking-wide text-white/60 uppercase" style={sized(1.6)}>
          {stage?.nextLabel}
        </p>
        <Frame output={stage?.next ?? null} videoStill={stage?.videoStill} />
      </aside>
    </div>
  );
}

/** The countdown as large as fits, the time, and what is live small. Without a countdown, the time takes its place. */
function Preacher({ stage }: { stage: StageOutput }) {
  return (
    <div className="flex h-full flex-col gap-[1.5cqw] p-[2cqw]">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {stage.countdown ? <Countdown countdown={stage.countdown} cqw={24} fit /> : <Clock cqw={18} hour12={stage.hour12} />}
      </div>
      <div className="flex items-end justify-between gap-[2cqw]">
        <div className="flex flex-col items-start gap-[1cqw]">
          {stage.notice ? <Notice text={stage.notice} /> : null}
          {stage.countdown ? <Clock cqw={6} hour12={stage.hour12} /> : null}
        </div>
        <div className="w-[30cqw] shrink-0">
          <Frame output={stage.current} videoStill={stage.videoStill} />
        </div>
      </div>
    </div>
  );
}

/**
 * The stage screen, drawn the same by its window and by the stage panel's monitor — the rule that monitors never
 * lie to the operator. Everything is in units of its own box (`container-type: size`), never of the window, and in
 * the dark theme's colours whatever the control window's theme is. A pure function of the `StageOutput`.
 */
export function StageView({ stage, className }: { stage: StageOutput | null; className?: string }) {
  return (
    <div
      className={cn("size-full overflow-hidden bg-black text-white [container-type:size]", className)}
      data-theme="dark"
      style={{ "--stage-scale": stage?.textScale ?? 1 } as CSSProperties}
    >
      <div className="flex size-full flex-col">
        <div className="min-h-0 flex-1">
          {stage?.layout === "preacher" ? <Preacher stage={stage} /> : <Musicians stage={stage} />}
        </div>
        {stage?.message ? <MessageBand message={stage.message} /> : null}
      </div>
    </div>
  );
}
