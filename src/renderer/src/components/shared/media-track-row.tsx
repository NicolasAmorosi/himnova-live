import { useState } from "react";
import { Button, IconButton, Icon, MediaScrubber, VolumeControl, type IconName } from "@renderer/components/ui";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { cn, formatClock } from "@renderer/lib/utils";

export type MediaTrackKind = "video" | "audio" | "image" | "bible" | "utility" | "plate" | "song";

type MediaTrackRowProps = {
  className?: string;
  currentSeconds?: number;
  /** Omit entirely for content with no timeline (an image) — the row then
   *  skips the pause button and the whole transport line below, instead of
   *  showing a meaningless 0:00/0:00 and an empty bar. Such a row stays a
   *  single line: the different height is real information ("this has no
   *  time"), not an alignment defect. */
  durationSeconds?: number | undefined;
  /** What the projector reported it could not play, already translated.
   *  Replaces `hint` and re-tones the row — a track the operator believes is
   *  sounding, and isn't, is worth more than a tidy row. */
  error?: string | undefined;
  kind: MediaTrackKind;
  label: string;
  /** Compact last line of the row — e.g. "Silent until GO LIVE". Part of the
   *  row itself (not a sibling paragraph) so every caller gets it inside the
   *  same bordered container for free. Below the position line, never above
   *  it: the PREVIEW row carries a hint its LIVE twin across does not, and a
   *  line between the two would put the one bar lower than the other. */
  hint?: string | undefined;
  /** The row's own GO LIVE — for content that goes up WITHOUT replacing what
   *  is projected (a plate), so the operator sends it from beside its picture
   *  instead of reaching for the top bar. Calls `goLive()`, never a second
   *  path to the projector. */
  onGoLive?: (() => void) | undefined;
  /** Shown INSTEAD of `onGoLive` once that content is up: takes it back down
   *  without touching anything under it. */
  onTakeDown?: (() => void) | undefined;
  /** Omit to render the row without a seek control at all (duration unknown yet). */
  onSeek?: ((seconds: number) => void) | undefined;
  /** Clears this media back to nothing live — a video, a live PPT deck, or a
   *  live image. Distinct from `onStop`: this empties the projector's own
   *  content, not just a standalone audio track. */
  onDelete?: (() => void) | undefined;
  /** Present only where stopping makes sense — a standalone audio track.
   *  Absent for the video row and the deck's own music: nothing should be
   *  able to cut what's on the projector from here (that's `onDelete`'s job
   *  instead, where offered). */
  onStop?: (() => void) | undefined;
  /** Present only for a row that actually controls playback (the live panel).
   *  Absent in the preview bar, which only picks a start point. */
  onTogglePause?: (() => void) | undefined;
  /** Accessible names for that button. A timer is never «played»: it is
   *  started, paused and resumed, and which of the two words a stopped one
   *  deserves is the caller's to know (see `UtilityTrackRow`). */
  pauseLabel?: string | undefined;
  playLabel?: string | undefined;
  paused?: boolean;
  /** Back to the start, beside the pause button. Only where restarting means
   *  something on its own: a timer restarts, a track is scrubbed to 0. */
  onRestart?: (() => void) | undefined;
  /** A value this row shows instead of deriving one from a timeline — a
   *  timer's own digits, which no `currentSeconds` can produce (a wall clock
   *  has no position, and a countdown's number runs backwards and may be
   *  negative). Sits between the label and the controls, always visible. */
  readout?: string | undefined;
  readoutTone?: MediaTrackReadoutTone;
  /** A word beside the readout, in the danger ink — «Ended». Ignored
   *  without a `readout`. */
  readoutNote?: string | undefined;
  /** Omit the pair to render the row without a level control — an image or a
   *  verse has nothing to turn down, and the preview bar reaches no speaker. */
  onVolumeChange?: ((volume: number) => void) | undefined;
  /** 0..1. Required whenever `onVolumeChange` is given. */
  volume?: number | undefined;
};

/** What the readout means right now: counting, stopped, or a countdown that
 *  has run out. The last one has to be readable from across a dark booth — the
 *  projector will never say so (it just rests at 00:00). */
export type MediaTrackReadoutTone = "default" | "muted" | "danger";

