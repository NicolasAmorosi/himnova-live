import { useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/utils";
import { sceneTextCss as textStyle } from "./scene-text";
import { StageImage } from "./stage-image";
import { useTimerNow } from "@renderer/lib/hooks/use-timer-now";
import { isAnimatable, transitionStyle, LEAVE_FALLBACK_MARGIN_MS, type LayerRole } from "@renderer/lib/transition";
import { formatTimerClock, hasReachedZero, pickValueColor } from "@shared/timer";
import {
  cssFontFamily,
  cssSceneBackground,
  type SceneStyle,
  type SceneTextStyle,
  type SceneVerticalAlign,
} from "@shared/types/scene-style";
import type { ProjectionOutput } from "@shared/types/projection";

export type TimerOutput = Extract<ProjectionOutput, { kind: "timer" }>;

/** `cqw` and not `cqh`, which is what these two were until it was measured:
 *  `OutputView`'s root is an `inline-size` container, so it has no block axis
 *  to query and a `cqh` inside it silently resolves against the small VIEWPORT
 *  instead — the whole control window, which on a 240px confidence monitor is
 *  a gutter several times the height of the monitor itself. The same trap
 *  `SlideVideo`'s overlay documents in `output-view.tsx`. 4.5 cqw is the 8% of
 *  the height these meant to be, on a 16:9 stage. */
const VERTICAL_ALIGN: Record<SceneVerticalAlign, string> = {
  top: "justify-start pt-[4.5cqw]",
  middle: "justify-center",
  bottom: "justify-end pb-[4.5cqw]",
};

/**
 * One reading of the scene: the three lines exactly as they should be drawn
 * at this instant, with every end-state decision already made. `null` means
 * the line is not there at all — whether because the scene has no such text
 * or because the end state hides it, which the renderer below has no reason
 * to tell apart.
 *
 * It exists so the outgoing half of a fade can be SNAPSHOTTED. Without it the
 * layer that is supposed to be showing what the scene said before zero would
 * go on ticking underneath the new one, and for a few hundred milliseconds
 * the screen would hold two different answers to the same question.
 */
type Composition = {
  message: string | null;
  messageStyle: SceneTextStyle;
  title: string | null;
  value: string | null;
  valueColor: string;
};

/**
 * A generated time scene, drawn from an absolute mark.
 *
 * This component is the whole reason the projection window can show a running
 * countdown without anybody pushing it sixty values a minute: the
 * `ProjectionOutput` holds a fixed instant, and the ticking lives here, in the
 * leaf that renders it. Nothing above re-renders per second — not the layer,
 * not `OutputView`, not `ProjectionApp` — so the scene never re-animates and
 * `sceneContentKey` never moves.
 *
 * Three things are decided here rather than upstream, and all three are
 * FORMATTING of the very same mark (see `TimerFormat`): clamping at zero or
 * running into negative numbers, the whole end state (the message swap with
 * its own type, the two optional hides and the fade between the two readings
 * — see `SceneEnd`), and the colour triggers. Having the control window
 * decide any of them would mean a clock in the control window and a push at
 * the instant zero passes — which is a full scene transition one minute
 * before the service starts.
 *
 * Rendered by the projector AND by both confidence monitors, through
 * `OutputView`, so what the operator reads is the same number the
 * congregation reads, formatted by the same function. The end fade runs in
 * every mode, unlike `OutputView`'s own scene transitions (which a PREVIEW
 * monitor never plays): this one is not a change of scene, it is part of how
 * this scene draws itself, and a monitor that cut where the projector fades
 * would be a monitor telling the operator something untrue.
 */
export function TimerScene({
  onImageError,
  output,
}: {
  onImageError?: ((url: string) => void) | undefined;
  output: TimerOutput;
}) {
  const { backgroundUrl, clock, endMessage, format, style, title } = output;
  const now = useTimerNow(clock, format);

  // Everything about the end state hangs off this one boolean, which is false
  // for anything that is not a countdown at or past zero.
  const ended = hasReachedZero(clock, now);
  // The end message only replaces the normal one once the countdown is at or
  // past zero; a scene without one keeps showing whatever it had — and keeps
  // its own style with it, because the line did not change.
  const showsEndMessage = ended && endMessage !== null;
  // The two opt-in hides. Applied at zero whether or not there is an end
  // message: what the scene reads like when the count runs out is the
  // operator's composition, and «just the message» and «nothing but the background»
  // are both things they may have meant.
  const composition: Composition = {
    message: (showsEndMessage ? endMessage : output.message) ?? null,
    messageStyle: showsEndMessage ? style.end.message : style.message,
    title: ended && style.end.hideTitle ? null : title,
    value: ended && style.end.hideValue ? null : formatTimerClock(clock, now, format),
    valueColor: pickValueColor(clock, now, style.value.color, style.triggers),
  };

  const leaving = useEndTransition(ended, style.end.transition, composition);

  const background = cssSceneBackground(style.background);
  // Narrowed once, rather than re-tested inside the JSX: `background.kind`
  // does not narrow through a boolean.
  const imageBackground = style.background.kind === "image" ? style.background : null;

  return (
    <>
      {background ? <div className="absolute inset-0" style={{ background }} /> : null}

      {imageBackground && backgroundUrl ? (
        <StageImage
          className="absolute inset-0 size-full"
          onError={() => onImageError?.(backgroundUrl)}
          src={backgroundUrl}
          style={{ objectFit: imageBackground.fit }}
        />
      ) : null}

      {/* Only the TEXT is layered: the background does not change when the
          count runs out, and fading it into a copy of itself would be a
          visible dip for nothing. */}
      <SceneText
        composition={composition}
        layerRole={leaving ? "entering" : "steady"}
        style={style}
        transition={style.end.transition}
      />
      {leaving ? (
        <SceneText
          composition={leaving.composition}
          key={leaving.seq}
          layerRole="leaving"
          onLeaveComplete={leaving.complete}
          style={style}
          transition={style.end.transition}
        />
      ) : null}
    </>
  );
}

/** What the outgoing half of a fade is, while there is one. `seq` keys it, so
 *  a second crossing arriving mid-fade mounts a fresh layer instead of
 *  inheriting the animation state of the one it replaces. */
type LeavingLayer = { composition: Composition; complete: () => void; seq: number };

/**
 * Turns "the count just crossed zero" into an outgoing layer that fades out.
 *
 * Crossing BOTH ways, deliberately: restart on a countdown that had already
 * run out walks the scene back from its end state, and the operator who asked
 * for a fade into it asked for the same fade out of it.
 *
 * The very first render never animates, whichever side of zero it is on — an
 * armed scene sent live at 00:00 is a new scene, and fading it into itself is
 * `OutputView`'s job, not this one's.
 */
function useEndTransition(
  ended: boolean,
  transition: SceneStyle["end"]["transition"],
  composition: Composition,
): LeavingLayer | null {
  const [leaving, setLeaving] = useState<LeavingLayer | null>(null);
  /** The reading this scene had BEFORE the commit being processed. Kept in a
   *  ref and refreshed by the effect below, which is declared after the one
   *  that reads it — effects run in declaration order, so the crossing is
   *  always handed the composition it is leaving behind and never the one it
   *  is arriving at. */
  const previousRef = useRef(composition);
  const endedRef = useRef(ended);
  const seqRef = useRef(0);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (endedRef.current === ended) return;
    endedRef.current = ended;
    if (!isAnimatable(transition)) return;

    seqRef.current += 1;
    const seq = seqRef.current;
    // Guarded by `seq` and nothing else, so it is safe to call twice and safe
    // to call late: a fallback timer that fires after a SECOND crossing has
    // already replaced this layer finds a different `seq` and does nothing.
    const drop = () => setLeaving((current) => (current?.seq === seq ? null : current));
    setLeaving({ composition: previousRef.current, complete: drop, seq });

    // The fallback that makes `animationend` optional — same reasoning as
    // `OutputView`'s: an occluded Electron window has no rendering lifecycle,
    // so no animation frames and no `animationend`, and `animation-fill-mode:
    // both` would pin the outgoing layer at full opacity on top of the new
    // reading forever. See
    // `.claude/knowledge/occluded-electron-window-has-no-rendering-lifecycle.md`.
    if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = setTimeout(drop, transition.durationMs + LEAVE_FALLBACK_MARGIN_MS);
  }, [ended, transition]);

  useEffect(() => {
    previousRef.current = composition;
  });

  // Unmount only: the effect above owns its own timer across crossings, and
  // clearing it on every tick would cancel a fade that is still in flight.
  useEffect(
    () => () => {
      if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
    },
    [],
  );

  return leaving;
}

