import { useEffect, useState } from "react";
import { useT, type MessageKey } from "@renderer/lib/i18n/i18n-provider";
import { TabPanel, TabPanels, Tabs, type TabItem } from "@renderer/components/ui";
import { useLibraryStore } from "@renderer/stores/library.store";
import { MediaBrowser } from "./media-browser";
import { ASSET_KINDS, type AssetKind } from "@shared/constants";

const LABEL_KEY: Record<AssetKind, MessageKey> = {
  video: "library.videos",
  image: "library.images",
  audio: "library.audios",
  ppt: "library.ppts",
};

/** Its own prefix, so a media panel's id can never collide with the outer
 *  resource tab that contains it. */
const TAB_ID_BASE = "resources-media";

/**
 * The four file libraries, under the Media tab.
 *
 * `ASSET_KINDS` order, not the order the labels happen to read best in: it is
 * the same order the kinds appear in everywhere else (settings, validators,
 * the import dialog), and a tab strip that disagrees with the rest of the app
 * is a tab strip someone has to re-learn.
 */
export function MediaTabs({ active }: { active: boolean }) {
  const t = useT();
  const [kind, setKind] = useState<AssetKind>("video");
  // Same rule as the outer panel: a visited tab is mounted for good (see
  // `TabPanel`), so the cost of a folder's scroll position, measured geometry
  // and deck statuses is paid once per tab actually opened.
  const [visited, setVisited] = useState<readonly AssetKind[]>([kind]);
  const setLibraryTab = useLibraryStore((s) => s.setActiveTab);

  // Keeps Delete/Backspace pointed at the grid on screen. It has to follow
  // BOTH the sub-tab and whether Media is the open tab at all: coming back
  // from Bible re-selects this kind, and `removeSelected()` prefers the
  // library over the schedule, so a stale `activeTab` is a delete that lands
  // on a list the operator is not looking at.
  useEffect(() => {
    if (active) setLibraryTab(kind);
  }, [active, kind, setLibraryTab]);

  const tabs: TabItem<AssetKind>[] = ASSET_KINDS.map((value) => ({
    icon: value,
    label: t(LABEL_KEY[value]),
    // The one too long for the narrowest window (2026-11-15 audit, U14).
    ...(value === "ppt" ? { short: t("library.pptsShort") } : {}),
    value,
  }));

  return (
    <>
      <Tabs
        idBase={TAB_ID_BASE}
        onChange={(value) => {
          setKind(value);
          setVisited((current) => (current.includes(value) ? current : [...current, value]));
        }}
        tabs={tabs}
        value={kind}
        variant="segment"
      />
      <TabPanels>
        {ASSET_KINDS.filter((value) => visited.includes(value)).map((value) => (
          <TabPanel active={value === kind} idBase={TAB_ID_BASE} key={value} value={value}>
            {/* `active` is not about painting — the panel handles that. It is
                what stops a hidden tab from going on asking main to pre-warm
                the decks in its own visible range, competing with the tab the
                operator is actually looking at. Hidden now means either kind
                of hidden: another media tab, or another resource tab. */}
            <MediaBrowser active={active && value === kind} kind={value} />
          </TabPanel>
        ))}
      </TabPanels>
    </>
  );
}
