import { useEffect, useState } from "react";
import { ASSET_KINDS, type AssetKind } from "@shared/constants";
import type { Locale } from "@shared/types/settings";
import { availableLocales, useT, type MessageKey } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Segmented, Select, Switch } from "@renderer/components/ui";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { api } from "@renderer/lib/api";
import { PerformanceDiagnostics } from "./performance-diagnostics";

const LOCALE_LABEL_KEYS: Record<Locale, MessageKey> = {
  es: "settings.locales.es",
  en: "settings.locales.en",
  it: "settings.locales.it",
  pt: "settings.locales.pt",
};

const KIND_LABEL_KEYS: Record<AssetKind, MessageKey> = {
  video: "library.videos",
  image: "library.images",
  audio: "library.audios",
  ppt: "library.ppts",
};

/** App-wide preferences that aren't about projection: theme, language, how
 *  hard the control window works, where the file picker opens — and, at the
 *  foot, the machine's own diagnostics. */
export function SystemSection() {
  const t = useT();
  const theme = useSettingsStore((s) => s.settings["ui.theme"]);
  const locale = useSettingsStore((s) => s.settings["ui.locale"]);
  const defaultFolders = useSettingsStore((s) => s.settings["files.defaultFolders"]);
  const liveVideoMotion = useSettingsStore((s) => s.settings["monitors.liveVideoMotion"]);
  const updateSettings = useSettingsStore((s) => s.update);

  /** What each kind falls back to when it has no override — resolved by the
   *  OS, so it can only be read from main. Fetched once: a machine does not
   *  move its Music folder while Settings is open, and this section stays
   *  mounted after the first visit (see `SettingsModal`). */
  const [systemFolders, setSystemFolders] = useState<Record<AssetKind, string> | null>(null);
  useEffect(() => {
    let alive = true;
    void api.files
      .systemFolders()
      .then((folders) => {
        if (alive) setSystemFolders(folders);
      })
      .catch(() => {
        // Nothing to say: the rows fall back to naming the system folder
        // without quoting its path, and every button still works.
      });
    return () => {
      alive = false;
    };
  }, []);

  async function setFolder(kind: AssetKind, folder: string | null) {
    await updateSettings({ "files.defaultFolders": { ...defaultFolders, [kind]: folder } });
  }

  async function chooseFolder(kind: AssetKind) {
    // Opens on the folder being replaced — the override if there is one, the
    // system folder otherwise — so "Change" starts from what it is changing.
    const current = defaultFolders[kind] ?? systemFolders?.[kind];
    const chosen = await api.files.pickFolder(current);
    if (chosen !== null) await setFolder(kind, chosen);
  }

  return (
    <div className="flex flex-col gap-8">
      {/* One group, not two of one row each (2026-11-05 review). */}
      <FieldGroup title={t("settings.groups.interface")}>
        <FieldRow description={t("settings.themeDesc")} label={t("settings.theme")}>
          <Segmented
            className="w-64"
            label={t("settings.theme")}
            onChange={(theme) => void updateSettings({ "ui.theme": theme })}
            options={[
              { icon: "moon", label: t("settings.themeDark"), value: "dark" },
              { icon: "sun", label: t("settings.themeLight"), value: "light" },
            ]}
            value={theme}
          />
        </FieldRow>
        <FieldRow description={t("settings.languageDesc")} label={t("settings.language")}>
          <Select
            onChange={(value) => void updateSettings({ "ui.locale": value as Locale })}
            options={availableLocales.map((l) => ({ label: t(LOCALE_LABEL_KEYS[l]), value: l }))}
            value={locale}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup title={t("settings.groups.performance")}>
        <FieldRow
          description={t("settings.liveVideoMotionDesc")}
          help={t("settings.liveVideoMotionHelp")}
          label={t("settings.liveVideoMotion")}
        >
          <Switch
            checked={liveVideoMotion}
            onChange={(e) => void updateSettings({ "monitors.liveVideoMotion": e.target.checked })}
          />
        </FieldRow>
      </FieldGroup>

      {/* One row per kind, in `ASSET_KINDS` order, so this group cannot fall
          out of step with the resource tabs it governs. */}
      <FieldGroup description={t("settings.foldersBody")} title={t("settings.groups.folders")}>
        {ASSET_KINDS.map((kind) => {
          const override = defaultFolders[kind];
          const systemFolder = systemFolders?.[kind];
          return (
            <FieldRow
              description={
                override ??
                (systemFolder
                  ? t("settings.folderSystemValue", { path: systemFolder })
                  : t("settings.folderSystem"))
              }
              key={kind}
              label={t(KIND_LABEL_KEYS[kind])}
            >
              <Button onClick={() => void chooseFolder(kind)} variant="outline">
                {t("settings.chooseFolder")}
              </Button>
              {/* Only where there is something to undo: four greyed «Restablecer» were noise. */}
              {override !== null ? (
                <Button onClick={() => void setFolder(kind, null)} variant="ghost">
                  {t("settings.resetFolder")}
                </Button>
              ) : null}
            </FieldRow>
          );
        })}
      </FieldGroup>

      {/* What describes the machine rather than sets a preference, last on the
          page (owner, 2026-11-05: «dejalo donde está pero al fondo»). */}
      <FieldGroup title={t("settings.groups.diagnostics")}>
        <PerformanceDiagnostics />
      </FieldGroup>
    </div>
  );
}
