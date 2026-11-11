import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, Caption, DependentFields, FieldGroup, FieldRow, Input, Segmented, Slider, Switch } from "@renderer/components/ui";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useCommitOnUnmount } from "@renderer/lib/hooks/use-commit-on-unmount";
import { api } from "@renderer/lib/api";
import { onIpc } from "@renderer/lib/ipc";
import { SETTINGS_VALIDATORS } from "@shared/types/settings";
import {
  NDI_AUDIO_DELAY_MAX_MS,
  NDI_AUDIO_DELAY_MIN_MS,
  NDI_NAME_MAX_LENGTH,
  NDI_TRADEMARK,
  type NdiAudioStatus,
  type NdiOutputStatus,
} from "@shared/types/ndi";

/** The first time the output reaches the network, Windows asks through its firewall and macOS through its
 *  Local Network privacy (for «Lumina Live»); until it is allowed, receivers see the source and no picture. */
const ON_WINDOWS = navigator.userAgent.includes("Windows");
const ON_MAC = navigator.userAgent.includes("Mac");

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
 *
 * `essentials` (the welcome, where a question already turned it on): the status and the name only — no
 * switch, which would be a second control for the same answer, and the defaults for size and frame rate.
 */
export function NdiOutputGroup({ essentials = false }: { essentials?: boolean }) {
  const t = useT();
  const status = useNdiStatus();
  const enabled = useSettingsStore((s) => s.settings["ndi.output.enabled"]);
  const name = useSettingsStore((s) => s.settings["ndi.output.name"]);
  const resolution = useSettingsStore((s) => s.settings["ndi.output.resolution"]);
  const fps = useSettingsStore((s) => s.settings["ndi.output.fps"]);
  const audio = useSettingsStore((s) => s.settings["ndi.output.audio"]);
  const audioDelay = useSettingsStore((s) => s.settings["ndi.output.audioDelayMs"]);
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

  /** The level says the sound is really there: a refused permission on macOS sends silence, no error. */
  function describeAudio(current: NdiAudioStatus): string {
    if (current.state === "unavailable") return t("settings.ndi.audioStates.unavailable", { detail: current.detail });
    if (current.levelDb === null) return t("settings.ndi.audioStates.on");
    if (current.levelDb < -90) return t("settings.ndi.audioStates.silent");
    return t("settings.ndi.audioStates.level", { level: String(Math.round(current.levelDb)) });
  }

  function describe(current: NdiOutputStatus | null): string {
    switch (current?.state) {
      case undefined:
      case "off":
        return t("settings.ndi.states.off");
      case "starting":
        return t("settings.ndi.states.starting");
      case "sending": {
        const sending = t("settings.ndi.states.sending", { count: current.receivers });
        return audio && current.audio ? `${sending}. ${describeAudio(current.audio)}` : sending;
      }
      case "runtime-missing":
        return t("settings.ndi.states.runtimeMissing");
      case "error":
        return t(`settings.ndi.errors.${current.code}`);
    }
  }

  return (
    <FieldGroup description={t("settings.ndi.groupDesc")} title={t("settings.groups.ndi")}>
      {essentials ? null : (
        <FieldRow
          description={
            ON_WINDOWS ? t("settings.ndi.firewall") : ON_MAC ? t("settings.ndi.localNetwork") : t("settings.ndi.enabledDesc")
          }
          help={t("settings.ndi.enabledHelp")}
          label={t("settings.ndi.enabled")}
        >
          <Switch
            aria-label={t("settings.ndi.enabled")}
            checked={enabled}
            onChange={(e) => void update({ "ndi.output.enabled": e.target.checked })}
          />
        </FieldRow>
      )}
      {/* The OS's own permission prompt, said where the welcome has no switch row to say it. */}
      <FieldRow
        description={
          essentials && (ON_WINDOWS || ON_MAC)
            ? `${describe(status)} ${ON_WINDOWS ? t("settings.ndi.firewall") : t("settings.ndi.localNetwork")}`
            : describe(status)
        }
        label={t("settings.ndi.status")}
      >
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
        {essentials ? null : (
          <>
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
            <FieldRow
              description={
                ON_WINDOWS ? t("settings.ndi.audioDescWin") : ON_MAC ? t("settings.ndi.audioDescMac") : t("settings.ndi.audioDescLinux")
              }
              label={t("settings.ndi.audio")}
            >
              <Switch
                aria-label={t("settings.ndi.audio")}
                checked={audio}
                onChange={(e) => void update({ "ndi.output.audio": e.target.checked })}
              />
            </FieldRow>
            <DependentFields enabled={audio}>
              <FieldRow description={t("settings.ndi.audioDelayDesc")} label={t("settings.ndi.audioDelay")}>
                <Slider
                  label={t("settings.ndi.audioDelay")}
                  max={NDI_AUDIO_DELAY_MAX_MS}
                  min={NDI_AUDIO_DELAY_MIN_MS}
                  onChange={(value) => void update({ "ndi.output.audioDelayMs": Math.round(value) })}
                  step={10}
                  unit=" ms"
                  value={audioDelay}
                />
              </FieldRow>
            </DependentFields>
          </>
        )}
      </DependentFields>
      {/* The licence's notice, near where NDI is chosen; its link is «Descargar NDI» above. */}
      <Caption className="block px-4 py-3">{NDI_TRADEMARK}</Caption>
    </FieldGroup>
  );
}
