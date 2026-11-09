import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Card, Icon, IconButton, ProgressBar, Title } from "@renderer/components/ui";
import { cn } from "@renderer/lib/utils";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { FIRST_STEP_IDS } from "@shared/types/settings";

/**
 * «Primeros pasos»: a small checklist in the work screen's corner whose items tick themselves as the
 * operator does each thing (`effects/first-steps.ts`) — the welcome's tour, learnt by doing it instead of
 * by reading it. It folds to its title, and ✕ puts it away (back from Settings ▸ About). Inside `#root`, so
 * a modal makes it inert like the rest of the work screen.
 */
export function FirstStepsPanel() {
  const t = useT();
  const open = useSettingsStore((s) => s.settings["welcome.firstStepsOpen"]);
  const done = useSettingsStore((s) => s.settings["welcome.firstStepsDone"]);
  const update = useSettingsStore((s) => s.update);
  // Folded, it shows the one step to do next: in its corner it sits over the LIVE column's slides.
  const [folded, setFolded] = useState(true);
  if (!open) return null;

  const count = FIRST_STEP_IDS.filter((id) => done.includes(id)).length;
  const finished = count === FIRST_STEP_IDS.length;
  const next = FIRST_STEP_IDS.find((id) => !done.includes(id));

  return (
    <Card
      aria-label={t("firstSteps.title")}
      className="fixed right-4 bottom-14 z-[var(--z-sticky)] flex w-80 flex-col"
      role="complementary"
    >
      <div className="flex items-center gap-2 py-2 pr-1.5 pl-4">
        <Icon className={finished ? "text-success-ink" : "text-muted-foreground"} name={finished ? "circleCheck" : "click"} />
        <Title as="h3">{t("firstSteps.title")}</Title>
        <span aria-live="polite" className="flex-1 text-xs text-muted-foreground">
          {t("firstSteps.progress", { done: count, total: FIRST_STEP_IDS.length })}
        </span>
        <IconButton
          aria-expanded={!folded}
          aria-label={folded ? t("firstSteps.expand") : t("firstSteps.collapse")}
          onClick={() => setFolded(!folded)}
          size="xs"
          title={folded ? t("firstSteps.expand") : t("firstSteps.collapse")}
          variant="ghost"
        >
          <Icon name={folded ? "chevronUp" : "chevronDown"} />
        </IconButton>
        <IconButton
          aria-label={t("firstSteps.close")}
          onClick={() => void update({ "welcome.firstStepsOpen": false })}
          size="xs"
          title={t("firstSteps.close")}
          variant="ghost"
        >
          <Icon name="close" />
        </IconButton>
      </div>
      <ProgressBar aria-label={t("firstSteps.title")} className="mx-4 mb-2 w-auto" value={count / FIRST_STEP_IDS.length} />
      {finished ? (
        <div className="flex flex-col gap-1 px-4 pt-1 pb-4">
          <Title as="h3">{t("firstSteps.doneTitle")}</Title>
          <p className="text-xs text-muted-foreground">{t("firstSteps.doneBody")}</p>
        </div>
      ) : (
        <ol className="flex flex-col gap-0.5 px-2 pb-2">
          {FIRST_STEP_IDS.filter((id) => !folded || id === next).map((id) => {
            const isDone = done.includes(id);
            const isNext = id === next;
            return (
              <li className={cn("flex items-start gap-2.5 rounded-md px-2 py-1.5", isNext && "bg-active")} key={id}>
                <Icon
                  className={cn("mt-0.5", isDone ? "text-success-ink" : isNext ? "text-accent-ink" : "text-subtle")}
                  name={isDone ? "circleCheck" : "circle"}
                />
                <span className="flex min-w-0 flex-col">
                  <span className={cn("text-sm", isDone ? "text-muted-foreground line-through" : "text-foreground")}>
                    {t(`firstSteps.items.${id}.title`)}
                  </span>
                  {isNext ? <span className="text-xs text-muted-foreground">{t(`firstSteps.items.${id}.hint`)}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
