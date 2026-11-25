import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { cn } from "@renderer/lib/utils";
import { screenResolution } from "@renderer/lib/screen-label";
import { useTimerNow } from "@renderer/lib/hooks/use-timer-now";
import { Button, Caption, Icon, IconButton, Input, Readout, Segmented, StatusToken, Title, Tooltip } from "@renderer/components/ui";
import { ReopenStage } from "@renderer/components/shared/reopen-stage";
import { getTopModalId } from "@renderer/components/shared/modal/modal-stack";
import { StageView } from "@renderer/components/shared/stage-view";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { FOCUS_STAGE_MESSAGE, useStageStore } from "@renderer/stores/stage.store";
import { countdownTone, formatCountdown, stageThresholds, type CountdownTone } from "@shared/stage";
import { formatSignedSeconds, formatWallClock, parseMinuteOfDay, resolveTargetMs } from "@shared/timer";
import { SLIDE_VIDEO_STATUS_KEY, VIDEO_STATUS_KEY } from "@shared/types/projection";
import { STAGE_LAYOUT_CHOICES, STAGE_MESSAGE_MAX_LENGTH, type StageLayoutChoice } from "@shared/types/stage";
import type { TimerClock, TimerFormat } from "@shared/types/timer";

const MINUTE = 60_000;
/** Longer than any service: the most the countdown field takes, in minutes. */
const MAX_COUNTDOWN_MINUTES = 5 * 60;
const TICK_FORMAT: TimerFormat = { hour12: false, showSeconds: true, hideZeroHours: true, overrun: true };
const HELD: TimerClock = { mode: "countdown", state: "held", remainingMs: 0 };

/** The countdown's colour here: the stage's, in this theme's inks. */
const TONE_INK: Record<CountdownTone, string> = {
  normal: "text-success-ink",
  warn: "text-warning-ink",
  alert: "text-danger-ink",
  over: "text-danger-ink",
};

type CountdownPhase = "none" | "running" | "paused" | "over";

/** The countdown as the panel reads it, ticking with the same clock the stage uses. */
function useCountdown() {
  const countdown = useStageStore((s) => s.countdown);
  const warnMs = useSettingsStore((s) => s.settings["stage.warnMs"]);
  const alertMs = useSettingsStore((s) => s.settings["stage.alertMs"]);
  const now = useTimerNow(countdown?.clock ?? HELD, TICK_FORMAT);
  if (!countdown) {
    return { countdown, phase: "none" as CountdownPhase, text: null, tone: "normal" as CountdownTone, endsAt: null };
  }
  const { clock } = countdown;
  const tone = countdownTone({ clock, ...stageThresholds(countdown.totalMs, warnMs, alertMs) }, now);
  const phase: CountdownPhase = clock.state === "running" ? (tone === "over" ? "over" : "running") : "paused";
  return {
    countdown,
    phase,
    text: formatCountdown(clock, now),
    tone,
    endsAt: clock.state === "running" ? clock.endsAtMs : null,
  };
}

/** «hace 1:20», so a message is never left on the platform forgotten. */
function MessageAge({ since }: { since: number }) {
  const t = useT();
  const clock = useMemo<TimerClock>(() => ({ mode: "stopwatch", state: "running", startedAtMs: since }), [since]);
  const now = useTimerNow(clock, TICK_FORMAT);
  const time = formatSignedSeconds(Math.max(0, Math.floor((now - since) / 1000)), TICK_FORMAT);
  return <span className="shrink-0 tabular-nums">{t("stagePanel.visibleFor", { time })}</span>;
}

/** Where the countdown stands, in a few words: «Hasta las 19:34», «En pausa»… Nothing while there is none. The
 *  time as the stage writes it (12 or 24 hours, Settings ▸ Screens), not as the computer does. */
