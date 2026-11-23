import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { Icon } from "./icon";
import { IconButton } from "./icon-button";
import { Tooltip } from "./tooltip";
import { faderToGain, formatDb, gainToFader } from "./fader";
import { FLOOR_DB, SCALE_DB, SILENT_CHANNEL, ZONES, isLit, stepMeterChannel, type MeterChannel } from "./level-meter";

/** Left and right, in dBFS (sample peak); `-Infinity` is silence. */
type Level = readonly [number, number];

/** What the meter draws with, read from the theme's tokens: a canvas has no classes. */
const TONES = {
  ok: "text-success-ink",
  warn: "text-warning-ink",
  over: "text-danger-ink",
  track: "text-border",
  peak: "text-foreground",
  scale: "text-subtle",
} as const;
type Tone = keyof typeof TONES;

const BAR_PX = 4;
const BAR_GAP_PX = 2;
const SCALE_CENTER_PX = 2 * BAR_PX + BAR_GAP_PX + 9;
const SCALE_LINE_PX = 11;

/**
 * The stereo meter: two bars and the dB scale, drawn in a canvas. It animates only while something sounds or a peak
 * still holds, and each draw writes what it drew as `data-level-db-l` / `data-level-db-r` («-inf» at the floor), so a
 * test reads the meter, not the store under it.
 */
