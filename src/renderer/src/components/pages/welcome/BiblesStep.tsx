import { useEffect, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { Caption, FieldGroup, FieldRow, Select, Switch } from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { bibleOutputFor } from "@renderer/lib/bible-output";
import { toast } from "@renderer/lib/toast";
import { languageName } from "@renderer/lib/utils";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { INSTANT_TRANSITION, type ProjectionOutput } from "@shared/types/projection";
import type { BundledBibleDTO } from "@shared/types/bible";
import { StagePreview, StepLayout } from "./StepLayout";

const NONE = "none";

/** The verse the preview shows: one every version has, recognisable in any language. */
const SAMPLE = { bookAbbrev: "jo", chapter: 3, verse: 16 } as const;

/**
 * The Bibles that come with the app, by language — the interface's own first —, each a switch: on installs
 * it (≈0.4 s in main, the row waits), off removes it unless a saved program cites it (that is Settings'
 * question to ask, with its list). Above them, which one the Bible tab opens on and the one beside it on the
 * projector («En paralelo»), next to John 3:16 drawn as the room will see it.
 */
export function BiblesStep() {
  const { locale, t } = useI18n();
  const versions = useBibleStore((s) => s.versions);
  const loadVersions = useBibleStore((s) => s.loadVersions);
  const setParallelVersion = useBibleStore((s) => s.setParallelVersion);
  const defaultId = useSettingsStore((s) => s.settings["bible.defaultVersionId"]);
  const parallelId = useSettingsStore((s) => s.settings["bible.parallelVersionId"]);
  const style = useSettingsStore((s) => s.settings["bible.style"]);
  const update = useSettingsStore((s) => s.update);
  const [bundled, setBundled] = useState<readonly BundledBibleDTO[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<ProjectionOutput | null>(null);

  useEffect(() => {
    void api.bible
      .bundled()
      .then(setBundled)
      .catch((error: unknown) => console.warn("[welcome] could not list the bundled bibles", error));
  }, []);

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

  async function toggle(bible: BundledBibleDTO, on: boolean) {
    setBusy(bible.code);
    try {
      if (on) {
        await api.bible.installBundled(bible.code);
      } else if (bible.versionId !== null) {
        const usages = await api.bible.usages(bible.versionId);
        if (usages.length > 0) {
          toast.warning(t("welcome.bibles.inUse", { name: bible.name }));
          return;
        }
        await api.bible.delete(bible.versionId);
        useProgramStore.getState().forgetBibleVersion(bible.versionId);
      }
      await loadVersions();
      setBundled(await api.bible.bundled());
    } catch (error) {
      console.error("[welcome] bible change failed", error);
      toast.danger(t("welcome.bibles.failed", { name: bible.name }));
    } finally {
      setBusy(null);
    }
  }

  // The interface's language first, then the others in the catalog's order.
  const languages = [...new Set(bundled.map((b) => b.language))].sort((a, b) => Number(b === locale) - Number(a === locale));
  const versionOptions = versions.map((v) => ({ label: v.name, value: String(v.id) }));

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
              options={versionOptions}
              value={primary ? String(primary.id) : ""}
            />
          </FieldRow>
          <FieldRow description={t("welcome.bibles.parallelDesc")} label={t("welcome.bibles.parallel")}>
            <Select
              disabled={versions.length < 2}
              onChange={(value) => void setParallelVersion(value === NONE ? null : Number(value))}
              options={[
                { label: t("welcome.bibles.parallelNone"), value: NONE },
                ...versionOptions.filter((option) => option.value !== String(primary?.id)),
              ]}
              value={parallel ? String(parallel.id) : NONE}
            />
          </FieldRow>
        </FieldGroup>
      ) : null}
      {languages.map((language) => (
        <FieldGroup key={language} title={languageName(language, locale)}>
          {bundled
            .filter((b) => b.language === language)
            .map((bible) => {
              const installed = bible.versionId !== null;
              return (
                <FieldRow
                  description={bible.credit ?? undefined}
                  key={bible.code}
                  label={versions.find((v) => v.id === bible.versionId)?.name ?? bible.name}
                >
                  {busy === bible.code ? <Caption>{t("welcome.bibles.working")}</Caption> : null}
                  <Switch
                    aria-label={bible.name}
                    checked={installed}
                    disabled={busy !== null}
                    onChange={(e) => void toggle(bible, e.target.checked)}
                  />
                </FieldRow>
              );
            })}
        </FieldGroup>
      ))}
    </StepLayout>
  );
}