const readoutToneClass: Record<MediaTrackReadoutTone, string> = {
  default: "text-foreground",
  muted: "text-subtle",
  danger: "text-danger-ink",
};

const kindIcon: Record<MediaTrackKind, IconName> = {
  video: "video",
  audio: "audio",
  image: "image",
  bible: "bible",
  // Generic on purpose: the row is labelled with the scene's own name, and
  // the tool's specific icon is what the list in the Utilities tab shows.
  utility: "clock",
  plate: "overlay",
  song: "song",
};
// "bible" never carries a duration, so this is never actually read for it —
// present only to keep the Record exhaustive.
const kindTone: Record<MediaTrackKind, "accent" | "audio"> = {
  video: "accent",
  audio: "audio",
  image: "accent",
  bible: "accent",
  utility: "accent",
  plate: "accent",
  song: "accent",
};

/**
 * `formatClock` widens its output past a bucket boundary (`m:ss` → `mm:ss` →
 * `h:mm:ss`), so both clocks are sized to the widest string this particular
 * duration can actually produce (in `ch`, which matches `tabular-nums` digit
 * width). Two effects, both load-bearing now that the scrubber sits between
 * them: no dead space inside a short clock, and the bar never resizes under
 * the pointer when the running clock crosses 9:59.
 */
function clockWidthClass(durationSeconds: number): string {
  if (durationSeconds >= 3600) return "w-[7ch]"; // h:mm:ss
  if (durationSeconds >= 600) return "w-[5ch]"; // mm:ss
  return "w-[4ch]"; // m:ss
}

/**
 * One row of the media transport UI — the live global panel, the preview
 * bar and the image-in-live row are all built from this, so they can never
 * drift in shape. Everything the operator needs to read (what it is, where it
 * is, how long it is) is always visible; nothing is behind a hover.
 *
 * ## The two lines
 *
 * **Identity and commands on top, position below.** The first line is icon,
 * name and every *control* (pause, level, dismiss); the second is the seek
 * bar spanning the full width, flanked by its two clocks. Stacking them is
 * what makes a row with several controls legible: while the scrubber shared
 * the first line it was squeezed to a `w-28` stub between fixed-size buttons,
 * which is both an unusable seek target and a visually crowded row. Full
 * width also means the bar's pixels map to the track at a useful resolution —
 * a second of a 40-minute sermon is no longer a sub-pixel.
 *
 * Between the two sits the optional `readout`: a value that is not a position
 * on any timeline, which is what a timer's number is (a wall clock has none, a
 * countdown's runs backwards and can go negative). It is text, not a control,
 * so it goes with the identity half of the line rather than with the buttons.
 *
 * Every control on the first line is a fixed-size `IconButton`, and the label
 * is the only element allowed to grow or shrink (`min-w-0 flex-1 truncate`) —
 * a very long file name eats into the label's own space, it never pushes a
 * button out of the row, and the controls always land in the same spot
 * regardless of label length.
 *
 * Content with no timeline (an image, a verse, a text) renders the first line
 * only — see `durationSeconds`.
 */