function useCountdownState(phase: CountdownPhase, endsAt: number | null): string | null {
  const t = useT();
  const hour12 = useStageStore((s) => s.output?.hour12 ?? false);
  if (phase === "none") return null;
  return phase === "running" && endsAt !== null
    ? t("stagePanel.states.running", { time: formatWallClock(endsAt, { ...TICK_FORMAT, hour12, showSeconds: false }) })
    : t(`stagePanel.states.${phase}`);
}

function StatusDot() {
  const t = useT();
  const shown = useStageStore((s) => s.shown);
  const closed = useStageStore((s) => s.closed);
  const stageId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const stage = useDisplayStore((s) => s.displays.find((d) => d.id === stageId));
  const name = stage && (stage.name || screenResolution(stage, t));
  const label = shown
    ? t("stagePanel.shownOn", { name: name ?? "" })
    : closed
      ? t("stagePanel.closedByOperator")
      : t("stagePanel.notShown");
  return (
    <Tooltip content={label}>
      <span aria-label={label} className={cn("size-2 shrink-0 rounded-full", shown ? "bg-success" : "bg-danger")} role="img" />
    </Tooltip>
  );
}

const setOpen = (open: boolean) => useStageStore.getState().setPanelOpen(open);

/** A press on a token's ✕ or a button of the head acts on that, never also on the whole head. */
const only = (action: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  action();
};

/** The countdown the stage shows, as it stands: its colour, held or running, and how it reads. Its icon is its ✕. */
function CountdownToken() {
  const t = useT();
  const { countdown, endsAt, phase, text, tone } = useCountdown();
  const state = useCountdownState(phase, endsAt);
  if (!countdown || !text) return null;
  const running = phase === "running" || phase === "over";
  return (
    <StatusToken
      aria-label={t("stagePanel.countdown")}
      icon={running ? "timer" : "pause"}
      iconClassName={running ? TONE_INK[tone] : "text-muted-foreground"}
      onRemove={only(() => useStageStore.getState().clearCountdown())}
      removeLabel={t("stagePanel.clearCountdown")}
      role="group"
    >
      <Tooltip content={state}>
        <span className={cn("tabular-nums", running ? TONE_INK[tone] : "text-muted-foreground")} role="timer">
          {text}
        </span>
      </Tooltip>
    </StatusToken>
  );
}

/** The message on the stage: the text where there is room. Its icon is its ✕. */
function MessageToken() {
  const t = useT();
  const message = useStageStore((s) => s.message);
  if (!message) return null;
  return (
    <StatusToken
      className="shrink"
      icon={message.urgent ? "flash" : "message"}
      iconClassName={message.urgent ? "text-danger-ink" : "text-warning-ink"}
      onRemove={only(() => useStageStore.getState().clearMessage())}
      removeLabel={t("stagePanel.removeMessage")}
    >
      <Tooltip className="min-w-0" content={message.text}>
        <span className="min-w-0 truncate @max-[24rem]/head:hidden">{message.text}</span>
      </Tooltip>
    </StatusToken>
  );
}

/**
 * The panel's head, the same folded (the bar at the foot of the left column) and opened (the card's top): what is
 * on the stage — the countdown and the message, each a token whose icon takes it off — the pin and the arrow,
 * nothing else (owner, 2026-11-13: the same buttons either way). A press anywhere on it opens or folds the card;
 * the keyboard has the arrow.
 */
