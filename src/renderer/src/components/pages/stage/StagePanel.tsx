import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { cn } from "@renderer/lib/utils";
import { useTimerNow } from "@renderer/lib/hooks/use-timer-now";
import { Button, Caption, Icon, IconButton, Input, Menu, Title, Tooltip, type IconName } from "@renderer/components/ui";
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
/** Longer than any service: what the minutes field takes. */
const MAX_COUNTDOWN_MS = 5 * 60 * MINUTE;
const TICK_FORMAT: TimerFormat = { hour12: false, showSeconds: true, hideZeroHours: true, overrun: true };
const HELD: TimerClock = { mode: "countdown", state: "held", remainingMs: 0 };

/** The countdown's colour in the control window: the stage's, in this theme's inks. */
const TONE_INK: Record<CountdownTone, string> = {
  normal: "text-foreground",
  warn: "text-warning-ink",
  alert: "text-danger-ink",
  over: "text-danger-ink",
};

/** The countdown as the panel reads it, ticking with the same clock the stage uses. */
function useCountdownReadout(): { text: string; tone: CountdownTone; running: boolean } | null {
  const countdown = useStageStore((s) => s.countdown);
  const warnMs = useSettingsStore((s) => s.settings["stage.warnMs"]);
  const alertMs = useSettingsStore((s) => s.settings["stage.alertMs"]);
  const now = useTimerNow(countdown?.clock ?? HELD, TICK_FORMAT);
  if (!countdown) return null;
  const thresholds = stageThresholds(countdown.totalMs, warnMs, alertMs);
  return {
    text: formatCountdown(countdown.clock, now),
    tone: countdownTone({ clock: countdown.clock, ...thresholds }, now),
    running: countdown.clock.state === "running",
  };
}

/** «Visible hace 1:20», so a message is never left on the platform forgotten. */
function MessageAge({ since }: { since: number }) {
  const t = useT();
  const clock = useMemo<TimerClock>(() => ({ mode: "stopwatch", state: "running", startedAtMs: since }), [since]);
  const now = useTimerNow(clock, TICK_FORMAT);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span aria-label={t("stagePanel.visibleFor", { time: formatSignedSeconds(seconds, TICK_FORMAT) })} className="tabular-nums">
      {formatSignedSeconds(seconds, TICK_FORMAT)}
    </span>
  );
}

/** The panel's bar — and all of it while folded: whether the stage is on screen, the countdown, the message, the
 *  layout and the fold. */
function StageBar({ open }: { open: boolean }) {
  const t = useT();
  const shown = useStageStore((s) => s.shown);
  const message = useStageStore((s) => s.message);
  const layout = useSettingsStore((s) => s.settings["stage.layout"]);
  const readout = useCountdownReadout();
  const { clearMessage, toggleCountdown } = useStageStore.getState();
  const update = useSettingsStore((s) => s.update);

  return (
    <div className="flex h-strip shrink-0 items-center gap-1.5 border-b border-border px-1.5">
      <Tooltip content={shown ? t("stagePanel.shown") : t("stagePanel.notShown")}>
        <span className="flex items-center gap-1.5 px-1.5">
          <span
            aria-label={shown ? t("stagePanel.shown") : t("stagePanel.notShown")}
            className={cn("size-2 shrink-0 rounded-full", shown ? "bg-success" : "bg-danger")}
            role="img"
          />
          <Title as="h2">{t("stagePanel.title")}</Title>
        </span>
      </Tooltip>
      {readout && !open ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <span className={cn("text-sm font-semibold tabular-nums", TONE_INK[readout.tone])}>{readout.text}</span>
          <Tooltip content={readout.running ? t("stagePanel.pause") : t("stagePanel.resume")}>
            <IconButton
              aria-label={readout.running ? t("stagePanel.pause") : t("stagePanel.resume")}
              onClick={toggleCountdown}
              size="xs"
              variant="ghost"
            >
              <Icon name={readout.running ? "pause" : "play"} />
            </IconButton>
          </Tooltip>
        </span>
      ) : null}
      {message ? (
        <span className="flex min-w-0 items-center gap-0.5">
          <Icon className={message.urgent ? "text-danger-ink" : "text-warning-ink"} name="alert" />
          <span className="min-w-0 truncate text-xs">{message.text}</span>
          <Caption className="shrink-0">
            <MessageAge since={message.since} />
          </Caption>
          <Tooltip content={t("stagePanel.removeMessage")}>
            <IconButton aria-label={t("stagePanel.removeMessage")} onClick={clearMessage} size="xs" variant="ghost">
              <Icon name="close" />
            </IconButton>
          </Tooltip>
        </span>
      ) : null}
      <span className="flex-1" />
      <Menu<StageLayoutChoice>
        align="end"
        icon="columns"
        label={`${t("stagePanel.layout")}: ${t(`stagePanel.layouts.${layout}`)}`}
        onSelect={(value) => void update({ "stage.layout": value })}
        options={STAGE_LAYOUT_CHOICES.map((value) => ({ label: t(`stagePanel.layouts.${value}`), value }))}
        size="xs"
        value={layout}
      />
      <Tooltip align="end" content={open ? t("stagePanel.fold") : t("stagePanel.unfold")}>
        <IconButton
          aria-expanded={open}
          aria-label={open ? t("stagePanel.fold") : t("stagePanel.unfold")}
          onClick={() => void update({ "stage.panelOpen": !open })}
          size="sm"
          variant="ghost"
        >
          <Icon name={open ? "chevronDown" : "chevronUp"} />
        </IconButton>
      </Tooltip>
    </div>
  );
}

