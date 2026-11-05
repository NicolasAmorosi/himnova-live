import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Icon, Input, Select } from "@renderer/components/ui";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useSongStore } from "@renderer/stores/song.store";
import { exportSongUsage, refreshLiveSong } from "@renderer/lib/actions/songs";

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** The last six months, today included: CCLI's reporting period. */
function lastSixMonths(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setMonth(from.getMonth() - 6);
  return { from: isoDay(from), to: isoDay(today) };
}

/**
 * «Songs»: the theme a song without one of its own is drawn with, the
 * church's CCLI licence for the copyright footer, and the CCLI usage report
 * (owner, 2026-11-05: here, beside the licence — it is used twice a year).
 * Immediate, like the rest of Settings; a live song is re-dressed in place.
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
  const [range, setRange] = useState(lastSixMonths);
  const [exporting, setExporting] = useState(false);
  const rangeValid = range.from !== "" && range.to !== "" && range.from <= range.to;

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
      <FieldRow description={t("settings.songs.usageHint")} label={t("settings.songs.usage")}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {t("settings.songs.usageFrom")}
            <Input
              className="w-36"
              max={range.to}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              size="sm"
              type="date"
              value={range.from}
            />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {t("settings.songs.usageTo")}
            <Input
              className="w-36"
              min={range.from}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              size="sm"
              type="date"
              value={range.to}
            />
          </label>
          <Button
            disabled={!rangeValid || exporting}
            onClick={() => {
              setExporting(true);
              void exportSongUsage(range.from, range.to).finally(() => setExporting(false));
            }}
            size="sm"
            variant="outline"
          >
            <Icon name="download" />
            {t("settings.songs.usageExport")}
          </Button>
        </div>
      </FieldRow>
    </FieldGroup>
  );
}
