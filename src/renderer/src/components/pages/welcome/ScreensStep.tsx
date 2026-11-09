import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Badge, Box, Callout, Caption, Title } from "@renderer/components/ui";
import { ScreenGroup } from "@renderer/components/shared/settings-groups/screen-group";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { StepLayout } from "./StepLayout";

/** Which screen projects (the rule the rest of the app already follows picks one) and the musicians'. */
export function ScreensStep() {
  const t = useT();
  const displays = useDisplayStore((s) => s.displays);
  return (
    <StepLayout
      // One rectangle says nothing: the map is for telling two or more apart.
      aside={displays.length > 1 ? <DisplayMap /> : undefined}
      subtitle={t("welcome.screens.subtitle")}
      title={t("welcome.screens.title")}
    >
      {displays.length < 2 ? <Callout>{t("welcome.screens.single")}</Callout> : null}
      <ScreenGroup />
    </StepLayout>
  );
}

/** The screens as the computer arranges them, each named by the role it has now — so «Pantalla 2» in the
 *  list above has a place to point at. Proportions only: positions in percent of the whole arrangement.
 *  Pressing one makes it the projector and opens it there: with nothing live it shows LOGO, so the church's
 *  name appears on the wall it should — the step's question answered by looking. */
function DisplayMap() {
  const t = useT();
  const displays = useDisplayStore((s) => s.displays);
  const projectorId = useDisplayStore((s) => s.displayId);
  const stageId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const left = Math.min(...displays.map((d) => d.bounds.x));
  const top = Math.min(...displays.map((d) => d.bounds.y));
  const width = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width)) - left;
  const height = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height)) - top;

  return (
    <>
      <Caption>{t("welcome.screens.map")}</Caption>
      <Box className="p-4">
        <div className="relative w-full" style={{ aspectRatio: `${width} / ${height}` }}>
          {displays.map((d, index) => {
            const projector = d.id === projectorId;
            const role = projector
              ? t("welcome.screens.roleProjector")
              : d.id === stageId
                ? t("welcome.screens.roleStage")
                : d.primary
                  ? t("welcome.screens.roleControl")
                  : null;
            return (
              <button
                aria-label={t("welcome.screens.useAsProjector", { name: d.label })}
                aria-pressed={projector}
                className="focus-ring absolute rounded-md"
                key={d.id}
                onClick={() => void projectOn(d.id)}
                style={{
                  height: `calc(${(d.bounds.height / height) * 100}% - 4px)`,
                  left: `calc(${((d.bounds.x - left) / width) * 100}% + 2px)`,
                  top: `calc(${((d.bounds.y - top) / height) * 100}% + 2px)`,
                  width: `calc(${(d.bounds.width / width) * 100}% - 4px)`,
                }}
                title={d.label}
                type="button"
              >
                <Box className="flex size-full flex-col items-center justify-center gap-1 p-1 hover:bg-hover">
                  <Title as="h3">{index + 1}</Title>
                  <Caption className="max-w-full truncate px-1">{d.label.split(" · ")[0]}</Caption>
                  {role ? <Badge variant={projector ? "blue" : "neutral"}>{role}</Badge> : null}
                </Box>
              </button>
            );
          })}
        </div>
      </Box>
      <p className="text-xs text-muted-foreground">{t("welcome.screens.mapHint")}</p>
    </>
  );
}

async function projectOn(displayId: number): Promise<void> {
  const display = useDisplayStore.getState();
  await display.setDisplayId(displayId);
  if (!useProjectionStore.getState().presentationOpen) await useDisplayStore.getState().open();
}
