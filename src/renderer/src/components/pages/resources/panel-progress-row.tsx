import { useId } from "react";
import { Button, Caption, LinearLoader, ProgressBar } from "@renderer/components/ui";

type PanelProgressRowProps = {
  /** Omit both to show the row with no cancel action (a plain library import
   *  has nothing to cancel into — see `deck:cancelPrewarmBatch` for the one
   *  that does). */
  cancelLabel?: string;
  label: string;
  onCancel?: () => void;
  /** 0..1, or `null` for indeterminate. */
  value: number | null;
};

/** One row of "something is happening in the background, here's how far
 *  along it is" — shared by the chunked library import (no cancel) and the
 *  "Prepare view/folder" batch (cancelable), both of which live in this
 *  same footer. */
export function PanelProgressRow({ cancelLabel, label, onCancel, value }: PanelProgressRowProps) {
  // The caption names the `progressbar`, it does not label a form control —
  // so it is a span pointed at by `aria-labelledby`, not a `<label>`. Without
  // this the bar announces a bare percentage with nothing to attach it to.
  const labelId = useId();
  return (
    <div className="flex min-w-0 basis-full items-center gap-2 py-1.5">
      <Caption className="shrink-0 whitespace-nowrap" id={labelId}>
        {label}
      </Caption>
      {value === null ? (
        <LinearLoader className="w-full" />
      ) : (
        <ProgressBar aria-labelledby={labelId} className="w-full" value={value} />
      )}
      {onCancel ? (
        <Button className="shrink-0" onClick={onCancel} size="xs" variant="ghost">
          {cancelLabel}
        </Button>
      ) : null}
    </div>
  );
}
