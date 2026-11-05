import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import {
  Button,
  Callout,
  DialogContent,
  DialogFooter,
  DialogHeader,
  FieldGroup,
  FieldRow,
  Icon,
  Input,
  Label,
  Select,
} from "@renderer/components/ui";
import { Modal, ModalTitle } from "@renderer/components/shared/modal";
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
  const [reportOpen, setReportOpen] = useState(false);

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
          placeholder={t("settings.songs.licensePlaceholder")}
          size="sm"
          value={draft}
        />
      </FieldRow>
      {/* A dialog, not three controls in the row: it is used twice a year
          (owner, 2026-11-05: the dates and the button piled up there). */}
      <FieldRow description={t("settings.songs.usageHint")} label={t("settings.songs.usage")}>
        <Button onClick={() => setReportOpen(true)} variant="outline">
          <Icon name="download" />
          {t("settings.songs.usageOpen")}
        </Button>
      </FieldRow>
      <UsageReportDialog onOpenChange={setReportOpen} open={reportOpen} />
    </FieldGroup>
  );
}

/** The CCLI report's dates, the last six months to start with, and the
 *  export. Closes once a file is written; with nothing in the range it stays,
 *  so the dates can be changed. */
function UsageReportDialog({ onOpenChange, open }: { onOpenChange: (open: boolean) => void; open: boolean }) {
  const t = useT();
  const [range, setRange] = useState(lastSixMonths);
  const [exporting, setExporting] = useState(false);
  /** The dates last tried held no song: said here, where the dates are. */
  const [empty, setEmpty] = useState(false);
  const valid = range.from !== "" && range.to !== "" && range.from <= range.to;

  async function exportReport() {
    setExporting(true);
    const outcome = await exportSongUsage(range.from, range.to);
    setExporting(false);
    setEmpty(outcome === "empty");
    if (outcome === "written") onOpenChange(false);
  }

  return (
    <Modal onOpenChange={onOpenChange} open={open} size="sm">
      <DialogHeader>
        <ModalTitle>{t("settings.songs.usageTitle")}</ModalTitle>
      </DialogHeader>
      <DialogContent className="grid grid-cols-2 gap-3">
        <Label className="flex flex-col gap-1.5">
          {t("settings.songs.usageFrom")}
          <Input
            max={range.to}
            onChange={(e) => {
              setRange((r) => ({ ...r, from: e.target.value }));
              setEmpty(false);
            }}
            type="date"
            value={range.from}
          />
        </Label>
        <Label className="flex flex-col gap-1.5">
          {t("settings.songs.usageTo")}
          <Input
            aria-invalid={!valid || undefined}
            min={range.from}
            onChange={(e) => {
              setRange((r) => ({ ...r, to: e.target.value }));
              setEmpty(false);
            }}
            type="date"
            value={range.to}
          />
        </Label>
        {empty ? (
          <Callout className="col-span-2 py-2" role="status" tone="info">
            {t("settings.songs.usageEmpty")}
          </Callout>
        ) : null}
      </DialogContent>
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)} variant="ghost">
          {t("common.cancel")}
        </Button>
        <Button disabled={!valid} loading={exporting} onClick={() => void exportReport()} variant="primary">
          {t("settings.songs.usageExport")}
        </Button>
      </DialogFooter>
    </Modal>
  );
}
