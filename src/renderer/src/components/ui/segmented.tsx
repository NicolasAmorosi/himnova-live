import { cn } from "@renderer/lib/utils";
import { Icon, type IconName } from "./icon";

type SegmentedOption<T extends string> = { icon?: IconName; label: string; value: T };

type SegmentedProps<T extends string> = {
  className?: string;
  /** The group's accessible name. */
  label: string;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** 28 px in a compact bar, 32 by default — the control heights. */
  size?: "xs" | "sm";
  value: T;
};

/** The whole control's height — 28 or 32, the control scale — the buttons fill it. */
const heights: Record<NonNullable<SegmentedProps<string>["size"]>, string> = { xs: "h-7", sm: "h-8" };

/**
 * Two or three mutually exclusive choices side by side, the chosen one filled:
 * the search mode of the Bible tab, the app's theme. One shape for what used to
 * be a hand-made box of buttons in each place (2026-11-05 review: four
 * segmented controls, four looks). Pressed buttons in a `group`, not a tab
 * list — choosing a mode switches no panel.
 */
export function Segmented<T extends string>({ className, label, onChange, options, size = "sm", value }: SegmentedProps<T>) {
  return (
    <div
      aria-label={label}
      className={cn("inline-flex shrink-0 items-stretch gap-0.5 rounded-md border border-border p-0.5", heights[size], className)}
      role="group"
    >
      {options.map((option) => {
        const chosen = option.value === value;
        return (
          <button
            aria-pressed={chosen}
            className={cn(
              "focus-ring inline-flex min-w-0 grow items-center justify-center gap-1.5 rounded-sm px-2.5 text-xs font-medium transition-colors",
              // The chosen look of `Tabs`' segments, so the app has one.
              chosen ? "bg-active text-foreground ring-1 ring-accent/40 ring-inset" : "text-muted-foreground hover:bg-hover hover:text-foreground",
            )}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.icon ? <Icon className="size-3.5" name={option.icon} /> : null}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
