import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { useTimerNow } from "@renderer/lib/hooks/use-timer-now";
import { OutputView } from "@renderer/components/shared/output-view";
import { countdownTone, formatCountdown, type CountdownTone } from "@shared/stage";
import { formatWallClock } from "@shared/timer";
import type { MediaStatus, ProjectionOutput, StageOutput } from "@shared/types/projection";
import type { StageCountdown, StageMessage } from "@shared/types/stage";
import type { TimerClock, TimerFormat } from "@shared/types/timer";

const WALL: TimerClock = { mode: "clock" };
const FORMAT_24: TimerFormat = { hour12: false, showSeconds: false, hideZeroHours: true, overrun: true };
const FORMAT_12: TimerFormat = { ...FORMAT_24, hour12: true };
const COUNTDOWN_FORMAT: TimerFormat = { hour12: false, showSeconds: true, hideZeroHours: true, overrun: true };

/** A size in `cqw` times the stage's text size (Settings ▸ Screens). */
const sized = (cqw: number): CSSProperties => ({ fontSize: `calc(${cqw}cqw * var(--stage-scale))` });

/** Always the same box (a transparent fill until past zero), so the colours ease and nothing jumps in size. */
const TONE_CLASS: Record<CountdownTone, string> = {
  normal: "bg-transparent text-success-ink",
  warn: "bg-transparent text-warning-ink",
  alert: "bg-transparent text-danger-ink",
  over: "bg-danger text-danger-foreground",
};

/**
 * Whatever changes on the stage eases (owner, 2026-11-13: «every movement fluid»): what `children` replaces (keyed
 * by `swapKey`) fades out, then they fade in, in the same grid cell, so neither moves the other. The one leaving is
 * the last picture of it (the element as it was), kept only for its fade.
 */
function Swap({ children, className, swapKey }: { children: ReactNode; className?: string; swapKey: string }) {
  // What the last committed render drew: the one that leaves fades out as it last was, never as it first came in.
  const last = useRef<{ key: string; node: ReactNode }>({ key: swapKey, node: children });
  const [shownKey, setShownKey] = useState(swapKey);
  const [leaving, setLeaving] = useState<{ key: string; node: ReactNode } | null>(null);
  // The one coming in waits for the one leaving: two pictures over each other read as a double image.
  const [after, setAfter] = useState(false);
  if (swapKey !== shownKey) {
    setShownKey(swapKey);
    setLeaving(last.current);
    setAfter(true);
  }
  useEffect(() => {
    last.current = { key: swapKey, node: children };
  });
  // A hidden window draws no animation, so its end never comes: the leaving one goes anyway.
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), 600);
    return () => clearTimeout(timer);
  }, [leaving]);
  return (
    <div className={cn("grid", className)}>
      {leaving ? (
        <div
          aria-hidden
          className="wa-stage-fade-out pointer-events-none col-start-1 row-start-1 min-h-0 min-w-0"
          key={leaving.key}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) setLeaving(null);
          }}
        >
          {leaving.node}
        </div>
      ) : null}
      <div
        className={cn("col-start-1 row-start-1 min-h-0 min-w-0", after ? "wa-stage-fade-in-after" : "wa-stage-fade-in")}
        key={swapKey}
      >
        {children}
      </div>
    </div>
  );
}

/** The projector's own reports of its videos: given (and the stage set to move them), what is live plays in step
 *  with it, the way the LIVE monitor's copy does; without them a video is its poster. */
export type StageMedia = { video: MediaStatus | null; slideVideo: MediaStatus | null };

/** What is live, drawn by the projector's own renderer as a muted monitor: playing with `media`, a poster without. */
function LiveOutput({
  media,
  output,
  paced,
  videoStill,
}: {
  media: StageMedia | undefined;
  output: ProjectionOutput;
  paced: boolean;
  videoStill: StageOutput["videoStill"];
}) {
  return media ? (
    <OutputView
      liveVideoStatus={media.video}
      mode="monitor"
      output={output}
      pacedVideo={paced}
      slideVideoStatus={media.slideVideo}
    />
  ) : (
    <OutputView mode="monitor" output={output} videoStill={videoStill} />
  );
}

/** A 16:9 frame, as a muted monitor. Its edge and corners are in the stage's own units, so the panel's small monitor
 *  is a true picture of it and not a box of thick lines. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="wa-stage-frame w-full overflow-hidden bg-black">
      <div className="aspect-video w-full">{children}</div>
    </div>
  );
}

function Clock({ hour12, cqw }: { hour12: boolean; cqw: number }) {
  const format = hour12 ? FORMAT_12 : FORMAT_24;
  const now = useTimerNow(WALL, format);
  return (
    <time className="block leading-none font-semibold tabular-nums" style={sized(cqw)}>
      {formatWallClock(now, format)}
    </time>
  );
}

/** `.wa-stage-blink`: three blinks of 0.7 s. */
const BLINK_MS = 2100;
/** When this window saw the count turn red or go over. A view switch remounts the count, and its blink must go on
 *  from there, never start again (2026-11-15 walkthrough). Each window keeps its own. */
