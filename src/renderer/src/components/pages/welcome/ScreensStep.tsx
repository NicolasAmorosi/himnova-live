import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Callout } from "@renderer/components/ui";
import { ScreenGroup } from "@renderer/components/shared/settings-groups/screen-group";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { StepLayout } from "./StepLayout";

/** Which screen projects (the rule the rest of the app already follows picks one) and the stage's: the map and
 *  the roles Settings ▸ Screens has, where pressing a screen on the map also projects there. */
export function ScreensStep() {
  const t = useT();
  const displays = useDisplayStore((s) => s.displays);
  return (
    <StepLayout subtitle={t("welcome.screens.subtitle")} title={t("welcome.screens.title")}>
      {displays.length < 2 ? <Callout>{t("welcome.screens.single")}</Callout> : null}
      <ScreenGroup description={displays.length > 1 ? t("welcome.screens.mapHint") : undefined} onPick={(id) => void projectOn(id)} />
    </StepLayout>
  );
}

/** Pressing a screen makes it the projector and opens it there: with nothing live it shows LOGO, so the church's
 *  name appears on the wall it should — the step's question answered by looking. */
async function projectOn(displayId: number): Promise<void> {
  const display = useDisplayStore.getState();
  await display.setDisplayId(displayId);
  if (useProjectionStore.getState().presentationOpen) return;
  await useDisplayStore.getState().open();
  // LOGO, not the BLACK `open()` leaves: the step is for telling the walls apart by looking, and a
  // black wall reads as a projector that is off. Main ignores this push if the window never opened.
  if (useProjectionStore.getState().presentationOpen) useProjectionStore.getState().setOverlay("logo");
}