function StageHead({ open }: { open: boolean }) {
  const t = useT();
  const pinned = useStageStore((s) => s.panelPinned);
  // Pinned from the bar, it opens: a pinned card that is not there means nothing.
  const pin = () => {
    useStageStore.getState().setPanelPinned(!pinned);
    if (!pinned) setOpen(true);
  };
  return (
    /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the
       whole head is a shortcut for the mouse; the keyboard's way is its arrow, a real button inside it. */
    <div
      className="@container/head flex h-strip shrink-0 cursor-pointer items-center gap-1.5 pr-1.5 pl-3 transition-colors hover:bg-hover"
      onClick={() => setOpen(!open)}
    >
      <StatusDot />
      <Title as="h2" className="shrink-0">
        {t("stagePanel.title")}
      </Title>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1">
        <ReopenStage />
        <CountdownToken />
        <MessageToken />
      </div>
      <Tooltip content={pinned ? t("stagePanel.unpin") : t("stagePanel.pin")}>
        <IconButton aria-label={pinned ? t("stagePanel.unpin") : t("stagePanel.pin")} onClick={only(pin)} toggled={pinned} variant="ghost">
          <Icon name="pin" />
        </IconButton>
      </Tooltip>
      <Tooltip content={open ? t("stagePanel.close") : t("stagePanel.open")}>
        <IconButton
          aria-expanded={open}
          aria-label={open ? t("stagePanel.close") : t("stagePanel.open")}
          onClick={only(() => setOpen(!open))}
          variant="ghost"
        >
          <Icon name={open ? "chevronDown" : "chevronUp"} />
        </IconButton>
      </Tooltip>
    </div>
  );
}

/** A section of the card: its name, where it stands and what acts on all of it, over its controls. One row high
 *  whatever the right side holds, so the card never changes height. */
