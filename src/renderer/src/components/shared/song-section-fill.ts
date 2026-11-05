import type { SongSectionType } from "@shared/types/song";

/** A section's colour, as a fill. Tokens of the sheet (`--color-section-*`). */
export const SECTION_FILL: Record<SongSectionType, string> = {
  verse: "bg-section-verse",
  prechorus: "bg-section-prechorus",
  chorus: "bg-section-chorus",
  bridge: "bg-section-bridge",
  ending: "bg-section-other",
  intro: "bg-section-other",
  other: "bg-section-other",
};