let blinkFrom: { tone: CountdownTone; at: number } | null = null;

function noteTone(tone: CountdownTone): void {
  if (tone !== "alert" && tone !== "over") blinkFrom = null;
  else if (blinkFrom?.tone !== tone) blinkFrom = { tone, at: Date.now() };
}

/** The count's digits, mounted again with each tone (`key`): they blink only what is left of that tone's blink. */
function Digits({ text }: { text: string }) {
  const [elapsed] = useState(() => (blinkFrom ? Date.now() - blinkFrom.at : BLINK_MS));
  const blinking = elapsed < BLINK_MS;
  return (
    <span className={cn("block", blinking && "wa-stage-blink")} style={blinking ? { animationDelay: `-${elapsed}ms` } : undefined}>
      {text}
    </span>
  );
}

/** The count, coloured by what is left; it blinks three times entering red and again at zero, once (`Digits`). Past
 *  zero it keeps counting up, red: it never stops nor disappears. Its fill's padding is given back as a negative
 *  margin, so its digits stand exactly where the time's stood. */
function Countdown({ countdown, cqw, fit = false }: { countdown: StageCountdown; cqw: number; fit?: boolean }) {
  const now = useTimerNow(countdown.clock, COUNTDOWN_FORMAT);
  const tone = countdownTone(countdown, now);
  noteTone(tone);
  const text = formatCountdown(countdown.clock, now);
  // The pastor's: as large as fits — `H:MM:SS` is wider than `MM:SS`, and the height is the stage's own.
  const style: CSSProperties = fit
    ? { fontSize: `calc(min(${cqw}cqw, ${(cqw * 5) / Math.max(5, text.length)}cqw, 38cqh) * var(--stage-scale))` }
    : sized(cqw);
  return (
    // The colour eases on this one; the blink is the inner one's (`key`), which inherits it.
    <span
      className={cn(
        "-mx-[0.15em] flex rounded-md px-[0.15em] leading-none font-bold tabular-nums transition-colors duration-700",
        TONE_CLASS[tone],
      )}
      data-tone={tone}
      role="timer"
      style={style}
    >
      <Digits key={tone} text={text} />
    </span>
  );
}

/** A band at the foot, in both views and whatever they hold: one message at a time, until it is taken off. It
 *  eases open (and closed: the last message stays drawn while it leaves), then blinks three times — or, urgent,
 *  until it is taken off. */
function MessageBand({ message }: { message: StageMessage | null }) {
  const [drawn, setDrawn] = useState(message);
  // A new message (or the same one changed: a new `seq`) is drawn at once; none keeps the last one while it leaves.
  if (message !== null && message.seq !== drawn?.seq) setDrawn(message);
  const leaving = message === null && drawn !== null;
  // A transition that never ends (a hidden window draws nothing) must not keep it on the stage.
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setDrawn(null), 500);
    return () => clearTimeout(timer);
  }, [leaving]);
  if (!drawn) return null;
  return (
    <div
      className={cn("wa-stage-band shrink-0", leaving && "wa-stage-band-leaving")}
      onTransitionEnd={(e) => {
        if (leaving && e.target === e.currentTarget && e.propertyName === "height") setDrawn(null);
      }}
    >
      <div
        className={cn(
          "px-[2cqw] py-[1.2cqw] text-center leading-tight font-bold [overflow-wrap:anywhere]",
          drawn.urgent
            ? "wa-stage-blink-forever bg-danger text-danger-foreground"
            : "wa-stage-blink bg-warning text-warning-foreground",
        )}
        key={drawn.seq}
        role="status"
        style={sized(4.5)}
      >
        <span className="line-clamp-2">{drawn.text}</span>
      </div>
    </div>
  );
}

/** A line `cqw` high whatever it holds: the time, the count or nothing take the same room, so nothing around moves. */
const line = (cqw: number): CSSProperties => ({ height: `calc(${cqw}cqw * var(--stage-scale))` });

/** What is live (large) and what comes next, which needs no caption (owner, 2026-11-14). With a countdown, the
 *  count takes the time's place and the time goes small over what comes next (owner, 2026-11-13): in «Auto» a verse
 *  projected mid-sermon brings this view, and the pastor still reads the count from the pulpit. Every line keeps its
 *  height through that change. */
