import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Box, ChoiceGroup, Icon, IconTile, Title } from "@renderer/components/ui";
import { NdiOutputGroup } from "@renderer/components/shared/settings-groups/ndi-output-group";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { StepLayout } from "./StepLayout";

type Streams = "yes" | "no";

/** NDI® for whoever streams: one question first, and only a «yes» shows Settings' own group (with its live
 *  status and the runtime's download when it is missing). */
export function StreamStep() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings["ndi.output.enabled"]);
  const name = useSettingsStore((s) => s.settings["ndi.output.name"]);
  const update = useSettingsStore((s) => s.update);
  // An install that never chose starts on «no», which is what it does: the output is off.
  const [answer, setAnswer] = useState<Streams>(enabled ? "yes" : "no");

  /** «Yes» turns the output on at once — the status below then says whether the runtime is there — and
   *  «no» turns it off: the answer IS the switch, which stays below for whoever changes their mind. */
  function choose(value: Streams) {
    setAnswer(value);
    if ((value === "yes") !== enabled) void update({ "ndi.output.enabled": value === "yes" });
  }

  return (
    <StepLayout
      aside={
        answer === "yes" ? (
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
        className="max-w-md"
        columns={2}
        label={t("welcome.stream.question")}
        onChange={choose}
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
        value={answer}
      />
      {answer === "yes" ? <NdiOutputGroup /> : null}
    </StepLayout>
  );
}
