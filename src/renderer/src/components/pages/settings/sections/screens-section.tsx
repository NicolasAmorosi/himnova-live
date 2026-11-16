import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Segmented, Select, Switch, Textarea } from "@renderer/components/ui";
import { ScreenGroup } from "@renderer/components/shared/settings-groups/screen-group";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useCommitOnUnmount } from "@renderer/lib/hooks/use-commit-on-unmount";
import {
  STAGE_ALERT_OPTIONS_MS,
  STAGE_CLOCK_FORMATS,
  STAGE_MESSAGE_MAX_LENGTH,
  STAGE_PHRASES_MAX,
  STAGE_TEXT_SIZES,
  STAGE_WARN_OPTIONS_MS,
  type StageClockFormat,
  type StageTextSize,
} from "@shared/types/stage";

/** The phrases as typed: one per line, blank lines, repeats and the excess dropped. Two equal lines were two buttons
 *  that went on air together (2026-11-15 audit, D7). */
function parsePhrases(text: string): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim().slice(0, STAGE_MESSAGE_MAX_LENGTH))
    .filter((line) => line.length > 0);
  return [...new Set(lines)].slice(0, STAGE_PHRASES_MAX);
}

/** «Escenario»: how the stage screen is dressed. What it SAYS (message, countdown) is run from the work screen's
 *  stage panel, never from here (owner, 2026-11-13). As a copy of the projector only whether it plays videos. */
function StageOptionsGroup({ mirror }: { mirror: boolean }) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const defaults = t("stage.defaultPhrases");
  const stored = settings["stage.phrases"];
  const [phrases, setPhrases] = useState((stored ?? defaults.split("\n")).join("\n"));
  // Another language's defaults, or a reset: the field follows what is saved.
  useEffect(() => setPhrases((stored ?? defaults.split("\n")).join("\n")), [stored, defaults]);
  const minutes = (ms: number) => (ms < 60_000 ? t("settings.screens.halfMinute") : t("settings.screens.minutesLeft", { minutes: ms / 60_000 }));

  const savePhrases = () => {
    const list = parsePhrases(phrases);
    // The language's own list is stored as «none of mine», so it keeps following the language.
    const next = list.join("\n") === defaults ? null : list;
    if (JSON.stringify(next) !== JSON.stringify(stored)) void update({ "stage.phrases": next });
  };
  // Settings left with Esc unmounts the field with no blur: what was typed was dropped (2026-11-15 audit, D7).
  useCommitOnUnmount(savePhrases);

  return (
    <FieldGroup description={mirror ? undefined : t("settings.screens.stageGroupDesc")} title={t("settings.screens.stageGroup")}>
      <FieldRow description={t("settings.screens.videoMotionDesc")} label={t("settings.screens.videoMotion")}>
        <Switch
          checked={settings["stage.videoMotion"]}
          onChange={(e) => void update({ "stage.videoMotion": e.target.checked })}
        />
      </FieldRow>
      {mirror ? null : (
        <>
      <FieldRow description={t("settings.screens.textSizeDesc")} label={t("settings.screens.textSize")}>
        <Segmented<StageTextSize>
          label={t("settings.screens.textSize")}
          onChange={(value) => void update({ "stage.textSize": value })}
          options={STAGE_TEXT_SIZES.map((value) => ({ label: t(`settings.screens.textSizes.${value}`), value }))}
          value={settings["stage.textSize"]}
        />
      </FieldRow>
      <FieldRow label={t("settings.screens.clock")}>
        <Select
          onChange={(value) => void update({ "stage.clockFormat": value as StageClockFormat })}
          options={STAGE_CLOCK_FORMATS.map((value) => ({ label: t(`settings.screens.clocks.${value}`), value }))}
          value={settings["stage.clockFormat"]}
        />
      </FieldRow>
      <FieldRow description={t("settings.screens.chordsDesc")} label={t("settings.screens.chords")}>
        <Switch checked={settings["stage.chords"]} onChange={(e) => void update({ "stage.chords": e.target.checked })} />
      </FieldRow>
      <FieldRow description={t("settings.screens.warnDesc")} label={t("settings.screens.warn")}>
        <Select
          onChange={(value) => void update({ "stage.warnMs": Number(value) })}
          options={STAGE_WARN_OPTIONS_MS.map((ms) => ({ label: minutes(ms), value: String(ms) }))}
          value={String(settings["stage.warnMs"])}
        />
      </FieldRow>
      <FieldRow description={t("settings.screens.alertDesc")} label={t("settings.screens.alert")}>
        <Select
          onChange={(value) => void update({ "stage.alertMs": Number(value) })}
          options={STAGE_ALERT_OPTIONS_MS.map((ms) => ({ label: minutes(ms), value: String(ms) }))}
          value={String(settings["stage.alertMs"])}
        />
      </FieldRow>
      <FieldRow description={t("settings.screens.phrasesDesc")} label={t("settings.screens.phrases")}>
        <div className="flex w-64 flex-col items-end gap-1.5">
          <Textarea
            aria-label={t("settings.screens.phrases")}
            className="w-full"
            onBlur={savePhrases}
            onChange={(e) => setPhrases(e.target.value)}
            rows={5}
            value={phrases}
          />
          <Button disabled={stored === null} onClick={() => void update({ "stage.phrases": null })} size="xs" variant="outline">
            {t("settings.screens.phrasesReset")}
          </Button>
        </div>
      </FieldRow>
        </>
      )}
    </FieldGroup>
  );
}

/** Settings ▸ Screens (plan 2026-11-13 §2.4): what each screen does, and how the stage is dressed. */
export function ScreensSection() {
  // A copy of the projector shows nothing of the stage's own, but it can still play videos or not.
  const mirror = useSettingsStore((s) => s.settings["stage.mirror"]);
  return (
    <div className="flex flex-col gap-8">
      <ScreenGroup />
      <StageOptionsGroup mirror={mirror} />
    </div>
  );
}
