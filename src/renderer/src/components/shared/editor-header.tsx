import type { ReactNode } from "react";
import { Callout } from "@renderer/components/ui";

type EditorHeaderProps = {
  /** Why «Save» is off, when the draft cannot be saved at all. */
  invalidHint?: string | undefined;
  preview: ReactNode;
};

/**
 * The top of the «Scenes» and «Overlays» editors: the live preview, centered,
 * with the reason the draft cannot be saved under it. The editor's actions do
 * not live here — they are `EditorActions`, under «New» in the list column,
 * so the preview keeps the whole width to itself.
 */
export function EditorHeader({ invalidHint, preview }: EditorHeaderProps) {
  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-border bg-background px-6 py-3">
      <div className="mx-auto w-full max-w-md">{preview}</div>
      {invalidHint ? (
        <Callout className="mx-auto w-full max-w-md py-2" role="status" tone="warning">
          {invalidHint}
        </Callout>
      ) : null}
    </div>
  );
}
