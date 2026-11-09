import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, Caption, DependentFields, FieldGroup, FieldRow, Input, Segmented, Switch } from "@renderer/components/ui";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useCommitOnUnmount } from "@renderer/lib/hooks/use-commit-on-unmount";
import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { SETTINGS_VALIDATORS } from "@shared/types/settings";
import { NDI_NAME_MAX_LENGTH, NDI_TRADEMARK, type NdiOutputStatus } from "@shared/types/ndi";

/** Windows asks, through its own firewall, the first time the engine listens on the network. */
const ON_WINDOWS = navigator.userAgent.includes("Windows");

function useNdiStatus(): NdiOutputStatus | null {
  const [status, setStatus] = useState<NdiOutputStatus | null>(null);
  useEffect(() => {
    const stop = onIpc("ndi-status", setStatus);
    api.ndi
      .getStatus()
      .then((current) => setStatus((pushed) => pushed ?? current))
      .catch((error: unknown) => console.warn("[ndi] status failed", error));
    return stop;
  }, []);
  return status;
}

/**
 * Settings ▸ Projection ▸ «Salida NDI®»: the projector's picture as a source on the network
 * (`main/ndi/ndi-output.ts`). Applied as it changes, like everything in Settings; the name on blur, Enter
 * or leaving Settings. The runtime is the user's own: missing, the status row offers where to get it.
 */
export function NdiOutputGroup() {
  const t = useT();
  const status = useNdiStatus();
  const enabled = useSettingsStore((s) => s.settings["ndi.output.enabled"]);
  const name = useSettingsStore((s) => s.settings["ndi.output.name"]);
  const resolution = useSettingsStore((s) => s.settings["ndi.output.resolution"]);
  const fps = useSettingsStore((s) => s.settings["ndi.output.fps"]);
  const update = useSettingsStore((s) => s.update);
  const [draft, setDraft] = useState(name);

  useEffect(() => setDraft(name), [name]);

  function commitName() {
    const next = draft.trim();
    if (next === name) return;
    // A blank name falls back to the one saved: receivers list the source by it.
    if (SETTINGS_VALIDATORS["ndi.output.name"](next)) void update({ "ndi.output.name": next });
    else setDraft(name);
  }
  useCommitOnUnmount(commitName);

  function describe(current: NdiOutputStatus | null): string {
    switch (current?.state) {
      case undefined:
      case "off":
        return t("settings.ndi.states.off");
      case "starting":
        return t("settings.ndi.states.starting");
      case "sending":
        return t("settings.ndi.states.sending", { count: current.receivers });
      case "runtime-missing":
        return t("settings.ndi.states.runtimeMissing");
      case "error":
        return t(`settings.ndi.errors.${current.code}`);
    }
  }

  return (
    <FieldGroup description={t("settings.ndi.groupDesc")} title={t("settings.groups.ndi")}>
      <FieldRow
        description={ON_WINDOWS ? t("settings.ndi.firewall") : t("settings.ndi.enabledDesc")}
        help={t("settings.ndi.enabledHelp")}
        label={t("settings.ndi.enabled")}
      >
        <Switch
          aria-label={t("settings.ndi.enabled")}
          checked={enabled}
          onChange={(e) => void update({ "ndi.output.enabled": e.target.checked })}
        />
      </FieldRow>
      <FieldRow description={describe(status)} label={t("settings.ndi.status")}>
        {status?.state === "runtime-missing" ? (
          <Button
            onClick={() => void api.ndi.openRuntimePage().catch((error: unknown) => console.warn("[ndi] could not open the page", error))}
            size="sm"
            variant="outline"
          >
            {t("settings.ndi.getRuntime")}
          </Button>
        ) : null}
      </FieldRow>
      <DependentFields enabled={enabled}>
        <FieldRow description={t("settings.ndi.nameDesc")} label={t("settings.ndi.name")}>
          <Input
            aria-label={t("settings.ndi.name")}
            maxLength={NDI_NAME_MAX_LENGTH}
            onBlur={commitName}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
            }}
            size="sm"
            value={draft}
          />
        </FieldRow>
        <FieldRow description={t("settings.ndi.resolutionDesc")} label={t("settings.ndi.resolution")}>
          <Segmented
            label={t("settings.ndi.resolution")}
            onChange={(value) => void update({ "ndi.output.resolution": value })}
            options={[
              { label: "720p", value: "720p" },
              { label: "1080p", value: "1080p" },
            ]}
            value={resolution}
          />
        </FieldRow>
        <FieldRow description={t("settings.ndi.fpsDesc")} label={t("settings.ndi.fps")}>
          <Segmented
            label={t("settings.ndi.fps")}
            onChange={(value) => void update({ "ndi.output.fps": value === "60" ? 60 : 30 })}
            options={[
              { label: "30", value: "30" },
              { label: "60", value: "60" },
            ]}
            value={String(fps) as "30" | "60"}
          />
        </FieldRow>
      </DependentFields>
      {/* The licence's notice, near where NDI is chosen; its link is «Descargar NDI» above. */}
      <Caption className="block px-4 py-3">{NDI_TRADEMARK}</Caption>
    </FieldGroup>
  );
}
