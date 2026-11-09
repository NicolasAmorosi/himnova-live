import type { ReactNode } from "react";
import { Box, Caption, Title } from "@renderer/components/ui";
import { OutputView } from "@renderer/components/shared/output-view";
import type { ProjectionOutput } from "@shared/types/projection";

/** One step of the welcome: its title and one or two lines under it, the controls, and — when the step is
 *  about what the projector shows — that picture on the right, drawn by the projector's own `OutputView`. */
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
    <div className="mx-auto flex w-full max-w-5xl gap-10 px-10 py-10">
      <div className="flex min-w-0 flex-1 flex-col gap-8">
        <header className="flex max-w-2xl flex-col gap-2">
          <Title as="h1">{title}</Title>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </header>
        {children}
      </div>
      {aside ? <aside className="flex w-80 shrink-0 flex-col gap-3 pt-14">{aside}</aside> : null}
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
