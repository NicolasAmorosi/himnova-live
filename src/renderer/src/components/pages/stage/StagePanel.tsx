import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { cn } from "@renderer/lib/utils";
import { useTimerNow } from "@renderer/lib/hooks/use-timer-now";
import { Button, Caption, Icon, IconButton, Input, Segmented, Title, Tooltip } from "@renderer/components/ui";
import { StageView } from "@renderer/components/shared/stage-view";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { FOCUS_STAGE_MESSAGE, useStageStore } from "@renderer/stores/stage.store";
import { countdownTone, formatCountdown, stageThresholds, type CountdownTone } from "@shared/stage";
import { formatSignedSeconds, parseDuration, parseMinuteOfDay } from "@shared/timer";
import {
  STAGE_LAYOUT_CHOICES,
  STAGE_MESSAGE_MAX_LENGTH,
  STAGE_PRESET_MINUTES,
  STAGE_RECENT_MESSAGES,
  type StageLayoutChoice,
} from "@shared/types/stage";
import type { TimerClock, TimerFormat } from "@shared/types/timer";

const MINUTE = 60_000;
/** Longer than any service: what the «other» field takes. */
const MAX_COUNTDOWN_MS = 5 * 60 * MINUTE;
const TICK_FORMAT: TimerFormat = { hour12: false, showSeconds: true, hideZeroHours: true, overrun: true };
const HELD: TimerClock = { mode: "countdown", state: "held", remainingMs: 0 };

/** The countdown's colour here: the stage's, in this theme's inks. */
const TONE_INK: Record<CountdownTone, string> = {
  normal: "text-foreground",
  warn: "text-warning-ink",
  alert: "text-danger-ink",
  over: "text-danger-ink",
};

type CountdownPhase = "none" | "armed" | "running" | "paused" | "over";

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
  const phase: CountdownPhase =
    clock.state === "running"
      ? tone === "over"
        ? "over"
        : "running"
      : clock.remainingMs === countdown.totalMs
        ? "armed"
        : "paused";
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

function StatusDot() {
  const t = useT();
  const shown = useStageStore((s) => s.shown);
  return (
    <span
      aria-label={shown ? t("stagePanel.shown") : t("stagePanel.notShown")}
      className={cn("size-2 shrink-0 rounded-full", shown ? "bg-success" : "bg-danger")}
      role="img"
    />
  );
}

const setOpen = (open: boolean) => useStageStore.getState().setPanelOpen(open);

/**
 * Folded, the panel is this bar at the foot of the left column: whether the stage is on screen, the countdown
 * with its pause, the message with its ✕. Its name or its arrow opens the card.
 */
function StageBar() {
  const t = useT();
  const message = useStageStore((s) => s.message);
  const shown = useStageStore((s) => s.shown);
  const { phase, text, tone } = useCountdown();
  const { clearMessage, toggleCountdown } = useStageStore.getState();
  const running = phase === "running" || phase === "over";

  return (
    <section
      aria-label={t("stagePanel.title")}
      className="flex h-strip shrink-0 items-center gap-1.5 border-t border-border bg-surface px-1.5"
    >
      <Tooltip floating content={shown ? t("stagePanel.shown") : t("stagePanel.notShown")}>
        <button
          className="focus-ring flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-1.5 hover:bg-muted"
          onClick={() => setOpen(true)}
          type="button"
        >
          <StatusDot />
          <Title as="h2">{t("stagePanel.title")}</Title>
        </button>
      </Tooltip>
      {text ? (
        <span className="flex shrink-0 items-center">
          <span className={cn("text-sm font-semibold tabular-nums", TONE_INK[tone])}>{text}</span>
          <Tooltip floating content={running ? t("stagePanel.pause") : t("stagePanel.resume")}>
            <IconButton
              aria-label={running ? t("stagePanel.pause") : t("stagePanel.resume")}
              onClick={toggleCountdown}
              size="xs"
              variant="ghost"
            >
              <Icon name={running ? "pause" : "play"} />
            </IconButton>
          </Tooltip>
        </span>
      ) : null}
      {message ? (
        <span className="flex min-w-0 items-center gap-1">
          <Icon className={message.urgent ? "text-danger-ink" : "text-warning-ink"} name="alert" />
          <span className="min-w-0 truncate text-xs">{message.text}</span>
          <Tooltip floating content={t("stagePanel.removeMessage")}>
            <IconButton aria-label={t("stagePanel.removeMessage")} onClick={clearMessage} size="xs" variant="ghost">
              <Icon name="close" />
            </IconButton>
          </Tooltip>
        </span>
      ) : null}
      {!text && !message ? <Caption className="min-w-0 truncate font-normal">{t("stagePanel.idle")}</Caption> : null}
      <span className="flex-1" />
      <Tooltip floating align="end" content={t("stagePanel.open")}>
        <IconButton aria-expanded={false} aria-label={t("stagePanel.open")} onClick={() => setOpen(true)} variant="ghost">
          <Icon name="chevronUp" />
        </IconButton>
      </Tooltip>
    </section>
  );
}