/** The countdown's two rows: its readout and transport, then the lengths. The field takes minutes («30»), or a
 *  time of day to count down to («10:45»). */
function CountdownRows() {
  const t = useT();
  const countdown = useStageStore((s) => s.countdown);
  const readout = useCountdownReadout();
  const { armCountdown, clearCountdown, countdownUntil, nudgeCountdown, resetCountdown, toggleCountdown } =
    useStageStore.getState();
  const [custom, setCustom] = useState("");

  const submit = () => {
    const text = custom.trim();
    if (text.includes(":")) {
      const minute = parseMinuteOfDay(text);
      if (minute === null) return;
      countdownUntil(minute);
    } else {
      const ms = parseDuration(text);
      if (ms === null || ms <= 0 || ms > MAX_COUNTDOWN_MS) return;
      armCountdown(ms);
    }
    setCustom("");
  };
  const tool = (label: string, icon: IconName, onClick: () => void, disabled = false) => (
    <Tooltip content={label}>
      <IconButton aria-label={label} disabled={disabled} onClick={onClick} size="xs" variant="ghost">
        <Icon name={icon} />
      </IconButton>
    </Tooltip>
  );
  const started = countdown !== null && (countdown.clock.state === "running" || countdown.clock.remainingMs !== countdown.totalMs);

  return (
    <>
      <div aria-label={t("stagePanel.countdown")} className="flex min-w-0 items-center gap-0.5" role="group">
        <span
          className={cn("mr-auto min-w-0 truncate text-lg leading-none font-semibold tabular-nums", readout ? TONE_INK[readout.tone] : "text-subtle")}
          role="timer"
        >
          {readout?.text ?? t("stagePanel.noCountdown")}
        </span>
        {tool(
          readout?.running ? t("stagePanel.pause") : started ? t("stagePanel.resume") : t("stagePanel.start"),
          readout?.running ? "pause" : "play",
          toggleCountdown,
          !countdown,
        )}
        {tool(t("stagePanel.reset"), "restart", resetCountdown, !started)}
        <Tooltip content={t("stagePanel.minus")}>
          <Button aria-label={t("stagePanel.minus")} className="h-6 px-1" disabled={!countdown} onClick={() => nudgeCountdown(-MINUTE)} size="xs" variant="ghost">
            −1
          </Button>
        </Tooltip>
        <Tooltip content={t("stagePanel.plus")}>
          <Button aria-label={t("stagePanel.plus")} className="h-6 px-1" disabled={!countdown} onClick={() => nudgeCountdown(MINUTE)} size="xs" variant="ghost">
            +1
          </Button>
        </Tooltip>
        {tool(t("stagePanel.clearCountdown"), "close", clearCountdown, !countdown)}
      </div>
      <div aria-label={t("stagePanel.presets")} className="flex min-w-0 items-center gap-0.5" role="group">
        {STAGE_PRESET_MINUTES.map((m) => (
          <Tooltip className={cn("min-w-0 flex-1", m % 10 === 5 && m !== 45 && "@max-[24rem]/stage:hidden")} content={t("stagePanel.preset", { minutes: m })} key={m}>
            <Button
              aria-label={t("stagePanel.preset", { minutes: m })}
              className="w-full px-0"
              onClick={() => armCountdown(m * MINUTE)}
              size="xs"
              variant="outline"
            >
              {m}
            </Button>
          </Tooltip>
        ))}
        <Input
          aria-label={t("stagePanel.custom")}
          className="ml-0.5 w-0 min-w-14 flex-[1.6]"
          onBlur={submit}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={t("stagePanel.customPlaceholder")}
          size="xs"
          value={custom}
        />
      </div>
    </>
  );
}

/** The message: a field (Enter shows it, Esc drops the draft and then takes the message off), urgent, show and
 *  take off. */
