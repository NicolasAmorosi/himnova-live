import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { Button, Caption, FieldGroup, FieldRow, Icon } from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { byLanguage, describeError, languageName } from "@renderer/lib/utils";
import { toast } from "@renderer/lib/toast";
import { useBibleStore } from "@renderer/stores/bible.store";
import type { BundledBibleDTO } from "@shared/types/bible";

/** One language's versions inside a list, under its name: a nested list, so the
 *  rows of a language keep their lines between them and none under the name. */
export function LanguageGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <li>
      <Caption className="block px-4 pt-3">{label}</Caption>
      <ul aria-label={label} className="divide-y divide-border">
        {children}
      </ul>
    </li>
  );
}

/**
 * «Included with Himnova Live»: the bundled Bibles by language — the interface's own first —, each with
 * «Install». Settings ▸ Bible lists only the ones still to install (the installed ones are its list above);
 * the welcome lists them all, the installed ones marked so (owner, 2026-11-09: «like Settings, install and
 * go»). Removing one is Settings' job: it is the one that can say which saved programs cite it.
 */
export function BundledBiblesGroup({ showInstalled = false }: { showInstalled?: boolean }) {
  const { locale, t } = useI18n();
  const versions = useBibleStore((s) => s.versions);
  const loadVersions = useBibleStore((s) => s.loadVersions);
  const [bundled, setBundled] = useState<readonly BundledBibleDTO[]>([]);
  const [installingCode, setInstallingCode] = useState<string | null>(null);

  // Read again whenever the installed list changes — an install, a delete, an import.
  useEffect(() => {
    let current = true;
    api.bible
      .bundled()
      .then((list) => {
        if (current) setBundled(list);
      })
      .catch((error: unknown) => console.error("[bible] bundled list failed", error));
    return () => {
      current = false;
    };
  }, [versions]);

  /** ~0.4 s of synchronous work in main: the row says so and every «Install» waits for it, so a second click
   *  cannot start a second one. */
  async function install(bible: BundledBibleDTO) {
    setInstallingCode(bible.code);
    try {
      const version = await api.bible.installBundled(bible.code);
      await loadVersions();
      // Before the row stops loading, or it would flash back to «Install».
      setBundled(await api.bible.bundled());
      toast.success(t("settings.bible.installDone", { name: version.name }));
    } catch (error) {
      console.error("[bible] install failed", error);
      toast.danger(describeError(error, t("settings.bible.installFailed")));
    } finally {
      setInstallingCode(null);
    }
  }

  // The interface's language first, the others in the catalog's order (`sort` is stable).
  const shown = bundled
    .filter((bible) => showInstalled || bible.versionId === null)
    .sort((a, b) => Number(b.language === locale) - Number(a.language === locale));
  if (shown.length === 0) return null;

  return (
    <FieldGroup description={t("settings.bible.bundledDesc")} title={t("settings.groups.versionsBundled")}>
      <ul aria-label={t("settings.bible.bundledLabel")} className="divide-y divide-border">
        {byLanguage(shown).map(([language, members]) => (
          <LanguageGroup key={language} label={languageName(language, locale)}>
            {members.map((bible) => (
              <li key={bible.code}>
                <FieldRow
                  description={bible.credit ?? undefined}
                  label={
                    <span className="truncate">
                      {versions.find((v) => v.id === bible.versionId)?.name ?? bible.name}
                    </span>
                  }
                >
                  {bible.versionId !== null ? (
                    <Caption className="flex items-center gap-1.5">
                      <Icon className="text-success-ink" name="circleCheck" />
                      {t("settings.bible.installed")}
                    </Caption>
                  ) : (
                    <Button
                      disabled={installingCode !== null}
                      loading={installingCode === bible.code}
                      loadingLabel={t("settings.bible.installing")}
                      onClick={() => void install(bible)}
                      variant="outline"
                    >
                      <Icon name="download" />
                      {t("settings.bible.install")}
                    </Button>
                  )}
                </FieldRow>
              </li>
            ))}
          </LanguageGroup>
        ))}
      </ul>
    </FieldGroup>
  );
}
