import { useState } from "react";
import { useT, type MessageKey } from "@renderer/lib/i18n/i18n-provider";
import { TabPanel, TabPanels, Tabs, type IconName, type TabItem } from "@renderer/components/ui";
import { useLibraryStore } from "@renderer/stores/library.store";
import { BibleBrowser } from "./bible-browser";
import { FunctionsTabs } from "./functions-tabs";
import { MediaTabs } from "./media-tabs";
import { SongsBrowser } from "@renderer/components/pages/songs/songs-browser";

type ResourceTab = "bible" | "songs" | "media" | "functions";

const TAB_ORDER: readonly ResourceTab[] = ["bible", "songs", "media", "functions"];

const ICON: Record<ResourceTab, IconName> = {
  bible: "bible",
  songs: "song",
  media: "media",
  functions: "functions",
};

const LABEL_KEY: Record<ResourceTab, MessageKey> = {
  bible: "bible.title",
  songs: "songs.tab",
  media: "resources.mediaTab",
  functions: "functions.title",
};

/** Prefix for the `tab`/`tabpanel` id pairs — the nested strips carry their
 *  own (`resources-media`, `resources-functions`), so the three can never
 *  claim the same DOM id. */
const TAB_ID_BASE = "resources";

/**
 * EasyWorship's resource area: one tabbed browser for everything that can be
 * put on screen. Nothing in here projects anything by itself — every tab funnels
 * through the same preview/go-live pair.
 *
 * Two levels, since the four file libraries stopped being the whole story:
 * this row picks WHAT KIND OF THING (scripture, a file, a generated scene) and
 * each tab's own row picks which one. The four media tabs that used to live
 * here are unchanged underneath — they moved, they were not rewritten.
 */
export function ResourcePanel() {
  const t = useT();
  const [tab, setTab] = useState<ResourceTab>("bible");
  // Tabs are mounted on first visit and never unmounted again (they are
  // hidden, not removed — see `TabPanel`). Unmounting threw away the scroll
  // position, the visible range, the fetched deck statuses and the grid's
  // measured geometry, so every return to a tab re-ran the whole
  // `deck:statuses` + prewarm cycle over a folder the operator had already
  // browsed. Only visited tabs are in here, so the cost is paid per tab
  // actually opened rather than for all of them up front.
  const [visited, setVisited] = useState<readonly ResourceTab[]>([tab]);
  const selectAsset = useLibraryStore((s) => s.select);

  const tabs: TabItem<ResourceTab>[] = TAB_ORDER.map((value) => ({
    icon: ICON[value],
    label: t(LABEL_KEY[value]),
    value,
  }));

  return (
    <>
      <Tabs
        idBase={TAB_ID_BASE}
        onChange={(value) => {
          setTab(value);
          setVisited((current) => (current.includes(value) ? current : [...current, value]));
          // Leaving the file libraries drops the library selection, so
          // Delete/Backspace stops targeting a grid that is no longer on
          // screen: `removeSelected()` prefers the library over the schedule,
          // and the next Delete used to silently remove a video the operator
          // was not even looking at. Coming BACK is `MediaTabs`' own job — it
          // is the one that knows which kind is open.
          if (value !== "media") selectAsset(null);
        }}
        tabs={tabs}
        value={tab}
        variant="underline"
      />
      <TabPanels>
        {TAB_ORDER.filter((value) => visited.includes(value)).map((value) => (
          <TabPanel active={value === tab} idBase={TAB_ID_BASE} key={value} value={value}>
            {value === "bible" ? (
              <BibleBrowser />
            ) : value === "songs" ? (
              <SongsBrowser />
            ) : value === "media" ? (
              <MediaTabs active={tab === "media"} />
            ) : (
              <FunctionsTabs />
            )}
          </TabPanel>
        ))}
      </TabPanels>
    </>
  );
}
