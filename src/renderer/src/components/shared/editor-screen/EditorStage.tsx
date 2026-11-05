import type { ReactNode } from "react";
import { Callout } from "@renderer/components/ui";

/**
 * The canvas of a look editor (themes, timer scenes, plates, the verse): the
 * preview as large as the screen allows, centred, with its sample controls
 * («See how it ends», «Try the way in») under it and the reason «Save» is off,
 * if it is.
 *
 * Capped by HEIGHT as well as width: the stage is 16:9 by its width, so on a
 * wide, short window a width-only stage would push its own controls off the
 * bottom. 13rem is the bar, the padding and one row of controls.
 */
export function EditorStage({ below, children, warning }: { below?: ReactNode; children: ReactNode; warning?: string | undefined }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8">
      <div className="w-full max-w-[min(64rem,calc((100dvh-13rem)*16/9))]">
        <div className="overflow-hidden rounded-md border border-border bg-black">
          <div className="flex aspect-video w-full items-center justify-center">{children}</div>
        </div>
      </div>
      {below ? (
        <div className="flex flex-wrap items-center justify-center gap-3 text-dense text-muted-foreground">{below}</div>
      ) : null}
      {warning ? (
        <Callout className="w-full max-w-md py-2" role="status" tone="warning">
          {warning}
        </Callout>
      ) : null}
    </div>
  );
}
