import { useT } from "@renderer/lib/i18n/i18n-provider";
import { api } from "@renderer/lib/api";
import { cn } from "@renderer/lib/utils";
import { Badge, Box, Button, Caption, FieldGroup, FieldRow, Icon, Select, Title } from "@renderer/components/ui";
import { assignScreenRole, screenRole, type ScreenRole } from "@renderer/lib/actions/screen-roles";
import { ReopenStage } from "@renderer/components/shared/reopen-stage";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useStageStore } from "@renderer/stores/stage.store";
import type { DisplayInfo } from "@shared/types/display";

/** The screens as the computer arranges them, each with its number and the role it has now — the numbers
 *  «Identificar» shows on the walls. Proportions only: positions in percent of the whole arrangement. With
 *  `onPick` (the welcome) pressing one makes it the projector; in Settings the rows below do it. */
export function DisplayMap({ onPick }: { onPick?: (displayId: number) => void }) {
  const t = useT();
  const displays = useDisplayStore((s) => s.displays);
  const projectorId = useDisplayStore((s) => s.displayId);
  const stageId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const mirror = useSettingsStore((s) => s.settings["stage.mirror"]);
  if (displays.length === 0) return null;
  const left = Math.min(...displays.map((d) => d.bounds.x));
  const top = Math.min(...displays.map((d) => d.bounds.y));
  const width = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width)) - left;
  const height = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height)) - top;

  return (
    <Box className="p-4">
      {/* As wide as it can be, never taller than 13rem: two screens stacked made it a page long. */}
      <div
        className="relative mx-auto"
        style={{ aspectRatio: `${width} / ${height}`, width: `min(100%, calc(13rem * ${width} / ${height}))` }}
      >
        {displays.map((d, index) => {
          const role = screenRole(d.id, projectorId, stageId, mirror, d.operator);
          const badge = role !== "none" ? t(`settings.screens.roles.${role}`) : d.operator ? t("welcome.screens.roleControl") : null;
          const body = (
            <Box className={cn("flex size-full flex-col items-center justify-center gap-1 p-1", onPick && "hover:bg-hover")}>
              <Title as="h3">{index + 1}</Title>
              <Caption className="max-w-full truncate px-1">{d.label.split(" · ")[0]}</Caption>
              {badge ? <Badge variant={role === "projector" ? "blue" : "neutral"}>{badge}</Badge> : null}
            </Box>
          );
          const place = {
            height: `calc(${(d.bounds.height / height) * 100}% - 4px)`,
            left: `calc(${((d.bounds.x - left) / width) * 100}% + 2px)`,
            top: `calc(${((d.bounds.y - top) / height) * 100}% + 2px)`,
            width: `calc(${(d.bounds.width / width) * 100}% - 4px)`,
          };
          return onPick ? (
            <button
              aria-label={t("welcome.screens.useAsProjector", { name: d.label })}
              aria-pressed={role === "projector"}
              className="focus-ring absolute rounded-md"
              key={d.id}
              onClick={() => onPick(d.id)}
              style={place}
              title={d.label}
              type="button"
            >
              {body}
            </button>
          ) : (
            <div className="absolute" key={d.id} style={place} title={d.label}>
              {body}
            </div>
          );
        })}
      </div>
    </Box>
  );
}

/** Each screen's number on its own wall, for three seconds: the map's numbers. */
function identifyScreens(displays: readonly DisplayInfo[]): void {
  void api.displays.identify(displays.map((d, index) => ({ id: d.id, number: index + 1, name: d.label })));
}

