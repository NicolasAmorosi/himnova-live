import type { SongUse } from "@shared/types/song";
import { mainLocale, mt } from "../i18n";

const pad = (n: number) => String(n).padStart(2, "0");
export const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * The CCLI usage report as CSV: one row per song — title, authors, CCLI
 * number (empty when the song has none: the operator sees what to fill in),
 * how many days it was used and which — the most used first. With a BOM, so
 * Excel reads the accents.
 */
export function songUsageCsv(uses: readonly SongUse[]): string {
  // ponytail: the separator follows the app's language — Excel in Spanish, Italian and Portuguese splits on «;»,
  // in English on «,». A sheet opened in another locale's Excel needs Data ▸ Text to columns.
  const separator = mainLocale() === "en" ? "," : ";";
  const cell = (value: string) => (/[",;\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const sorted = [...uses].sort((a, b) => b.days.length - a.days.length || a.title.localeCompare(b.title, mainLocale()));
  const rows = [
    [mt("songs.usageTitle"), mt("songs.usageAuthors"), mt("songs.usageCcli"), mt("songs.usageCount"), mt("songs.usageDates")],
    ...sorted.map((use) => [
      use.title,
      use.authors ?? "",
      use.ccliNumber ?? "",
      String(use.days.length),
      use.days.map(localDay).join(" "),
    ]),
  ];
  return `\uFEFF${rows.map((row) => row.map(cell).join(separator)).join("\r\n")}\r\n`;
}
