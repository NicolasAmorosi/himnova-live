import type { InputHTMLAttributes } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { cn } from "@renderer/lib/utils";

type SliderProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "type" | "value"> & {
  /** How the current value reads beside the track, when the number plus
   *  `unit` is not enough (a multiplier, «No limit», a percentage of 0–1). */
  format?: (value: number) => string;
  /** Accessible name. The visible label lives in the `FieldRow` this sits in,
   *  which is not associated with the input — so without this the control is
   *  announced as an unnamed slider. */
  label: string;
  onChange: (value: number) => void;
  /** After the number. Every `cqw` reads `%` — a `cqw` IS a percent of the
   *  stage's width, and nobody knows the CSS unit (owner, 2026-11-05). */
  unit?: string;
  value: number;
};


/** As many decimals as the step has: «6.0» beside «2.5», never «6» beside
 *  «2.5» or «0.00» beside «55%» (2026-11-05 review). */
function decimalsOf(step: SliderProps["step"]): number {
  const text = String(step ?? 1);
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}

/**
 * A range with its value read out beside it.
 *
 * The readout is the whole reason this is a primitive rather than a bare
 * `<input type="range">`: a slider with no number is unusable for anything the
 * operator has to reproduce — a text size, a line height, a block width — and
 * the same track-plus-number pair had already been written twice by hand
 * before this existed, which is the point `CLAUDE.md` promotes on.
 *
 * `tabular-nums` and ONE fixed-width readout for every slider: the track does
 * not shift sideways as the number gains a digit while it is being dragged,
 * and the tracks of an inspector all end at the same x (2026-11-05 review:
 * a width per call site made a ragged right edge). 48 px fits «10.25»,
 * «100%» and «120 s».
 */
export function Slider({ className, format, label, onChange, unit = "", value, ...rest }: SliderProps) {
  const { locale } = useI18n();
  const decimals = decimalsOf(rest.step);
  return (
    <>
      <input
        aria-label={label}
        className={cn("peer w-40 accent-accent disabled:opacity-50", className)}
        onChange={(e) => onChange(Number(e.target.value))}
        type="range"
        value={value}
        {...rest}
      />
      {/* Dimmed with the track — by `:disabled`, so a disabled `<fieldset>`
          around it counts too: a bright number beside a faded track reads as
          a setting that still applies. */}
      <span
        className="shrink-0 text-right text-xs tabular-nums text-muted-foreground peer-disabled:opacity-50"
        // Inline, not `w-12`: an inspector row stretches every child with a
        // class that outranks one here, and the readout took the whole row.
        style={{ width: "3rem" }}
      >
        {format
          ? format(value)
          : // The language's own decimal mark, like every other number in the app («1,38»).
            new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value) +
            unit}
      </span>
    </>
  );
}