/** A section of the card: its name (and what acts on all of it) over its controls. */
function Section({ actions, children, title }: { actions?: ReactNode; children: ReactNode; title: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t border-border px-3 pt-2 pb-3">
      <div className="flex h-7 items-center gap-1">
        <Caption className="min-w-0 flex-1 truncate tracking-wide uppercase" id={id}>
          {title}
        </Caption>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** The stage's own picture, at that screen's proportion (exactly what the stage draws), and which view it shows. */
function MonitorSection() {
  const t = useT();
  const output = useStageStore((s) => s.output);
  const stageId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const choice = useSettingsStore((s) => s.settings["stage.layout"]);
  const update = useSettingsStore((s) => s.update);
  const display = useDisplayStore((s) => s.displays.find((d) => d.id === stageId));
  const [w, h] = display ? [display.bounds.width, display.bounds.height] : [16, 9];
  return (
    <div className="flex flex-col gap-2 p-3">
      {/* The whole width, never taller than 10rem: at that screen's proportion either way. */}
      <div
        aria-label={t("stagePanel.monitor")}
        className="mx-auto overflow-hidden rounded-md border border-border"
        role="img"
        style={{ aspectRatio: `${w} / ${h}`, width: `min(100%, calc(10rem * ${w} / ${h}))` }}
      >
        <StageView stage={output} />
      </div>
      {/* Which view is on is the monitor above; «?» says what «Automática» does. */}
      <div className="flex items-center gap-2">
        <Caption className="flex shrink-0 items-center gap-1">
          {t("stagePanel.layoutLabel")}
          <Tooltip floating content={t("stagePanel.autoHint")}>
            <Icon className="size-3.5 text-subtle" name="help" />
          </Tooltip>
        </Caption>
        <Segmented<StageLayoutChoice>
          className="min-w-0 flex-1"
          label={t("stagePanel.layout")}
          onChange={(value) => void update({ "stage.layout": value })}
          options={STAGE_LAYOUT_CHOICES.map((value) => ({ label: t(`stagePanel.layouts.${value}`), value }))}
          size="xs"
          value={choice}
        />
      </div>
    </div>
  );
}

function CountdownSection() {
  const t = useT();
  const { countdown, endsAt, phase, text, tone } = useCountdown();
  const { armCountdown, clearCountdown, countdownUntil, nudgeCountdown, resetCountdown, toggleCountdown } =
    useStageStore.getState();
  const [other, setOther] = useState("");
  const running = phase === "running" || phase === "over";

  const submitOther = () => {
    const value = other.trim();
    if (!value) return;
    if (value.includes(":")) {
      const minute = parseMinuteOfDay(value);
      if (minute === null) return;
      countdownUntil(minute);
    } else {
      const ms = parseDuration(value);
      if (ms === null || ms <= 0 || ms > MAX_COUNTDOWN_MS) return;
      armCountdown(ms);
    }
    setOther("");
  };
  const state =
    phase === "running" && endsAt !== null
      ? t("stagePanel.states.running", {
          time: new Date(endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        })
      : t(`stagePanel.states.${phase}`);
  const mainLabel = running ? t("stagePanel.pause") : phase === "paused" ? t("stagePanel.resume") : t("stagePanel.start");

  return (
    <Section
      actions={
        <>
          <Button disabled={phase === "none" || phase === "armed"} onClick={resetCountdown} size="xs" variant="ghost">
            <Icon name="restart" /> {t("stagePanel.reset")}
          </Button>
          <Button aria-label={t("stagePanel.clearCountdown")} disabled={!countdown} onClick={clearCountdown} size="xs" variant="ghost">
            <Icon name="close" /> {t("stagePanel.remove")}
          </Button>
        </>
      }
      title={t("stagePanel.countdown")}
    >
      <div className="flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span
            className={cn("text-3xl leading-none font-semibold tabular-nums", text ? TONE_INK[tone] : "text-subtle")}
            role="timer"
          >
            {text ?? "--:--"}
          </span>
          <Caption className="truncate font-normal">{state}</Caption>
        </div>
        <Tooltip floating content={t("stagePanel.minus")}>
          <Button
            aria-label={t("stagePanel.minus")}
            disabled={!countdown}
            onClick={() => nudgeCountdown(-MINUTE)}
            variant="outline"
          >
            −1
          </Button>
        </Tooltip>
        <Button aria-label={mainLabel} className="min-w-24" disabled={!countdown} onClick={toggleCountdown} variant="outline">
          <Icon name={running ? "pause" : "play"} />
          {running ? t("stagePanel.pauseShort") : phase === "paused" ? t("stagePanel.resumeShort") : t("stagePanel.startShort")}
        </Button>
        <Tooltip floating align="end" content={t("stagePanel.plus")}>
          <Button aria-label={t("stagePanel.plus")} disabled={!countdown} onClick={() => nudgeCountdown(MINUTE)} variant="outline">
            +1
          </Button>
        </Tooltip>
      </div>
      <div className="flex items-center gap-1">
        <div aria-label={t("stagePanel.presets")} className="flex min-w-0 flex-1 gap-1" role="group">
          {STAGE_PRESET_MINUTES.map((m) => {
            const chosen = countdown?.totalMs === m * MINUTE;
            return (
              <Button
                aria-label={t("stagePanel.preset", { minutes: m })}
                aria-pressed={chosen}
                className={cn("min-w-0 flex-1 px-0", chosen && "border-accent bg-active")}
                key={m}
                onClick={() => armCountdown(m * MINUTE)}
                size="xs"
                variant="outline"
              >
                {m}
              </Button>
            );
          })}
        </div>
        <Input
          aria-label={t("stagePanel.custom")}
          className="w-28"
          onBlur={submitOther}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitOther();
          }}
          placeholder={t("stagePanel.customPlaceholder")}
          size="xs"
          value={other}
        />
      </div>
    </Section>
  );
}

/** Sends `text` at the urgency chosen; the operator's own words are kept to send again (a ready phrase already is). */
function useSendMessage(): (text: string) => void {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const phrases = settings["stage.phrases"] ?? t("stage.defaultPhrases").split("\n");
  return (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const { draftUrgent, showMessage } = useStageStore.getState();
    showMessage(trimmed, draftUrgent);
    useStageStore.setState({ draft: "" });
    if (!phrases.includes(trimmed)) {
      const next = [trimmed, ...settings["stage.recentMessages"].filter((m) => m !== trimmed)].slice(0, STAGE_RECENT_MESSAGES);
      void update({ "stage.recentMessages": next });
    }
  };
}

/** The message, like a chat: what is on the stage now, the ready phrases, and a field at the foot. */
function MessageSection() {
  const t = useT();
  const message = useStageStore((s) => s.message);
  const draft = useStageStore((s) => s.draft);
  const urgent = useStageStore((s) => s.draftUrgent);
  const settings = useSettingsStore((s) => s.settings);
  const field = useRef<HTMLInputElement>(null);
  const { clearMessage, setUrgent } = useStageStore.getState();
  const send = useSendMessage();
  const phrases = settings["stage.phrases"] ?? t("stage.defaultPhrases").split("\n");
  const recent = settings["stage.recentMessages"].filter((text) => !phrases.includes(text));

  useEffect(() => {
    const focus = () => field.current?.focus();
    window.addEventListener(FOCUS_STAGE_MESSAGE, focus);
    return () => window.removeEventListener(FOCUS_STAGE_MESSAGE, focus);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      send(draft);
    } else if (e.key === "Escape") {
      // A draft is dropped first; with nothing typed, Esc takes the message off the stage. The card stays open.
      e.stopPropagation();
      if (draft) useStageStore.setState({ draft: "" });
      else clearMessage();
    }
  };

  // The operator's own words first, newest first: the one just written is the one marked.
  const chips = [...recent, ...phrases];
  return (
    <Section
      actions={
        <>
          {message ? (
            <Caption className="font-normal">
              <MessageAge since={message.since} />
            </Caption>
          ) : null}
          <Button aria-label={t("stagePanel.removeMessage")} disabled={!message} onClick={clearMessage} size="xs" variant="ghost">
            <Icon name="close" /> {t("stagePanel.remove")}
          </Button>
        </>
      }
      title={t("stagePanel.message")}
    >
      {/* Always two rows high, whatever is showing: more phrases scroll inside, and the card never grows. */}
      <div
        aria-label={t("stagePanel.phrases")}
        className="flex h-[3.75rem] flex-wrap content-start gap-1 overflow-y-auto"
        role="group"
      >
        {chips.map((text) => {
          const on = message?.text === text;
          return (
            <Button
              aria-pressed={on}
              className={cn(on && "border-accent bg-active")}
              key={text}
              onClick={() => send(text)}
              size="xs"
              variant="outline"
            >
              {on ? (
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", message.urgent ? "bg-danger" : "bg-warning")}
                />
              ) : null}
              {text}
            </Button>
          );
        })}
      </div>
      <div className="flex items-center gap-1">
        <Input
          aria-label={t("stagePanel.message")}
          className="w-0 min-w-0 flex-1"
          maxLength={STAGE_MESSAGE_MAX_LENGTH}
          onChange={(e) => useStageStore.setState({ draft: e.target.value })}
          onKeyDown={onKeyDown}
          placeholder={t("stagePanel.messagePlaceholder")}
          ref={field}
          title={t("stagePanel.messageHelp")}
          value={draft}
        />
        <Tooltip floating content={t("stagePanel.urgent")}>
          <IconButton aria-label={t("stagePanel.urgent")} onClick={() => setUrgent(!urgent)} toggled={urgent}>
            <Icon name="alarm" />
          </IconButton>
        </Tooltip>
        <Button disabled={!draft.trim()} onClick={() => send(draft)} variant="primary">
          {t("stagePanel.show")}
        </Button>
      </div>
    </Section>
  );
}

/**
 * Opened, the panel is a card over the left column, like a chat window (owner, 2026-11-13): it grows out of the
 * bar, and its arrow, Esc or a press anywhere else folds it back. It covers the column rather than squeezing it,
 * which is what gives its controls room.
 */
function StageCard({ closing, onClosed }: { closing: boolean; onClosed: () => void }) {
  const t = useT();
  const card = useRef<HTMLDivElement>(null);
  const stageId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const shown = useStageStore((s) => s.shown);
  const where = useDisplayStore((s) => s.displays.find((d) => d.id === stageId)?.label.split(" · ")[0]);

  // Folded even if its transition never ends (a window the OS is not drawing).
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(onClosed, 400);
    return () => clearTimeout(timer);
  }, [closing, onClosed]);

  useEffect(() => {
    if (closing) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !card.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [closing]);

  return (
    /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a non-modal dialog that folds
       on Esc from anywhere inside it: the keys are its controls', the card only answers the one they leave. */
    <div
      aria-label={t("stagePanel.title")}
      className={cn(
        "wa-stage-card absolute inset-x-0 bottom-0 z-30 flex max-h-full flex-col overflow-hidden rounded-t-xl border border-b-0 border-border bg-surface shadow-overlay",
        closing && "wa-stage-card-closing",
      )}
      onTransitionEnd={(e) => {
        if (closing && e.target === e.currentTarget && e.propertyName === "height") onClosed();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
      ref={card}
      role="dialog"
    >
      <div className="flex h-strip shrink-0 items-center gap-2 pr-1.5 pl-3">
        <StatusDot />
        <Title as="h2">{t("stagePanel.title")}</Title>
        <Caption className="min-w-0 truncate font-normal">{shown && where ? where : t("stagePanel.noScreen")}</Caption>
        <span className="flex-1" />
        <Tooltip floating align="end" content={t("stagePanel.close")}>
          <IconButton aria-expanded aria-label={t("stagePanel.close")} onClick={() => setOpen(false)} variant="ghost">
            <Icon name="chevronDown" />
          </IconButton>
        </Tooltip>
      </div>
      <div className="min-h-0 overflow-y-auto border-t border-border">
        <MonitorSection />
        <CountdownSection />
        <MessageSection />
      </div>
    </div>
  );
}

/**
 * «Escenario» (plan 2026-11-13 §2.4): the stage screen run from the work screen — a manual countdown for the
 * preacher, a message to the platform and the view, beside a monitor of what the stage shows. Only while a stage
 * screen is assigned: a church with two screens sees nothing new. A bar at the foot of the left column; opened, a
 * card over it (`StageCard`), never remembered across launches.
 */
export function StagePanel() {
  const open = useStageStore((s) => s.panelOpen);
  // Kept mounted while it folds, until its closing animation ends.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const unmount = useCallback(() => setMounted(false), []);
  return (
    <>
      <StageBar />
      {mounted ? <StageCard closing={!open} onClosed={unmount} /> : null}
    </>
  );
}
