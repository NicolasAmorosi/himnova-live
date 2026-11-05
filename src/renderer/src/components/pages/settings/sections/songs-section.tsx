import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { FieldGroup, FieldRow, Input, Select } from "@renderer/components/ui";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useSongStore } from "@renderer/stores/song.store";
import { refreshLiveSong } from "@renderer/lib/actions/songs";

/**
 * «Songs»: the theme a song without one of its own is drawn with, and the
 * church's CCLI licence for the copyright footer. Immediate, like the rest of
 * Settings; a live song is re-dressed in place.
 */
export function SongsSection() {
  const t = useT();
  const themes = useSongStore((s) => s.themes);
  const defaultThemeId = useSettingsStore((s) => s.settings["songs.defaultThemeId"]);
  const license = useSettingsStore((s) => s.settings["songs.ccliLicense"]);
  const update = useSettingsStore((s) => s.update);
  // Typed, then saved on leaving the field: a licence half typed is not one.
  const [draft, setDraft] = useState(license ?? "");
  useEffect(() => setDraft(license ?? ""), [license]);

  const commitLicense = async () => {
    const next = draft.trim() === "" ? null : draft.trim();
    if (next === license) return;
    await update({ "songs.ccliLicense": next });
    await refreshLiveSong();
  };

  return (
    <FieldGroup title={t("settings.songs.title")}>
      <FieldRow description={t("settings.songs.defaultThemeHint")} label={t("settings.songs.defaultTheme")}>
        <Select
          className="w-52"
          onChange={(value) =>
            void update({ "songs.defaultThemeId": Number(value) }).then(() => refreshLiveSong())
          }
          options={themes.map((theme) => ({ label: theme.name, value: String(theme.id) }))}
          value={String(themes.find((theme) => theme.id === defaultThemeId)?.id ?? themes[0]?.id ?? "")}
        />
      </FieldRow>
      <FieldRow description={t("settings.songs.licenseHint")} label={t("settings.songs.license")}>
        <Input
          aria-label={t("settings.songs.license")}
          maxLength={100}
          onBlur={() => void commitLicense()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitLicense();
          }}
          size="sm"
          value={draft}
        />
      </FieldRow>
    </FieldGroup>
  );
}