/** One reading of the scene's text, as a full-frame layer. Two of these are
 *  stacked while the end fade is in flight and exactly one is mounted the
 *  rest of the time.
 *
 *  `layerRole` and not `role`, which is what `SceneLayer` calls the same
 *  prop: `jsx-a11y` reads a literal `role="leaving"` on any JSX element as an
 *  ARIA role and rejects it, and a prop renamed is better than a rule
 *  suppressed for something that was never about accessibility. */
function SceneText({
  composition,
  layerRole,
  onLeaveComplete,
  style,
  transition,
}: {
  composition: Composition;
  layerRole: LayerRole;
  onLeaveComplete?: (() => void) | undefined;
  style: SceneStyle;
  transition: SceneStyle["end"]["transition"];
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col items-center gap-[1.2cqw] px-[6cqw] text-center",
        VERTICAL_ALIGN[style.verticalAlign],
      )}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && layerRole === "leaving") onLeaveComplete?.();
      }}
      style={{
        fontFamily: cssFontFamily(style.fontFamily),
        ...transitionStyle(layerRole, transition, 1),
      }}
    >
      {composition.title !== null ? <p style={textStyle(style.title)}>{composition.title}</p> : null}
      {/* `tabular-nums` is not cosmetic: with proportional digits every
          second changes the string's width and the whole number shuffles
          sideways, which on a three-metre screen is the only thing anybody
          looks at. `leading-none` keeps a 20cqw number from reserving half
          the frame in line-height it does not use. */}
      {composition.value !== null ? (
        <p className="leading-none tabular-nums" style={textStyle(style.value, composition.valueColor)}>
          {composition.value}
        </p>
      ) : null}
      {composition.message ? <p style={textStyle(composition.messageStyle)}>{composition.message}</p> : null}
    </div>
  );
}
