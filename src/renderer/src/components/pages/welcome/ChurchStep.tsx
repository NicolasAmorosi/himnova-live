import { useT } from "@renderer/lib/i18n/i18n-provider";
import { LogoGroup } from "@renderer/components/shared/settings-groups/logo-group";
import { useLogoPreview } from "@renderer/components/shared/settings-groups/use-logo-preview";
import { StagePreview, StepLayout } from "./StepLayout";

/** LOGO — what the room sees when nothing else is up: Settings' own group, its preview drawn big. */
export function ChurchStep() {
  const t = useT();
  const output = useLogoPreview();
  return (
    <StepLayout
      aside={<StagePreview caption={t("welcome.congregationSees")} hint={t("welcome.church.hint")} output={output} />}
      subtitle={t("welcome.church.subtitle")}
      title={t("welcome.church.title")}
    >
      <LogoGroup preview={false} />
    </StepLayout>
  );
}
