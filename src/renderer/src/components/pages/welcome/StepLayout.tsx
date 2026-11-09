import type { ReactNode } from "react";
import { Box, Caption, Title } from "@renderer/components/ui";
import { OutputView } from "@renderer/components/shared/output-view";
import { cn } from "@renderer/lib/utils";
import type { ProjectionOutput } from "@shared/types/projection";

/** One step of the welcome: its title and one or two lines under it, the controls, and — when the step is
 *  about what the projector shows — that picture beside them on a wide window, under them on a narrow one
 *  (at the app's minimum width, 1000 px, a column beside would squeeze the controls to 320 px). Settings'
 *  reading width when there is no picture. */
export function StepLayout({
  aside,
  children,
  subtitle,
  title,
}: {
  aside?: ReactNode;
  children: ReactNode;
  subtitle: string;
  title: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-10 py-10">
      <header className="flex max-w-2xl flex-col gap-2">
        <Title as="h1">{title}</Title>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </header>
      <div className="flex flex-col gap-8 xl:flex-row xl:gap-10">
        <div className={cn("flex min-w-0 flex-1 flex-col gap-8", !aside && "max-w-3xl")}>{children}</div>
        {/* Beside, it stays in view while a long step scrolls (the Bibles' list). */}
        {aside ? (
          <aside className="flex w-full max-w-sm shrink-0 flex-col gap-3 xl:sticky xl:top-10 xl:w-80 xl:self-start">
            {aside}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** «What the congregation sees»: a bare 16:9 stage under its caption. */
export function StagePreview({ caption, hint, output }: { caption: string; hint?: string; output: ProjectionOutput }) {
  return (
    <>
      <Caption>{caption}</Caption>
      <Box className="aspect-video overflow-hidden">
        <OutputView mode="preview" output={output} />
      </Box>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );
}
