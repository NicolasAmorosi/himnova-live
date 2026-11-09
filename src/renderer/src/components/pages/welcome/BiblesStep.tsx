import { useT } from "@renderer/lib/i18n/i18n-provider";
import { StepLayout } from "./StepLayout";

// ponytail: placeholder until the bundled-Bible catalog (`bible:bundled`) lands from its branch.
export function BiblesStep() {
  const t = useT();
  return (
    <StepLayout subtitle={t("welcome.bibles.subtitle")} title={t("welcome.bibles.title")}>
      {null}
    </StepLayout>
  );
}
