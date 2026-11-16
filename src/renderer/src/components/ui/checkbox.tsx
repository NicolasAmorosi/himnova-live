import { useContext, type InputHTMLAttributes } from "react";
import { cn } from "@renderer/lib/utils";
import { FieldLabelContext } from "./field-layout";

/** Named by the `FieldRow` it sits in unless the caller names it: four of Settings' switches had no name at all
 *  (2026-11-15 audit, U10). */
export function Switch({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const fieldLabelId = useContext(FieldLabelContext);
  const named = props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined;
  return (
    <input
      aria-labelledby={named ? undefined : fieldLabelId}
      className={cn(
        "relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-md bg-muted ring-1 ring-border-light ring-inset transition-colors checked:ring-transparent before:absolute before:top-0.5 before:left-0.5 before:size-4 before:rounded-sm before:bg-white before:shadow-surface [&:not(:checked)]:before:bg-subtle before:transition-transform checked:bg-accent checked:before:translate-x-4 focus-ring disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      role="switch"
      type="checkbox"
      {...props}
    />
  );
}
