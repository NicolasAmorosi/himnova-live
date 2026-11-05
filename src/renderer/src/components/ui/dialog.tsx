import type { HTMLAttributes, Ref } from "react";
import { cn } from "@renderer/lib/utils";

type DialogProps = HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> };

export function Dialog({ className, ref, ...props }: DialogProps) {
  return (
    <div
      className={cn("flex flex-col rounded-xl border border-border bg-card shadow-overlay outline-none", className)}
      ref={ref}
      role="dialog"
      {...props}
    />
  );
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-between px-5 pt-4 pb-3", className)} {...props} />;
}

/** The scrollable middle of a dialog: plain content on the dialog's own
 *  surface, on the same 20 px edge as its title and its buttons. It used to sit
 *  in a bordered `bg-surface` box — the look of a text field, so a confirm's
 *  message read as a pre-filled input (2026-11-05 review). */
export function DialogContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
      <div className={className} {...props} />
    </div>
  );
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-end gap-2 px-5 pt-1 pb-4", className)} {...props} />;
}