/** One row per screen: its role, with the roles excluding each other (`assignScreenRole`). */
function RoleRows() {
  const t = useT();
  const displays = useDisplayStore((s) => s.displays);
  const projectorId = useDisplayStore((s) => s.displayId);
  const stageId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const mirror = useSettingsStore((s) => s.settings["stage.mirror"]);
  return (
    <>
      {displays.map((d, index) => {
        const role = screenRole(d.id, projectorId, stageId, mirror, d.operator);
        // The projector always has a screen: its own row offers no «none».
        const options: { label: string; value: ScreenRole }[] = [
          { label: t("settings.screens.roles.projector"), value: "projector" },
          { label: t("settings.screens.roles.stage"), value: "stage" },
          { label: t("settings.screens.roles.mirror"), value: "mirror" },
          ...(role === "projector"
            ? []
            : [{ label: d.operator ? t("settings.screens.roles.control") : t("settings.screens.roles.none"), value: "none" as const }]),
        ];
        return (
          <FieldRow
            description={d.operator ? t("settings.screens.thisComputer") : undefined}
            key={d.id}
            label={`${index + 1} · ${d.label}`}
          >
            <Select
              onChange={(value) => void assignScreenRole(d.id, value as ScreenRole)}
              options={options}
              value={role}
            />
          </FieldRow>
        );
      })}
    </>
  );
}

/** «Ahora»: where the projector and the stage are, in the map's numbers. */
function OutputStatus() {
  const t = useT();
  const displays = useDisplayStore((s) => s.displays);
  const projectorId = useDisplayStore((s) => s.displayId);
  const projectorHidden = useDisplayStore((s) => s.projectorHidden);
  const open = useProjectionStore((s) => s.presentationOpen);
  const stageId = useSettingsStore((s) => s.settings["stage.displayId"]);
  const stageShown = useStageStore((s) => s.shown);
  const stageClosed = useStageStore((s) => s.closed);
  const mirror = useSettingsStore((s) => s.settings["stage.mirror"]);
  const number = (id: number | null) => displays.findIndex((d) => d.id === id) + 1;
  const projector = !open
    ? t("settings.screens.projectorClosed")
    : projectorHidden
      ? t("settings.screens.projectorWaiting")
      : t("settings.screens.projectorOpen", { number: number(projectorId) });
  const stage =
    stageId === null
      ? t("settings.screens.stageNone")
      : stageShown
        ? t(mirror ? "settings.screens.stageMirrored" : "settings.screens.stageShown", { number: number(stageId) })
        : stageClosed
          ? t("settings.screens.stageClosed")
          : t("settings.screens.stageWaiting");
  return (
    <ul aria-label={t("settings.screens.status")} className="flex flex-col gap-1 text-sm text-muted-foreground">
      <li className="flex items-center gap-2">
        <Icon className={open && !projectorHidden ? "text-success-ink" : "text-subtle"} name="display" />
        {projector}
      </li>
      <li className="flex items-center gap-2">
        <Icon className={stageId !== null && stageShown ? "text-success-ink" : "text-subtle"} name="columns" />
        {stage}
        <ReopenStage />
      </li>
    </ul>
  );
}

/** «Tus pantallas» (Settings ▸ Screens, and the welcome's «Pantallas» step): the map, what each screen does,
 *  «Identificar», where the projector and the stage are now, and opening or closing the projector. */
export function ScreenGroup({ description, onPick }: { description?: string | undefined; onPick?: (displayId: number) => void }) {
  const t = useT();
  const displays = useDisplayStore((s) => s.displays);
  const displayId = useDisplayStore((s) => s.displayId);
  const presentationOpen = useProjectionStore((s) => s.presentationOpen);

  return (
    <FieldGroup description={description ?? t("settings.screens.description")} title={t("settings.screens.title")}>
      {displays.length > 1 ? <DisplayMap {...(onPick ? { onPick } : {})} /> : null}
      <RoleRows />
      <FieldRow description={t("settings.screens.identifyDesc")} label={t("settings.screens.identify")}>
        <Button onClick={() => identifyScreens(displays)} variant="outline">
          <Icon name="display" /> {t("settings.screens.identify")}
        </Button>
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
      <FieldRow label={t("settings.screens.status")}>
        <OutputStatus />
      </FieldRow>
    </FieldGroup>
  );
}