function MessageRow() {
  const t = useT();
  const message = useStageStore((s) => s.message);
  const draft = useStageStore((s) => s.draft);
  const urgent = useStageStore((s) => s.draftUrgent);
  const field = useRef<HTMLInputElement>(null);
  const { clearMessage, setUrgent } = useStageStore.getState();
  const send = useSendMessage();

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
      // A draft is dropped first; with nothing typed, Esc takes the message off the stage.
      if (draft) useStageStore.setState({ draft: "" });
      else clearMessage();
    }
  };

  return (
    // Under the monitor, the whole width, in a narrow column: beside it there is no room to type.
    <div aria-label={t("stagePanel.message")} className="flex min-w-0 items-center gap-0.5 @max-[24rem]/stage:col-span-2" role="group">
      <Input
        aria-label={t("stagePanel.message")}
        className="w-0 min-w-0 flex-1"
        maxLength={STAGE_MESSAGE_MAX_LENGTH}
        onChange={(e) => useStageStore.setState({ draft: e.target.value })}
        onKeyDown={onKeyDown}
        placeholder={t("stagePanel.messagePlaceholder")}
        ref={field}
        size="xs"
        value={draft}
      />
      <Tooltip content={t("stagePanel.urgent")}>
        <IconButton aria-label={t("stagePanel.urgent")} onClick={() => setUrgent(!urgent)} size="xs" toggled={urgent} variant="ghost">
          <Icon name="alarm" />
        </IconButton>
      </Tooltip>
      <Button className="h-7" disabled={!draft.trim()} onClick={() => send(draft)} size="xs" variant="outline">
        {t("stagePanel.show")}
      </Button>
      <Tooltip align="end" content={t("stagePanel.removeMessage")}>
        <IconButton aria-label={t("stagePanel.removeMessage")} disabled={!message} onClick={clearMessage} size="xs" variant="ghost">
          <Icon name="close" />
        </IconButton>
      </Tooltip>
    </div>
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

/** The ready phrases and the last three the operator wrote: one click shows one. */
function Phrases() {
  const t = useT();
  const message = useStageStore((s) => s.message);
  const settings = useSettingsStore((s) => s.settings);
  const send = useSendMessage();
  const phrases = settings["stage.phrases"] ?? t("stage.defaultPhrases").split("\n");
  const recent = settings["stage.recentMessages"].filter((text) => !phrases.includes(text));
  return (
    <div
      aria-label={t("stagePanel.phrases")}
      className="flex items-center gap-1 overflow-x-auto px-1.5 pb-1.5 [scrollbar-width:none]"
      // A mouse wheel scrolls the row: on Windows a wheel has no sideways, and the last phrases were out of reach.
      onWheel={(e) => {
        e.currentTarget.scrollLeft += e.deltaY;
      }}
      role="group"
    >
      {[...phrases, ...recent].map((text) => (
        <Button
          aria-pressed={message?.text === text}
          className={cn("shrink-0", message?.text === text && "border-accent")}
          key={text}
          onClick={() => send(text)}
          size="xs"
          variant="outline"
        >
          {text}
        </Button>
      ))}
    </div>
  );
}

/** The stage screen's own picture, at that screen's proportion: exactly what the stage draws (`StageView`, from
 *  the `StageOutput` it was last sent). */
function StageMonitor() {
  const t = useT();
  const output = useStageStore((s) => s.output);
  const stageId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const display = useDisplayStore((s) => s.displays.find((d) => d.id === stageId));
  const [w, h] = display ? [display.bounds.width, display.bounds.height] : [16, 9];
  return (
    // As tall as the rows beside it (three, or two in a narrow column), narrower when the column is: at that
    // screen's proportion either way.
    <div className="row-span-3 flex min-w-0 items-start justify-center [--monitor-h:5.75rem] @max-[24rem]/stage:row-span-2 @max-[24rem]/stage:[--monitor-h:3.75rem]">
      <div
        aria-label={t("stagePanel.monitor")}
        className="overflow-hidden rounded-md border border-border"
        role="img"
        style={{ aspectRatio: `${w} / ${h}`, width: `min(100%, calc(var(--monitor-h) * ${w} / ${h}))` }}
      >
        <StageView stage={output} />
      </div>
    </div>
  );
}

/**
 * «Escenario» (plan 2026-11-13 §2.4): the stage screen run from the work screen — a manual countdown for the
 * preacher, a message to the platform and the layout, next to a monitor of what the stage shows. At the foot of
 * the left column, and only while a stage screen is assigned: a church with two screens sees nothing new. Folded,
 * its bar alone; remembered.
 */
export function StagePanel() {
  const t = useT();
  const open = useSettingsStore((s) => s.settings["stage.panelOpen"]);
  return (
    <section aria-label={t("stagePanel.title")} className="flex shrink-0 flex-col border-t border-border bg-surface">
      <StageBar open={open} />
      {open ? (
        <>
          <div className="@container/stage grid grid-cols-[minmax(0,38%)_minmax(0,1fr)] grid-rows-[repeat(3,1.75rem)] gap-x-2 gap-y-1 p-1.5">
            <StageMonitor />
            <CountdownRows />
            <MessageRow />
          </div>
          <Phrases />
        </>
      ) : null}
    </section>
  );
}
