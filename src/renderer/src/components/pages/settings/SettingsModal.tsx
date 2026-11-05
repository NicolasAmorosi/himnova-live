import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { EditorScreen } from "@renderer/components/shared/editor-screen";
import { PageHeader, TabPanel, TabPanels, Tabs, type TabItem } from "@renderer/components/ui";
import { ProjectionSection } from "./sections/projection-section";
import { BibleSection } from "./sections/bible-section";
import { SongsSection } from "./sections/songs-section";
import { SlidesSection } from "./sections/slides-section";
import { SystemSection } from "./sections/system-section";
import { AboutSection } from "./sections/about-section";
import { useUiStore, type SettingsSection } from "@renderer/stores/ui.store";

const SECTION_ID_BASE = "settings";

/** The app's settings, full screen (2026-11-04 redesign, GitHub's settings):
 *  the sections on the left, the chosen one as a page in a reading column —
 *  a header, then its groups of rows. Everything applies at once, so the bar
 *  is «← Back» and nothing to save. Add a new setting to an existing
 *  group/section, or add a section here plus one `<Tabs>` entry, not another
 *  flat row on top of the pile.
 *
 *  Open and on which section is `ui.store`'s, so a toast can land on one. */
export function SettingsModal() {
  const t = useT();
  const shown = useUiStore((s) => s.settingsSection);
  const open = shown !== null;
  const section = shown ?? "projection";
  const openSettings = useUiStore((s) => s.openSettings);
  const closeSettings = useUiStore((s) => s.closeSettings);
  // Same shape as `ResourcePanel`: only the sections actually opened are
  // mounted, and a visited one then stays mounted behind `TabPanel`. Nested
  // ternaries remounted the whole section on every switch, throwing away its
  // scroll offset — the Bible list and the slides panel are both long enough
  // to notice.
  const [visited, setVisited] = useState<readonly SettingsSection[]>([]);
  // Adjusted while rendering, not in an effect: the section can change from
  // outside (a toast's «View»), and an effect would paint one frame with no
  // panel mounted for it. Closing drops what was mounted: settings are read at
  // mount, and reopening should not show a figure from a previous visit that
  // the operator has since changed elsewhere.
  if (open ? !visited.includes(section) : visited.length > 0) {
    setVisited(open ? [...visited, section] : []);
  }

  const sections: readonly TabItem<SettingsSection>[] = [
    { icon: "display", label: t("settings.sections.projection"), value: "projection" },
    { icon: "ppt", label: t("settings.sections.slides"), value: "slides" },
    { icon: "bible", label: t("settings.sections.bible"), value: "bible" },
    { icon: "song", label: t("settings.sections.songs"), value: "songs" },
    { icon: "settings", label: t("settings.sections.system"), value: "system" },
    { icon: "info", label: t("settings.sections.about"), value: "about" },
  ];

  return (
    <EditorScreen
      list={
        <Tabs
          className="min-h-0 w-full flex-1 border-r-0"
          idBase={SECTION_ID_BASE}
          onChange={openSettings}
          tabs={sections}
          value={section}
          variant="sidebar"
        />
      }
      onClose={closeSettings}
      open={open}
      title={t("settings.title")}
    >
      <TabPanels>
        {sections
          .filter(({ value }) => visited.includes(value))
          .map(({ label, value }) => (
            <TabPanel active={value === section} idBase={SECTION_ID_BASE} key={value} value={value}>
              {/* The page is centred in the canvas, like every other screen's
                  canvas: the free space shared by both sides reads as chosen,
                  all of it on the right read as broken (owner, 2026-11-04).
                  One scrollbar, at the window's edge, its room kept on both
                  sides so the page does not shift between a section that
                  scrolls and one that does not. */}
              <div className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 pt-6 pb-16">
                  <PageHeader>{label}</PageHeader>
                  {value === "projection" ? (
                    <ProjectionSection />
                  ) : value === "slides" ? (
                    // `active` is not about painting — the panel does that.
                    // The cache figure is read at mount, and a section that
                    // stays mounted would keep showing the number from the
                    // first visit after a conversion or a purge.
                    <SlidesSection active={value === section} />
                  ) : value === "bible" ? (
                    <BibleSection />
                  ) : value === "songs" ? (
                    <SongsSection />
                  ) : value === "system" ? (
                    <SystemSection />
                  ) : (
                    <AboutSection />
                  )}
                </div>
              </div>
            </TabPanel>
          ))}
      </TabPanels>
    </EditorScreen>
  );
}