function LevelMeter({ subscribe }: { subscribe: (listener: (level: Level) => void) => () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tonesRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const tones = tonesRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !tones || !context) return;

    let target: Level = [-Infinity, -Infinity];
    let channels: [MeterChannel, MeterChannel] = [SILENT_CHANNEL, SILENT_CHANNEL];
    const colors = {} as Record<Tone, string>;
    let frame = 0;
    let last = 0;

    const readColors = () => {
      for (const span of tones.children) {
        const tone = (span as HTMLElement).dataset["tone"] as Tone;
        colors[tone] = getComputedStyle(span).color;
      }
    };

    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const y = (db: number) => height * (Math.min(0, Math.max(FLOOR_DB, db)) / FLOOR_DB);

      channels.forEach((channel, index) => {
        const x = index * (BAR_PX + BAR_GAP_PX);
        context.save();
        context.beginPath();
        context.roundRect(x, 0, BAR_PX, height, BAR_PX / 2);
        context.clip();
        context.fillStyle = colors.track;
        context.fillRect(x, 0, BAR_PX, height);
        for (const [from, to, tone] of ZONES) {
          const top = Math.min(channel.shown, to);
          if (top <= from) break;
          context.fillStyle = colors[tone];
          context.fillRect(x, y(top), BAR_PX, y(from) - y(top));
        }
        if (channel.peak > FLOOR_DB) {
          context.fillStyle = colors.peak;
          context.fillRect(x, Math.min(y(channel.peak), height - 2), BAR_PX, 2);
        }
        context.restore();
      });

      // The scale's numbers, each skipped if it would touch the one above (a short monitor).
      context.fillStyle = colors.scale;
      context.font = `${SCALE_LINE_PX}px ${getComputedStyle(canvas).fontFamily}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      let previous = -Infinity;
      for (const db of SCALE_DB) {
        const at = Math.min(height - SCALE_LINE_PX / 2, Math.max(SCALE_LINE_PX / 2, y(db)));
        if (at - previous < SCALE_LINE_PX) continue;
        context.fillText(String(-db), SCALE_CENTER_PX, at);
        previous = at;
      }

      const shown = (channel: MeterChannel) => (channel.shown <= FLOOR_DB ? "-inf" : channel.shown.toFixed(1));
      canvas.dataset["levelDbL"] = shown(channels[0]);
      canvas.dataset["levelDbR"] = shown(channels[1]);
    };

    const tick = (now: number) => {
      frame = 0;
      const dt = last === 0 ? 0 : now - last;
      last = now;
      channels = [stepMeterChannel(channels[0], target[0], now, dt), stepMeterChannel(channels[1], target[1], now, dt)];
      draw();
      if (isLit(channels[0]) || isLit(channels[1])) frame = requestAnimationFrame(tick);
      else last = 0;
    };

    const wake = () => {
      if (frame === 0) frame = requestAnimationFrame(tick);
    };

    const repaint = () => {
      readColors();
      draw();
    };

    const unsubscribe = subscribe((level) => {
      target = level;
      wake();
    });
    const resized = new ResizeObserver(repaint);
    resized.observe(canvas);
    // The theme's colours, when the operator switches it.
    const themed = new MutationObserver(repaint);
    themed.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => {
      unsubscribe();
      resized.disconnect();
      themed.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [subscribe]);

  return (
    <>
      <canvas aria-hidden="true" className="h-full w-7 min-w-0" data-level-db-l="-inf" data-level-db-r="-inf" ref={canvasRef} />
      <span hidden ref={tonesRef}>
        {Object.entries(TONES).map(([tone, className]) => (
          <span className={className} data-tone={tone} key={tone} />
        ))}
      </span>
    </>
  );
}

type ChannelStripProps = {
  /** Muted is an alarm here (LIVE: the room hears nothing), not the resting state (PREVIEW starts silent, so its
   *  mute icon is only dimmed). */
  alarmWhenMuted?: boolean;
  className?: string;
  /** Names the strip: «Sonido de EN VIVO». */
  label: string;
  /** Whether the strip is silent: what the mute button's pressed state and icon say. */
  muted: boolean;
  /** The mute button's name, constant («Silenciar EN VIVO»): the state is `aria-pressed`, never a second label. */
  muteLabel: string;
  /** Every step of the fader, with the level its gesture started from (`from`): a drag or a held key down to 0 is a
   *  mute, and what it comes back to is where the hand started, never the last step before 0. */
  onChange: (volume: number, from: number) => void;
  onToggleMute: () => void;
  /** The output control at the strip's foot. */
  output: ReactNode;
  /** Feeds the meter without a re-render per level: called once per mount, returns its unsubscribe. Keep it stable. */
  subscribeLevels: (listener: (level: Level) => void) => () => void;
  /** 0..1, the level as a linear gain (0 while muted by the strip's own mute); where the fader stands for it is `fader.ts`. */
  value: number;
  /** The fader's own name: «Volumen general de EN VIVO». */
  volumeLabel: string;
};

/**
 * A mixer's channel strip, sized to stand beside a monitor (owner's sketch A, 2026-11-15): 48 px wide and as tall as
 * whatever row it is in, never taller: its content is laid out inside an absolute box, so it adds no height of its
 * own and the monitor beside it stays the one that sizes the row (`monitor-stage-must-size-by-width-not-flex.md`;
 * a canvas alone is 150 px tall by default). Top to bottom: the stereo meter with its dB scale and the fader beside it, then mute, then
 * the output control.
 *
 * The fader is a native `<input type="range">` stood up with `writing-mode` (the keyboard, `pointercancel` and a
 * screen reader's value come with it). It moves on OBS's log scale (`fader.ts`) and reports the same 0..1 gain as every
 * volume in the app, said in dB.
 */
export function ChannelStrip({
  alarmWhenMuted = false,
  className,
  label,
  muted,
  muteLabel,
  onChange,
  onToggleMute,
  output,
  subscribeLevels,
  value,
  volumeLabel,
}: ChannelStripProps) {
  const db = formatDb(value);
  const position = Math.round(gainToFader(value) * 100);
  // Taken when a drag or a key press starts, not on a held key's repeats: those are the same gesture.
  const gestureFrom = useRef(value);
  const beginGesture = () => {
    gestureFrom.current = value;
  };

  return (
    <div aria-label={label} className={cn("relative w-12 shrink-0", className)} role="group">
      <div className="absolute inset-0 flex flex-col items-center gap-1 pt-1">
      <div className="flex min-h-0 w-full flex-1 justify-center gap-0.5">
        <LevelMeter subscribe={subscribeLevels} />
        <input
          aria-label={volumeLabel}
          aria-valuetext={db}
          className="fader h-full min-h-0 w-4 cursor-pointer [direction:rtl] [writing-mode:vertical-lr]"
          max={100}
          min={0}
          onChange={(event) => onChange(faderToGain(Number(event.currentTarget.value) / 100), gestureFrom.current)}
          onKeyDown={(event) => {
            if (!event.repeat) beginGesture();
          }}
          onPointerDown={beginGesture}
          step={1}
          style={{ "--fill": `${position}%` } as CSSProperties}
          title={db}
          type="range"
          value={position}
        />
      </div>
      <Tooltip content={muteLabel}>
        <IconButton aria-label={muteLabel} aria-pressed={muted} onClick={onToggleMute} size="xs" variant="ghost">
          <Icon
            className={cn(muted && (alarmWhenMuted ? "text-danger-ink" : "text-subtle"))}
            name={muted ? "volumeOff" : "volume"}
          />
        </IconButton>
      </Tooltip>
      {output}
      </div>
    </div>
  );
}
