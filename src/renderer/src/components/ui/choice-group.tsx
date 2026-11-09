import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { Icon } from "./icon";

export type ChoiceOption<T extends string> = {
  /** A picture above the label — a `StageSketch`, an icon on a tile. */
  visual?: ReactNode;
  label: string;
  /** One short line under the label. */
  description?: string;
  /** The whole sentence a short label stands for, read by a screen reader in its place («Logo» →
   *  «Mostrar el logo»): the picture says it to the eye. */
  hint?: string;
  value: T;
};

type ChoiceGroupProps<T extends string> = {
  className?: string;
  /** How many cards per row; they share the row's width. */
  columns: number;
  /** The group's accessible name. */
  label: string;
  onChange: (value: T) => void;
  options: readonly ChoiceOption<T>[];
  value: T;
};

/**
 * One of a few choices shown as cards — a picture and a word each — for a choice that reads better seen
 * than listed: the welcome's «Al terminar», its theme and language. `Segmented`'s job with room for a
 * picture, and the same chosen look (teal edge and fill). A radio group: Tab reaches the chosen card,
 * the arrows move the choice like a native radio's, Home/End jump to the ends.
 */
export function ChoiceGroup<T extends string>({ className, columns, label, onChange, options, value }: ChoiceGroupProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  function move(e: KeyboardEvent<HTMLDivElement>) {
    const last = options.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? current === last ? 0 : current + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? current === 0 ? last : current - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    const option = next === null ? undefined : options[next];
    if (!option || next === null) return;
    e.preventDefault();
    onChange(option.value);
    refs.current[next]?.focus();
  }

  return (
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- the tab stop is the chosen radio, not the group (the radio-group pattern); the group only hands the arrows to it
    <div
      aria-label={label}
      className={cn("grid gap-2", className)}
      onKeyDown={move}
      role="radiogroup"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map((option, index) => {
        const chosen = index === current;
        return (
          <button
            aria-checked={chosen}
            aria-label={option.hint ? `${option.label}. ${option.hint}` : undefined}
            className={cn(
              "focus-ring relative flex min-w-0 flex-col gap-1.5 rounded-md border p-1.5 text-left transition-colors",
              chosen
                ? "border-accent bg-active ring-1 ring-accent/40 ring-inset"
                : "border-border bg-surface hover:border-border-light hover:bg-hover",
            )}
            key={option.value}
            onClick={() => onChange(option.value)}
            ref={(element) => {
              refs.current[index] = element;
            }}
            role="radio"
            tabIndex={chosen ? 0 : -1}
            type="button"
          >
            {/* A picture of the choice, not part of its name: a stage sketch would otherwise read out the
                church's name before «Logo». */}
            {option.visual ? (
              <span aria-hidden="true" className="flex flex-col">
                {option.visual}
              </span>
            ) : null}
            <span className="flex min-w-0 items-start gap-1 px-0.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs font-medium text-foreground">{option.label}</span>
                {option.description ? (
                  <span className="line-clamp-2 text-xs text-muted-foreground">{option.description}</span>
                ) : null}
              </span>
              {/* Its room kept when not chosen, so choosing a card does not rewrap its words. */}
              <Icon className={cn("size-3.5 text-accent-ink", !chosen && "invisible")} name="circleCheck" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
