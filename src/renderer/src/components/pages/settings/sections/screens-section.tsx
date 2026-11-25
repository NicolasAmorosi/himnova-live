import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Segmented, Select, Slider, Switch, Textarea } from "@renderer/components/ui";
import { ScreenGroup } from "@renderer/components/shared/settings-groups/screen-group";
import { api } from "@renderer/lib/api";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { PROJECTOR_FIT_MAX_SCREENS, PROJECTOR_FIT_MIN } from "@shared/types/display";
import { useCommitOnUnmount } from "@renderer/lib/hooks/use-commit-on-unmount";
import { screenResolution } from "@renderer/lib/screen-label";
import {
  STAGE_ALERT_OPTIONS_MS,
  STAGE_CLOCK_FORMATS,
  STAGE_TEXT_SIZES,
  STAGE_WARN_OPTIONS_MS,
  type StageClockFormat,
  normalizeStagePhrases,
  type StageTextSize,
} from "@shared/types/stage";

/** The phrases as typed: one per line, blank lines, repeats and the excess dropped. Two equal lines were two buttons
 *  that went on air together (2026-11-15 audit, D7). */
function parsePhrases(text: string): string[] {
  return normalizeStagePhrases(text.split("\n"));
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

/** «Ajuste del proyector» (owner, 2026-11-21): a projector or TV that overscans a 1920x1080 signal cuts ~5 % off
 *  every edge, so the picture is drawn smaller and centred until the pattern's border shows whole on the wall. Kept
 *  for the projector's screen (`projection.fit`); the pattern stays on until it is switched off or Settings closes. A
 *  projector on the operator's own screen (one screen) is a movable window: nothing to fit. */
function ProjectorFitGroup() {
  const t = useT();
  const displays = useDisplayStore((s) => s.displays);
  const projectorId = useDisplayStore((s) => s.displayId);
  const fits = useSettingsStore((s) => s.settings["projection.fit"]);
  const update = useSettingsStore((s) => s.update);
  const [pattern, setPattern] = useState(false);
  useEffect(() => {
    if (!pattern) return;
    void api.projection.showPattern(true);
    return () => void api.projection.showPattern(false);
  }, [pattern]);
  const index = displays.findIndex((d) => d.id === projectorId && !d.operator);
  const projector = displays[index];
  // Its switch goes with its screen: the pattern must not come back with a screen this page no longer names.
  useEffect(() => {
    if (!projector) setPattern(false);
  }, [projector]);
  if (!projector) return null;
  const fit = fits[projector.fitKey] ?? 100;
  return (
    <FieldGroup
      description={t("settings.screens.fitDesc", { screen: projector.name ? `${index + 1} · ${projector.name}` : `${index + 1}` })}
      title={t("settings.screens.fitTitle")}
    >
      {/* Its own row, in pixels, and what the picture takes once it is fitted (owner, 2026-11-25). */}
      <FieldRow description={screenResolution(projector, t, fit)} label={t("settings.screens.resolution")}>
        {null}
      </FieldRow>
      <FieldRow description={t("settings.screens.fitSizeDesc")} label={t("settings.screens.fitSize")}>
        <Slider
          label={t("settings.screens.fitSize")}
          max={100}
          min={PROJECTOR_FIT_MIN}
          onChange={(value) => {
            // 100 is no fit: kept out of the map, which holds `PROJECTOR_FIT_MAX_SCREENS` screens at most; a new one
            // past that forgets the screen set longest ago, or main refused the whole write.
            const { [projector.fitKey]: _old, ...rest } = fits;
            const kept = Object.fromEntries(Object.entries(rest).slice(1 - PROJECTOR_FIT_MAX_SCREENS));
            void update({ "projection.fit": value === 100 ? rest : { ...kept, [projector.fitKey]: value } });
          }}
          step={1}
          unit="%"
          value={fit}
        />
      </FieldRow>
      <FieldRow description={t("settings.screens.patternDesc")} label={t("settings.screens.pattern")}>
        <Switch
          checked={pattern}
          onChange={(e) => {
            setPattern(e.target.checked);
            // On the wall, where it is looked at: a closed projector opens on BLACK, as Settings' «Abrir» does. Opening
            // it as a GO LIVE replayed what was live when it closed, its music included, under the pattern.
            if (e.target.checked && !useProjectionStore.getState().presentationOpen) void useDisplayStore.getState().open();
          }}
        />
      </FieldRow>
    </FieldGroup>
  );
}

/** Settings ▸ Screens (owner, 2026-11-13): what each screen does, and how the stage is dressed. */
export function ScreensSection() {
  // A copy of the projector shows nothing of the stage's own, but it can still play videos or not.
  const mirror = useSettingsStore((s) => s.settings["stage.mirror"]);
  return (
    <div className="flex flex-col gap-8">
      <ScreenGroup />
      <ProjectorFitGroup />
      <StageOptionsGroup mirror={mirror} />
    </div>
  );
}
