import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { Button } from "@renderer/components/ui";
import { cn } from "@renderer/lib/utils";
import { formatOrder, sectionLabel } from "@shared/song-text";
import type { SongSection } from "@shared/types/song";
import { SECTION_FILL } from "./song-section-fill";

/** The key that jumps to a section, as `use-global-shortcuts.ts` reads it. */
function sectionKeyName(section: SongSection): string | null {
  if (section.type === "verse") return section.number <= 9 ? String(section.number) : null;
  if (section.type === "chorus") return "C";
  if (section.type === "bridge") return "P";
  if (section.type === "ending") return "F";
  return null;
}

/**
 * One button per section of the song, in the order it is written, each with
 * its colour and the key that does the same (owner, 2026-11-04: click AND key).
 * `onPick` gets whether Shift was held — the previous time, like the key.
 */
export function SongSectionButtons({
  activeKey,
  onPick,
  sections,
}: {
  activeKey: string | null;
  onPick: (section: SongSection, shift: boolean) => void;
  sections: readonly SongSection[];
}) {
  const { locale, t } = useI18n();
  return (
    <div aria-label={t("songs.sectionsLabel")} className="flex flex-wrap gap-1" role="group">
      {sections.map((section) => {
        const key = sectionKeyName(section);
        const label = sectionLabel(section.type, section.number, locale);
        return (
          <Button
            aria-label={label}
            key={section.key}
            onClick={(e) => onPick(section, e.shiftKey)}
            size="xs"
            title={key ? t("songs.jumpHint", { section: label, key }) : label}
            toggled={activeKey === section.key}
            variant="outline"
          >
            <span className={cn("size-2 rounded-full", SECTION_FILL[section.type])} />
            {formatOrder([section.key], locale)}
          </Button>
        );
      })}
    </div>
  );
}