export function MediaTrackRow({
  className,
  currentSeconds = 0,
  durationSeconds,
  error,
  kind,
  label,
  hint,
  onSeek,
  onDelete,
  onGoLive,
  onRestart,
  onStop,
  onTakeDown,
  onTogglePause,
  pauseLabel,
  playLabel,
  paused = false,
  readout,
  readoutNote,
  readoutTone = "default",
  onVolumeChange,
  volume,
}: MediaTrackRowProps) {
  const t = useT();
  const hasTiming = durationSeconds !== undefined;
  // Where the scrubber is painting while it is ahead of the reported position
  // — dragging, or holding a committed seek until the projector confirms it.
  // The clock reads this instead of `currentSeconds` so the operator can see
  // the second he is about to jump to, and so the two halves of the same
  // control can never show different positions.
  const [scrubSeconds, setScrubSeconds] = useState<number | null>(null);

  return (
    <div className={cn("flex flex-col gap-1 px-2 py-1.5", className)}>
      <div className={cn("flex items-center gap-2", paused && "opacity-70")}>
        <Icon
          className={cn(
            "size-4 shrink-0",
            error ? "text-danger-ink" : kind === "audio" ? "text-badge-audio-ink" : "text-accent-ink",
          )}
          name={error ? "alert" : kindIcon[kind]}
        />

        <span
          className={cn("min-w-0 flex-1 truncate text-sm", paused ? "text-muted-foreground" : "text-foreground")}
        >
          {label}
        </span>

        {readout ? (
          <span
            className={cn(
              "shrink-0 whitespace-nowrap text-sm font-medium tabular-nums",
              readoutToneClass[readoutTone],
            )}
          >
            {readout}
          </span>
        ) : null}

        {readout && readoutNote ? (
          <span className="shrink-0 whitespace-nowrap text-xs text-danger-ink">{readoutNote}</span>
        ) : null}

        {/* `h-6`, the height of every `IconButton` beside it: an `xs` Button
            is `h-7`, and it made the PREVIEW row of a plate 4px taller than
            the LIVE one across. */}
        {onTakeDown ? (
          <Button className="h-6 shrink-0" onClick={onTakeDown} size="xs" variant="outline">
            {t("media.takeDown")}
          </Button>
        ) : onGoLive ? (
          // The top bar's GO LIVE, same variant and wording: it does exactly
          // what that button does with this row's content in preview.
          <Button className="h-6 shrink-0" onClick={onGoLive} size="xs" variant="live">
            <Icon name="play" />
            {t("actions.goLive")}
          </Button>
        ) : null}

        {onTogglePause ? (
          <IconButton
            aria-label={paused ? (playLabel ?? t("media.play")) : (pauseLabel ?? t("media.pause"))}
            onClick={onTogglePause}
            size="xs"
            variant="ghost"
          >
            <Icon name={paused ? "play" : "pause"} />
          </IconButton>
        ) : null}

        {onRestart ? (
          <IconButton aria-label={t("media.restart")} onClick={onRestart} size="xs" variant="ghost">
            <Icon name="restart" />
          </IconButton>
        ) : null}

        {onVolumeChange && volume !== undefined ? (
          <VolumeControl
            label={t("media.volumeFor", { name: label })}
            muteLabel={volume === 0 ? t("media.unmute") : t("media.mute")}
            onChange={onVolumeChange}
            tone={kindTone[kind]}
            value={volume}
          />
        ) : null}

        {onStop ? (
          <IconButton aria-label={t("media.stop")} onClick={onStop} size="xs" variant="ghost">
            <Icon name="close" />
          </IconButton>
        ) : onDelete ? (
          <IconButton aria-label={t("common.remove")} onClick={onDelete} size="xs" variant="ghost">
            <Icon name="close" />
          </IconButton>
        ) : (
          // Reserves the trailing button's footprint even when this row has
          // none (the deck's own music row, a video before it gained its
          // delete button) — every row in a panel stays the same height
          // whether or not it happens to end in a button.
          <span aria-hidden="true" className="size-6 shrink-0" />
        )}
      </div>

      {hasTiming ? (
        // Deliberately not dimmed while paused, unlike the line above: a
        // paused track is exactly when the operator is aiming a seek, so the
        // one control he is about to use stays at full contrast.
        <div className="flex items-center gap-2">
          <span className={cn(clockWidthClass(durationSeconds), "shrink-0 text-xs tabular-nums text-subtle")}>
            {formatClock(scrubSeconds ?? currentSeconds)}
          </span>

          <MediaScrubber
            className="min-w-0 flex-1"
            currentSeconds={currentSeconds}
            durationSeconds={durationSeconds}
            label={t("media.scrubberLabel", { name: label })}
            onPositionChange={setScrubSeconds}
            onSeek={onSeek}
            tone={kindTone[kind]}
            valueTextFormatter={(current, total) => t("media.scrubberValue", { current, total })}
          />

          <span
            className={cn(clockWidthClass(durationSeconds), "shrink-0 text-right text-xs tabular-nums text-subtle")}
          >
            {formatClock(durationSeconds)}
          </span>
        </div>
      ) : null}

      {error ? (
        <p className="truncate pl-6 text-xs text-danger-ink">{error}</p>
      ) : hint ? (
        <p className="truncate pl-6 text-xs text-subtle">{hint}</p>
      ) : null}
    </div>
  );
}
