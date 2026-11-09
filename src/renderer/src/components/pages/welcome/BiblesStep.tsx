import { useEffect, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { FieldGroup, FieldRow, Select } from "@renderer/components/ui";
import { BundledBiblesGroup } from "@renderer/components/shared/settings-groups/bundled-bibles-group";
import { api } from "@renderer/lib/api";
import { bibleOutputFor } from "@renderer/lib/bible-output";
import { bibleVersionOptions } from "@renderer/lib/utils";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { INSTANT_TRANSITION, type ProjectionOutput } from "@shared/types/projection";
import { StagePreview, StepLayout } from "./StepLayout";

const NONE = "none";

/** The verse the preview shows: one every version has, recognisable in any language. */
const SAMPLE = { bookAbbrev: "jo", chapter: 3, verse: 16 } as const;

/**
 * Which version the Bible tab opens on and the one beside it on the projector («En paralelo»), next to John
 * 3:16 drawn as the room will see it; under them the Bibles that come with the app, as Settings lists them —
 * «Install» and go (owner, 2026-11-09).
 */
export function BiblesStep() {
  const { locale, t } = useI18n();
  const versions = useBibleStore((s) => s.versions);
  const setParallelVersion = useBibleStore((s) => s.setParallelVersion);
  const defaultId = useSettingsStore((s) => s.settings["bible.defaultVersionId"]);
  const parallelId = useSettingsStore((s) => s.settings["bible.parallelVersionId"]);
  const style = useSettingsStore((s) => s.settings["bible.style"]);
  const update = useSettingsStore((s) => s.update);
  const [output, setOutput] = useState<ProjectionOutput | null>(null);

  // The default as the tab reads it: the setting, else the first installed version.
  const primary = versions.find((v) => v.id === defaultId) ?? versions[0];
  const parallel = versions.find((v) => v.id === parallelId && v.id !== primary?.id);

  useEffect(() => {
    if (!primary) {
      setOutput(null);
      return;
    }
    let current = true;
    const passage = (versionId: number) =>
      api.bible.passage(versionId, SAMPLE.bookAbbrev, SAMPLE.chapter, SAMPLE.verse, SAMPLE.verse).catch(() => null);
    void Promise.all([passage(primary.id), parallel ? passage(parallel.id) : null]).then(([main, side]) => {
      if (!current || !main) return;
      const dressed = bibleOutputFor(
        {
          text: main.text,
          reference: main.reference,
          versionLabel: primary.name,
          parallel: side && parallel ? { ...side, versionLabel: parallel.name } : null,
        },
        style,
      );
      setOutput({ ...dressed, videoUnderlay: null, slideVideo: null, plates: [], transition: INSTANT_TRANSITION });
    });
    return () => {
      current = false;
    };
  }, [primary, parallel, style]);

  return (
    <StepLayout
      aside={
        output ? (
          <StagePreview caption={t("welcome.congregationSees")} hint={t("welcome.bibles.previewHint")} output={output} />
        ) : undefined
      }
      subtitle={t("welcome.bibles.subtitle")}
      title={t("welcome.bibles.title")}
    >
      {versions.length > 0 ? (
        <FieldGroup title={t("welcome.bibles.projecting")}>
          <FieldRow description={t("welcome.bibles.defaultDesc")} label={t("welcome.bibles.default")}>
            <Select
              onChange={(value) => {
                const id = Number(value);
                void update({ "bible.defaultVersionId": id });
                void useBibleStore.getState().setVersion(id);
              }}
              options={bibleVersionOptions(versions, locale)}
              value={primary ? String(primary.id) : ""}
            />
          </FieldRow>
          <FieldRow description={t("welcome.bibles.parallelDesc")} label={t("welcome.bibles.parallel")}>
            <Select
              disabled={versions.length < 2}
              onChange={(value) => void setParallelVersion(value === NONE ? null : Number(value))}
              options={[
                { label: t("welcome.bibles.parallelNone"), value: NONE },
                ...bibleVersionOptions(
                  versions.filter((v) => v.id !== primary?.id),
                  locale,
                ),
              ]}
              value={parallel ? String(parallel.id) : NONE}
            />
          </FieldRow>
        </FieldGroup>
      ) : null}
      <BundledBiblesGroup showInstalled />
    </StepLayout>
  );
}
