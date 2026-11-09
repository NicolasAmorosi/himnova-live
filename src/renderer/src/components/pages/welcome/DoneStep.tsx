import type { ReactNode } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow } from "@renderer/components/ui";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { logoModeOf } from "@shared/types/settings";
import { StepLayout } from "./StepLayout";
import type { WelcomeStepId } from "./welcome-steps";

/** What was chosen, each line with «Change» back to its step. */
export function DoneStep({ go }: { go: (step: WelcomeStepId) => void }) {
  const t = useT();
  const s = useSettingsStore((state) => state.settings);
  const displays = useDisplayStore((state) => state.displays);
  const displayId = useDisplayStore((state) => state.displayId);
  const versions = useBibleStore((state) => state.versions);
  const projector = displays.find((d) => d.id === displayId);
  const logoMode = logoModeOf(s["logo.mode"], s["logo.path"]);
  const folders = Object.values(s["library.linkedFolders"]).flat().length + s["songs.linkedFolders"].length;

  const rows: readonly { step: WelcomeStepId; label: string; value: ReactNode }[] = [
    {
      step: "hello",
      label: t("welcome.done.summary.language"),
      value: `${t(`settings.locales.${s["ui.locale"]}`)} · ${t(`welcome.hello.themes.${s["ui.theme"]}`)}`,
    },
    {
      step: "church",
      label: t("welcome.done.summary.church"),
      value:
        logoMode === "image"
          ? s["logo.path"] ? t("welcome.done.logoImage") : t("welcome.done.logoNone")
          : s["logo.name"] ? t("welcome.done.logoName", { name: s["logo.name"] }) : t("welcome.done.logoNone"),
    },
    {
      step: "screens",
      label: t("welcome.done.summary.screens"),
      value: projector && !projector.primary ? projector.label : t("welcome.done.noProjector"),
    },
    {
      step: "endings",
      label: t("welcome.done.summary.endings"),
      value: t("welcome.done.endingsSummary", {
        video: t(`welcome.endings.short.${s["projection.videoEnd"]}`),
        deck: t(`welcome.endings.short.${s["projection.deckEnd"]}`),
        song: t(`welcome.endings.short.${s["projection.songEnd"]}`),
        audio: t(`welcome.endings.short.${s["projection.audioEnd"]}`),
      }),
    },
    { step: "folders", label: t("welcome.done.summary.folders"), value: t("welcome.done.foldersCount", { count: folders }) },
    {
      step: "bibles",
      label: t("welcome.done.summary.bibles"),
      value: versions.map((version) => version.name).join(" · ") || t("welcome.done.noBibles"),
    },
    {
      step: "stream",
      label: t("welcome.done.summary.stream"),
      value: s["ndi.output.enabled"] ? t("welcome.done.ndiOn") : t("welcome.done.ndiOff"),
    },
  ];

  return (
    <StepLayout subtitle={t("welcome.done.subtitle")} title={t("welcome.done.title")}>
      <FieldGroup title={t("welcome.done.group")}>
        {rows.map(({ label, step, value }) => (
          <FieldRow description={value} key={step} label={label}>
            <Button onClick={() => go(step)} size="sm" variant="ghost">
              {t("welcome.done.change")}
            </Button>
          </FieldRow>
        ))}
      </FieldGroup>
    </StepLayout>
  );
}
