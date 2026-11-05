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

/** The scrollable middle of a dialog. Mirrors the `FieldGroup` pattern:
 *  content sits inside a `bg-surface` box, visually distinct from the
 *  dialog's own `bg-card` chrome, instead of being separated by a border. */
export function DialogContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <div className={cn("rounded-md border border-border bg-surface p-4", className)} {...props} />
    </div>
  );
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-end gap-2 px-4 pt-1 pb-4", className)} {...props} />;
}
