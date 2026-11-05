import type { HTMLAttributes } from "react";
import { cn } from "@renderer/lib/utils";
import { Icon } from "./icon";
import { IconButton } from "./icon-button";

type Tone = "info" | "warning" | "danger";
type CalloutProps = HTMLAttributes<HTMLDivElement> & {
  tone?: Tone;
} & (
    | {
        /** Renders an X on the right that calls this. Omit for the persistent,
         *  accountable states (e.g. deck-conversion failures) that shouldn't be
         *  dismissible — only a transient notice should get one. */
        onDismiss: () => void;
        /** The X's name — always a translated label, never a hardcoded
         *  default, per this app's i18n rule. */
        dismissLabel: string;
      }
    | { onDismiss?: undefined; dismissLabel?: undefined }
  );

const toneClassName: Record<Tone, string> = {
  info: "border-border-light bg-muted text-foreground",
  warning: "border-warning/40 bg-warning/10 text-foreground",
  danger: "border-danger/40 bg-danger/10 text-foreground",
};
const toneIcon: Record<Tone, "alert"> = { info: "alert", warning: "alert", danger: "alert" };
const toneIconClassName: Record<Tone, string> = {
  info: "text-accent-ink",
  warning: "text-warning-ink",
  danger: "text-danger-ink",
};

export function Callout({ children, className, tone = "info", ...rest }: CalloutProps) {
  // Kept out of the `<div>`'s attributes; read through `rest` below, where they narrow together.
  const { dismissLabel: _dismissLabel, onDismiss: _onDismiss, ...props } = rest;
  return (
    <div
      className={cn("flex items-start gap-2 rounded-md border p-3 text-sm", toneClassName[tone], className)}
      {...props}
    >
      <Icon className={cn("mt-0.5", toneIconClassName[tone])} name={toneIcon[tone]} />
      <div className="min-w-0 flex-1 select-text">{children}</div>
      {rest.onDismiss ? (
        <IconButton aria-label={rest.dismissLabel} onClick={rest.onDismiss} size="xs" variant="ghost">
          <Icon name="close" />
        </IconButton>
      ) : null}
    </div>
  );
}
