import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Modal } from "@renderer/components/shared/modal/Modal";
import { DialogHeader, IconButton, Icon, TabPanel, TabPanels, Tabs, type TabItem } from "@renderer/components/ui";
import { ModalTitle } from "@renderer/components/shared/modal";
import { ProjectionSection } from "./sections/projection-section";
import { VerseSection } from "./sections/verse/verse-section";
import { BibleSection } from "./sections/bible-section";
import { SongsSection } from "./sections/songs-section";
import { SlidesSection } from "./sections/slides-section";
import { SystemSection } from "./sections/system-section";
import { AboutSection } from "./sections/about-section";
import { useUiStore, type SettingsSection } from "@renderer/stores/ui.store";

const SECTION_ID_BASE = "settings";

/** The app's settings surface: categories on the left (macOS System Settings
 *  style), a scrollable panel of grouped rows on the right. The dialog itself
 *  has a large, fixed height — switching category never resizes it. Add a new
 *  setting to an existing group/section, or add a section here plus one
 *  `<Tabs>` entry, not another flat row on top of the pile.
 *
 *  Open and on which section is `ui.store`'s, so a toast can land on one. */
export function SettingsModal() {
  const t = useT();
  const shown = useUiStore((s) => s.settingsSection);
  const open = shown !== null;
  const section = shown ?? "projection";
  const openSettings = useUiStore((s) => s.openSettings);
  const closeSettings = useUiStore((s) => s.closeSettings);
  // Same shape as `ResourcePanel`: only the categories actually opened are
  // mounted, and a visited one then stays mounted behind `TabPanel`. Nested
  // ternaries remounted the whole section on every switch, throwing away its
  // scroll offset — the Bible list and the slides panel are both long enough
  // to notice.
  const [visited, setVisited] = useState<readonly SettingsSection[]>([]);
  // Adjusted while rendering, not in an effect: the section can change from
  // outside (a toast's «View»), and an effect would paint one frame with no
  // panel mounted for it. Closing drops what was mounted: settings are read at
  // mount, and reopening the dialog should not show a figure from a previous
  // visit that the operator has since changed elsewhere.
  if (open ? !visited.includes(section) : visited.length > 0) {
    setVisited(open ? [...visited, section] : []);
  }

  const sections: readonly TabItem<SettingsSection>[] = [
    { icon: "display", label: t("settings.sections.projection"), value: "projection" },
    { icon: "ppt", label: t("settings.sections.slides"), value: "slides" },
    // «Verses» is how a verse is DRESSED; «Bible» is which bibles are
    // installed. They were one section with two tabs, and the tab row read as
    // a second, competing level of the category list right beside it.
    { icon: "text", label: t("settings.sections.verse"), value: "verse" },
    { icon: "bible", label: t("settings.sections.bible"), value: "bible" },
    { icon: "song", label: t("settings.sections.songs"), value: "songs" },
    { icon: "settings", label: t("settings.sections.system"), value: "system" },
    { icon: "info", label: t("settings.sections.about"), value: "about" },
  ];

  return (
    <Modal
      height="tall"
      onOpenChange={(next) => {
        if (!next) closeSettings();
      }}
      open={open}
      size="2xl"
    >
      <DialogHeader className="border-b border-border">
        <ModalTitle>{t("settings.title")}</ModalTitle>
        {/* The native `title`, like the close button of every other modal here
            (`ScenesModal`, `ProgramsModal`, `ConfirmModal`). An X needs no
            bubble to explain it, and converting this one alone would only make
            the four differ. */}
        <IconButton
          aria-label={t("settings.close")}
          onClick={closeSettings}
          size="xs"
          title={t("settings.close")}
          variant="ghost"
        >
          <Icon name="close" />
        </IconButton>
      </DialogHeader>
      <div className="flex min-h-0 flex-1">
        <Tabs
          idBase={SECTION_ID_BASE}
          onChange={openSettings}
          tabs={sections}
          value={section}
          variant="sidebar"
        />
        {/* `TabPanels` positions its panels absolutely, so it needs a flex
            parent that actually gives it a height to fill. */}
        <div className="flex min-w-0 min-h-0 flex-1 flex-col">
          <TabPanels>
            {sections
              .map((s) => s.value)
              .filter((value) => visited.includes(value))
              .map((value) => (
                <TabPanel active={value === section} idBase={SECTION_ID_BASE} key={value} value={value}>
                  {/* «Verses» is the one section that scrolls ITSELF: its
                      live preview is a fixed band above the controls, exactly
                      like the scene editor's, and a band cannot be pinned from
                      inside a scroller that also owns the padding around it. So
                      that section gets a bare flex column and lays out its own
                      header and its own scrolling body; every other one keeps
                      the shared scroller, which is what makes them all share a
                      gutter. */}
                  <div
                    className={
                      value === "verse"
                        ? "flex min-w-0 min-h-0 flex-1 flex-col"
                        : "min-w-0 flex-1 overflow-y-auto p-6"
                    }
                  >
                    {value === "projection" ? (
                      <ProjectionSection />
                    ) : value === "slides" ? (
                      // `active` is not about painting — the panel does that.
                      // The cache figure is read at mount, and a section that
                      // stays mounted would keep showing the number from the
                      // first visit after a conversion or a purge.
                      <SlidesSection active={value === section} />
                    ) : value === "verse" ? (
                      <VerseSection />
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
                </TabPanel>
              ))}
          </TabPanels>
        </div>
      </div>
    </Modal>
  );
}