function Section({ actions, children, title }: { actions?: ReactNode; children: ReactNode; title: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t border-border px-3 pt-2 pb-3">
      <div className="flex h-7 items-center gap-2">
        <Caption className="min-w-0 flex-1 truncate tracking-wide uppercase" id={id}>
          {title}
        </Caption>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * The stage's own picture, at that screen's proportion (exactly what the stage draws, its videos moving as they
 * move there, unless the monitors are set to stills), and which view it shows.
 */
function MonitorSection() {
  const t = useT();
  const output = useStageStore((s) => s.output);
  const stageId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const choice = useSettingsStore((s) => s.settings["stage.layout"]);
  // The projector's reports only when the monitor plays videos: otherwise ~4 a second re-rendered it for nothing.
  const moving = useSettingsStore((s) => s.settings["monitors.liveVideoMotion"] && s.settings["stage.videoMotion"]);
  const video = useProjectionStore((s) => (moving ? (s.mediaStatus[VIDEO_STATUS_KEY] ?? null) : null));
  const slideVideo = useProjectionStore((s) => (moving ? (s.mediaStatus[SLIDE_VIDEO_STATUS_KEY] ?? null) : null));
  const media = useMemo(() => ({ video, slideVideo }), [video, slideVideo]);
  const update = useSettingsStore((s) => s.update);
  const display = useDisplayStore((s) => s.displays.find((d) => d.id === stageId));
  const [w, h] = display ? [display.bounds.width, display.bounds.height] : [16, 9];
  return (
    <div className="flex flex-col gap-2 p-3">
      {/* The whole width, never taller than 15rem: at that screen's proportion either way. */}
      <div
        aria-label={t("stagePanel.monitor")}
        className="mx-auto overflow-hidden rounded-md border border-border bg-clip-padding"
        role="img"
        style={{ aspectRatio: `${w} / ${h}`, width: `min(100%, calc(15rem * ${w} / ${h}))` }}
      >
        <StageView media={moving ? media : undefined} stage={output} />
      </div>
      <Segmented<StageLayoutChoice>
        // Four views in the column's width: the labels get the room the padding would take (a 1000 px window).
        className="w-full [&>button]:px-1"
        label={t("stagePanel.layout")}
        onChange={(value) => void update({ "stage.layout": value })}
        options={STAGE_LAYOUT_CHOICES.map((value) => ({ label: t(`stagePanel.layouts.${value}`), value }))}
        size="xs"
        value={choice}
      />
      {/* What the chosen view shows. Every hint is laid in the same cell, the others invisible, so the line is as tall
          as the longest one at this width: the card never changes height with the view, and keeps no empty line
          when they all fit in one (owner, 2026-11-14). */}
      <div className="grid">
        {STAGE_LAYOUT_CHOICES.map((value) => (
          <Caption
            aria-hidden={value !== choice}
            className={cn("col-start-1 row-start-1 font-normal", value !== choice && "invisible")}
            key={value}
          >
            {t(`stagePanel.layoutHints.${value}`)}
          </Caption>
        ))}
      </div>
    </div>
  );
}

/** What the countdown field holds, read: minutes («30»), or a time of day to count down to («19:45»). */
function readLength(text: string): { minutes: number } | { until: number } | null {
  const value = text.trim();
  const until = parseMinuteOfDay(value);
  if (until !== null) return { until };
  if (!/^\d{1,3}$/.test(value)) return null;
  const minutes = Number(value);
  return minutes > 0 && minutes <= MAX_COUNTDOWN_MINUTES ? { minutes } : null;
}

/**
 * The preacher's countdown, one row that changes with it (owner, 2026-11-14: fewer buttons). With none, a field —
 * the last length, or a time to count down to — and ▶, which starts it at once. Once it runs, the count itself, ±1
 * and pause. Taking it off is its token in the head.
 */
function CountdownSection() {
  const t = useT();
  const { endsAt, phase, text, tone } = useCountdown();
  const lengthMs = useStageStore((s) => s.lengthMs);
  const { countdownUntil, nudgeCountdown, startCountdown, toggleCountdown } = useStageStore.getState();
  // `null`: the field shows the last length. What the operator typed otherwise.
  const [typed, setTyped] = useState<string | null>(null);
  const value = typed ?? String(lengthMs / MINUTE);
  const read = readLength(value);
  const state = useCountdownState(phase, endsAt);
  const running = phase === "running" || phase === "over";

  const start = () => {
    if (!read) return;
    if ("until" in read) countdownUntil(read.until);
    else startCountdown(read.minutes * MINUTE);
    setTyped(null);
  };
  // What the field will start, said inside it: «min», or how long until the time typed — today's, even past: it
  // then starts in overtime, the Functions countdown's rule (`resolveTargetMs`).
  const untilMs = read && "until" in read ? resolveTargetMs(read.until, Date.now()) - Date.now() : 0;
  const suffix = !read
    ? null
    : "minutes" in read
      ? t("stagePanel.minutes")
      : untilMs > 0
        ? t("stagePanel.untilIn", { minutes: Math.max(1, Math.round(untilMs / MINUTE)) })
        : t("stagePanel.untilPast");

  return (
    <Section
      actions={state ? <Caption className="shrink-0 font-normal">{state}</Caption> : null}
      title={t("stagePanel.countdown")}
    >
      {phase === "none" ? (
        <div className="flex h-8 items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Input
              aria-invalid={!read || undefined}
              aria-label={t("stagePanel.length")}
              className="pr-24 tabular-nums"
              onChange={(e) => setTyped(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") start();
                else if (e.key === "Escape" && typed !== null) {
                  // The last length again; the card stays open.
                  e.stopPropagation();
                  setTyped(null);
                }
              }}
              placeholder={t("stagePanel.lengthPlaceholder")}
              title={t("stagePanel.lengthHelp")}
              value={value}
            />
            {suffix ? (
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                <Caption className="font-normal">{suffix}</Caption>
              </span>
            ) : null}
          </div>
          <Button aria-label={t("stagePanel.start")} className="min-w-24" disabled={!read} onClick={start} variant="outline">
            <Icon name="play" />
            {t("stagePanel.startShort")}
          </Button>
        </div>
      ) : (
        <div className="flex h-8 items-center gap-1.5">
          <Readout className={cn("min-w-0 flex-1 truncate", running ? TONE_INK[tone] : "text-muted-foreground")} role="timer">
            {text}
          </Readout>
          <Tooltip content={t("stagePanel.minus")}>
            <Button aria-label={t("stagePanel.minus")} onClick={() => nudgeCountdown(-MINUTE)} variant="outline">
              −1
            </Button>
          </Tooltip>
          <Tooltip content={t("stagePanel.plus")}>
            <Button aria-label={t("stagePanel.plus")} onClick={() => nudgeCountdown(MINUTE)} variant="outline">
              +1
            </Button>
          </Tooltip>
          <Button
            aria-label={running ? t("stagePanel.pause") : t("stagePanel.resume")}
            className="min-w-24"
            onClick={toggleCountdown}
            variant="outline"
          >
            <Icon name={running ? "pause" : "play"} />
            {running ? t("stagePanel.pauseShort") : t("stagePanel.resumeShort")}
          </Button>
        </div>
      )}
    </Section>
  );
}

/**
 * The message (owner, 2026-11-14: fewer buttons): the ready phrases — one press shows one, another takes it off —
 * and a field Enter sends. A new message arrives plain; blinking until it is taken off is asked of the one showing,
 * the only time that button is there.
 */
function MessageSection() {
  const t = useT();
  const message = useStageStore((s) => s.message);
  const draft = useStageStore((s) => s.draft);
  const stored = useSettingsStore((s) => s.settings["stage.phrases"]);
  const field = useRef<HTMLInputElement>(null);
  const { clearMessage, setUrgent, showMessage } = useStageStore.getState();
  // Without repeats: a list saved before 2026-11-15 may have two equal lines, one key (audit D7).
  const phrases = [...new Set(stored ?? t("stage.defaultPhrases").split("\n"))];

  useEffect(() => {
    const focus = () => field.current?.focus();
    window.addEventListener(FOCUS_STAGE_MESSAGE, focus);
    return () => window.removeEventListener(FOCUS_STAGE_MESSAGE, focus);
  }, []);

  const send = () => {
    if (!draft.trim()) return;
    showMessage(draft);
    useStageStore.setState({ draft: "" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    } else if (e.key === "Escape" && draft) {
      // A draft is dropped first; with nothing typed, Esc folds the card like anywhere in it (unless pinned). It never takes the
      // message off the stage: that is its ✕ (2026-11-15 walkthrough: it did, and the card stayed open).
      e.stopPropagation();
      useStageStore.setState({ draft: "" });
    }
  };

  return (
    <Section
      actions={
        message ? (
          <>
            <Caption className="font-normal">
              <MessageAge since={message.since} />
            </Caption>
            <Tooltip content={t("stagePanel.urgentHint")}>
              <Button onClick={() => setUrgent(!message.urgent)} size="xs" toggled={message.urgent} variant="ghost">
                <Icon name="flash" />
                {t("stagePanel.urgent")}
              </Button>
            </Tooltip>
          </>
        ) : null
      }
      title={t("stagePanel.message")}
    >
      <div aria-label={t("stagePanel.phrases")} className="flex flex-wrap gap-1" role="group">
        {phrases.map((text) => {
          const on = message?.text === text;
          return (
            <Button
              aria-pressed={on}
              className={cn(on && "border-accent bg-active")}
              key={text}
              onClick={() => (on ? clearMessage() : showMessage(text))}
              size="xs"
              variant="outline"
            >
              {on ? (
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", message.urgent ? "bg-danger" : "bg-warning")} />
              ) : null}
              {text}
            </Button>
          );
        })}
      </div>
      <div className="relative">
        <Input
          aria-label={t("stagePanel.message")}
          className="pr-9"
          maxLength={STAGE_MESSAGE_MAX_LENGTH}
          onChange={(e) => useStageStore.setState({ draft: e.target.value })}
          onKeyDown={onKeyDown}
          placeholder={t("stagePanel.messagePlaceholder")}
          ref={field}
          title={t("stagePanel.messageHelp")}
          value={draft}
        />
        <span className="absolute inset-y-0 right-1 flex items-center">
          <Tooltip content={t("stagePanel.show")}>
            <IconButton aria-label={t("stagePanel.show")} disabled={!draft.trim()} onClick={send} size="xs" variant="ghost">
              <Icon name="enter" />
            </IconButton>
          </Tooltip>
        </span>
      </div>
    </Section>
  );
}

/**
 * Opened, the panel is a card over the left column, like a chat window (owner, 2026-11-13): it grows out of the
 * bar with the same head on top, and the head, Esc or a press anywhere else folds it back (pinned, only its arrow). It covers the column rather than squeezing it,
 * which is what gives its controls room.
 */
function StageCard({ closing, onClosed }: { closing: boolean; onClosed: () => void }) {
  const t = useT();
  const card = useRef<HTMLDivElement>(null);
  // While it grows (or folds) its content is clipped, never scrolled: a scrollbar that showed for the growth and
  // then went away made it jerk (owner, 2026-11-13).
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (closing || settled) return;
    const timer = setTimeout(() => setSettled(true), 400);
    return () => clearTimeout(timer);
  }, [closing, settled]);

  // Folded even if its transition never ends (a window the OS is not drawing).
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(onClosed, 400);
    return () => clearTimeout(timer);
  }, [closing, onClosed]);

  // Esc folds it wherever the focus is: opened with the mouse (the head is no button), the focus is not inside the card
  // and its own handler never heard it (2026-11-15 audit, U3). Not an Esc a field or a widget already used, nor one
  // meant for a dialog on top, nor any Esc while it is pinned: pinned, only its arrow folds it (owner, 2026-11-17).
  useEffect(() => {
    if (closing) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || getTopModalId() !== null) return;
      if (useStageStore.getState().panelPinned) return;
      // An Esc typed in a field elsewhere (the library's filter, a search) is that field's.
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target && !card.current?.contains(target) && target.closest("input, textarea, [contenteditable]")) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closing]);

  useEffect(() => {
    if (closing) return;
    const onPointerDown = (e: PointerEvent) => {
      if (useStageStore.getState().panelPinned) return;
      if (!(e.target instanceof Node) || !card.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [closing]);

  return (
    <div
      aria-label={t("stagePanel.title")}
      className={cn(
        "wa-stage-card absolute inset-x-0 bottom-0 z-30 flex max-h-full flex-col overflow-hidden rounded-t-xl border border-b-0 border-border bg-surface shadow-overlay",
        closing && "wa-stage-card-closing",
      )}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget || e.propertyName !== "height") return;
        if (closing) onClosed();
        else setSettled(true);
      }}
      ref={card}
      role="dialog"
    >
      <StageHead open={!closing} />
      <div className={cn("min-h-0 border-t border-border", settled && !closing ? "overflow-y-auto" : "overflow-hidden")}>
        <MonitorSection />
        <CountdownSection />
        <MessageSection />
      </div>
    </div>
  );
}

/**
 * «Escenario» (owner, 2026-11-13): the stage screen run from the work screen: a manual countdown for the
 * preacher, a message to the platform and the view, beside a monitor of what the stage shows. Only while a stage
 * screen is assigned, and not as a copy of the projector: a church with two screens sees nothing new. A bar at the
 * foot of the left column (`StageHead`); opened, a card over it (`StageCard`), never remembered across launches.
 */
export function StagePanel() {
  const open = useStageStore((s) => s.panelOpen);
  // Kept mounted while it folds, until its closing animation ends.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const unmount = useCallback(() => setMounted(false), []);
  const t = useT();
  return (
    <>
      {/* Under the card while it is there: out of the tab order and of a screen reader's reading, or its pin, arrow
          and ✕ were reached twice and invisibly. */}
      <section aria-label={t("stagePanel.title")} className="shrink-0 border-t border-border bg-surface" inert={mounted}>
        <StageHead open={false} />
      </section>
      {mounted ? <StageCard closing={!open} onClosed={unmount} /> : null}
    </>
  );
}