function Musicians({ media, paced, stage }: { media: StageMedia | undefined; paced: boolean; stage: StageOutput | null }) {
  const countdown = stage?.countdown ?? null;
  const hour12 = stage?.hour12 ?? false;
  return (
    <div className="grid h-full grid-cols-[3fr_2fr] items-center gap-[2cqw] p-[2cqw]">
      <Frame>{stage ? <LiveOutput media={media} output={stage.current} paced={paced} videoStill={stage.videoStill} /> : null}</Frame>
      <aside className="flex min-w-0 flex-col gap-[1.5cqw]">
        <div style={line(7)}>
          <Swap className="h-full items-center justify-items-start" swapKey={countdown ? "countdown" : "clock"}>
            {countdown ? <Countdown countdown={countdown} cqw={7} /> : <Clock cqw={7} hour12={hour12} />}
          </Swap>
        </div>
        <div className="flex items-center justify-end" style={line(2.6)}>
          <Swap swapKey={countdown ? "clock" : "none"}>
            {countdown ? (
              <span className="text-white/80">
                <Clock cqw={2.6} hour12={hour12} />
              </span>
            ) : null}
          </Swap>
        </div>
        <Frame>{stage?.next ? <OutputView mode="monitor" output={stage.next} videoStill={stage.videoStill} /> : null}</Frame>
      </aside>
    </div>
  );
}

/** The countdown as large as fits, and below it the time and what the projector shows — always, black and LOGO
 *  included (owner, 2026-11-13). Without a countdown, the time takes its place. */
function Preacher({ media, paced, stage }: { media: StageMedia | undefined; paced: boolean; stage: StageOutput }) {
  const countdown = stage.countdown;
  return (
    <div className="flex h-full flex-col gap-[1.5cqw] p-[2cqw]">
      <Swap className="min-h-0 flex-1 grid-rows-[minmax(0,1fr)] place-items-center" swapKey={countdown ? "countdown" : "clock"}>
        {countdown ? <Countdown countdown={countdown} cqw={24} fit /> : <Clock cqw={18} hour12={stage.hour12} />}
      </Swap>
      <div className="flex items-end justify-between gap-[2cqw]">
        <Swap swapKey={countdown ? "clock" : "none"}>{countdown ? <Clock cqw={6} hour12={stage.hour12} /> : null}</Swap>
        <div className="w-[30cqw] shrink-0">
          <Frame>
            <LiveOutput media={media} output={stage.current} paced={paced} videoStill={stage.videoStill} />
          </Frame>
        </div>
      </div>
    </div>
  );
}

/**
 * The stage screen, drawn the same by its window and by the stage panel's monitor — the rule that monitors never
 * lie to the operator. Everything is in units of its own box (`container-type: size`), never of the window, and in
 * the dark theme's colours whatever the control window's theme is. A pure function of the `StageOutput`.
 *
 * What is live moves only when the stage is set to (`videoMotion`) and the caller has the projector's reports
 * (`media`): the stage window, and the panel's monitor unless the monitors show stills. «Projector» is a copy of the
 * projector and nothing else: `copy` draws it (the stage window's `ProjectorCopy`), or else `current`. `paced`: the
 * stage window, a screen people watch, puts the engine's frames up on its own clock like the projector; the panel's
 * monitor draws them as they land (2026-11-15 audit, A32).
 */
export function StageView({
  stage,
  className,
  copy,
  media,
  paced = false,
}: {
  stage: StageOutput | null;
  className?: string;
  copy?: ReactNode;
  media?: StageMedia | undefined;
  paced?: boolean;
}) {
  const layout = stage?.layout ?? "musicians";
  const moving = stage?.videoMotion ? media : undefined;
  return (
    <div
      className={cn("size-full overflow-hidden bg-black text-white [container-type:size]", className)}
      data-layout={layout}
      data-theme="dark"
      style={{ "--stage-scale": stage?.textScale ?? 1 } as CSSProperties}
    >
      <div className="flex size-full flex-col">
        {/* Switching views is a crossfade, never a cut. */}
        <Swap className="min-h-0 flex-1 grid-rows-[minmax(0,1fr)]" swapKey={layout}>
          {stage && layout === "projector" ? (
            ((moving ? copy : null) ?? (
              <LiveOutput media={moving} output={stage.current} paced={paced} videoStill={stage.videoStill} />
            ))
          ) : stage && layout === "preacher" ? (
            <Preacher media={moving} paced={paced} stage={stage} />
          ) : (
            <Musicians media={moving} paced={paced} stage={stage} />
          )}
        </Swap>
        <MessageBand message={layout === "projector" ? null : (stage?.message ?? null)} />
      </div>
    </div>
  );
}
