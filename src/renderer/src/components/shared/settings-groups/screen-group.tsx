import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Select } from "@renderer/components/ui";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";

/** «Pantalla»: which screen the projector uses, opening it, and the musicians' screen. Settings ▸
 *  Projection's first group, and the welcome's «Pantallas» step. */
export function ScreenGroup({ description }: { description?: string }) {
  const t = useT();
  const { displayId, displays, setDisplayId } = useDisplayStore();
  const presentationOpen = useProjectionStore((s) => s.presentationOpen);
  const stageDisplayId = useSettingsStore((s) => s.settings["stage.displayId"]);

  // Never the projector's screen: fullscreen and on top, the stage would cover
  // it — except the operator's own, where both are movable windows. A saved
  // choice off this list (the projector's now, or unplugged) reads «Ninguna»,
  // which is what is on (`chooseStageDisplay` in main); the setting stays, so
  // the stage comes back once the projector moves or the screen returns.
  const stageDisplays = displays.filter((d) => d.operator || d.id !== displayId);
  const stageValue = stageDisplays.some((d) => d.id === stageDisplayId) ? String(stageDisplayId) : "none";

  return (
    <FieldGroup description={description} title={t("settings.groups.screen")}>
      <FieldRow description={t("settings.displayDesc")} label={t("settings.display")}>
        <Select
          onChange={(value) => void setDisplayId(Number(value))}
          options={displays.map((d) => ({
            label: `${d.label}${d.operator ? ` ${t("header.controlDisplay")}` : ""}`,
            value: String(d.id),
          }))}
          value={displayId !== null ? String(displayId) : ""}
        />
      </FieldRow>
      <FieldRow description={t("settings.windowDesc")} label={t("settings.windowLabel")}>
        {presentationOpen ? (
          <Button onClick={() => void useDisplayStore.getState().close()} variant="outline">
            {t("header.closeDisplay")}
          </Button>
        ) : (
          // The same look as «Close» in the same place: Settings applies at
          // once and has no primary action (2026-11-04 review).
          <Button disabled={displayId === null} onClick={() => void useDisplayStore.getState().open()} variant="outline">
            {t("header.openDisplay")}
          </Button>
        )}
      </FieldRow>
      {/* Open whenever its screen is connected and is not the projector's; main places it (`stage-window.ts`). */}
      <FieldRow
        description={t("settings.stageDisplayDesc")}
        help={t("settings.stageDisplayHelp")}
        label={t("settings.stageDisplay")}
      >
        <Select
          onChange={(value) =>
            void useSettingsStore.getState().update({ "stage.displayId": value === "none" ? null : Number(value) })
          }
          options={[
            { label: t("settings.stageNone"), value: "none" },
            ...stageDisplays.map((d) => ({
              label: `${d.label}${d.operator ? ` ${t("header.controlDisplay")}` : ""}`,
              value: String(d.id),
            })),
          ]}
          value={stageValue}
        />
      </FieldRow>
    </FieldGroup>
  );
}
