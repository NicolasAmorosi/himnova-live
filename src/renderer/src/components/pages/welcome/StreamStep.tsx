import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Box, ChoiceGroup, Icon, IconTile, Title } from "@renderer/components/ui";
import { NdiOutputGroup } from "@renderer/components/shared/settings-groups/ndi-output-group";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { StepLayout } from "./StepLayout";

type Streams = "yes" | "no";

/** NDI® for whoever streams: one question, and the answer IS the output's switch — «yes» turns it on at
 *  once and shows the essentials of Settings' own group (its live status, the runtime's download when it
 *  is missing, the name receivers list); «no» turns it off. */
export function StreamStep() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings["ndi.output.enabled"]);
  const name = useSettingsStore((s) => s.settings["ndi.output.name"]);
  const update = useSettingsStore((s) => s.update);

  return (
    <StepLayout
      aside={
        enabled ? (
          <Box className="flex flex-col gap-3 p-4">
            <Title as="h3">{t("welcome.stream.howTitle")}</Title>
            <ol className="flex flex-col gap-3 text-sm text-muted-foreground">
              {(["how1", "how2", "how3"] as const).map((key, index) => (
                <li className="flex items-start gap-2.5" key={key}>
                  <IconTile size="step">{index + 1}</IconTile>
                  <span>{t(`welcome.stream.${key}`, { name })}</span>
                </li>
              ))}
            </ol>
          </Box>
        ) : undefined
      }
      subtitle={t("welcome.stream.subtitle")}
      title={t("welcome.stream.title")}
    >
      <ChoiceGroup<Streams>
        columns={2}
        label={t("welcome.stream.question")}
        onChange={(value) => void update({ "ndi.output.enabled": value === "yes" })}
        options={(["yes", "no"] as const).map((value) => ({
          description: t(`welcome.stream.${value}Desc`),
          label: t(`welcome.stream.${value}`),
          value,
          visual: (
            <IconTile size="picture">
              <Icon name={value === "yes" ? "broadcast" : "offAir"} />
            </IconTile>
          ),
        }))}
        value={enabled ? "yes" : "no"}
      />
      {enabled ? <NdiOutputGroup essentials /> : null}
    </StepLayout>
  );
}
