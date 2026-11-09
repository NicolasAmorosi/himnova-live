import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Box, FieldGroup, FieldRow, Icon, IconTile, Kbd, Switch, Title, type IconName } from "@renderer/components/ui";
import { StepLayout } from "./StepLayout";

const IDEAS: readonly { icon: IconName; id: "select" | "live" | "cover" | "move"; keys: readonly string[] }[] = [
  { icon: "click", id: "select", keys: [] },
  { icon: "play", id: "live", keys: ["Enter"] },
  { icon: "offAir", id: "cover", keys: ["B", "L"] },
  { icon: "keyboard", id: "move", keys: ["←", "→", "C"] },
];

/** The four ideas the whole work screen rests on, and the switch for «Primeros pasos» — the checklist that
 *  then teaches them by doing, over the real app. */
export function TourStep({ firstSteps, onFirstStepsChange }: { firstSteps: boolean; onFirstStepsChange: (on: boolean) => void }) {
  const t = useT();
  return (
    <StepLayout subtitle={t("welcome.tour.subtitle")} title={t("welcome.tour.title")}>
      <ol className="grid grid-cols-2 gap-3">
        {IDEAS.map(({ icon, id, keys }, index) => (
          <li key={id}>
            <Box className="flex h-full gap-3 p-4">
              <IconTile tone="accent">
                <Icon name={icon} />
              </IconTile>
              <span className="flex min-w-0 flex-col gap-1">
                <Title as="h3">
                  {index + 1}. {t(`welcome.tour.${id}.title`)}
                </Title>
                <span className="text-sm text-muted-foreground">{t(`welcome.tour.${id}.body`)}</span>
                {keys.length > 0 ? (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {keys.map((key) => (
                      <Kbd className="ml-0" key={key}>
                        {key}
                      </Kbd>
                    ))}
                  </span>
                ) : null}
              </span>
            </Box>
          </li>
        ))}
      </ol>
      <FieldGroup title={t("welcome.tour.practice")}>
        <FieldRow description={t("welcome.tour.firstStepsDesc")} label={t("welcome.tour.firstSteps")}>
          <Switch
            aria-label={t("welcome.tour.firstSteps")}
            checked={firstSteps}
            onChange={(e) => onFirstStepsChange(e.target.checked)}
          />
        </FieldRow>
      </FieldGroup>
    </StepLayout>
  );
}
