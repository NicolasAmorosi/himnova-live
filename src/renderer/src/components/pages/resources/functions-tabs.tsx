import { useEffect, useState } from "react";
import { useEditorRecovery } from "@renderer/components/shared/editor-screen";
import { useT, type MessageKey } from "@renderer/lib/i18n/i18n-provider";
import { Badge, EmptyState, TabPanel, TabPanels, Tabs, type IconName, type TabItem } from "@renderer/components/ui";
import { PanelBody } from "@renderer/components/shared/panel";
import { UtilitiesPanel } from "@renderer/components/pages/functions/utilities-panel";
import { OverlaysPanel } from "@renderer/components/pages/functions/overlays-panel";

type FunctionTab = "utilities" | "inputs" | "overlays";

const TAB_ORDER: readonly FunctionTab[] = ["utilities", "inputs", "overlays"];

const ICON: Record<FunctionTab, IconName> = {
  utilities: "clock",
  inputs: "camera",
  overlays: "overlay",
};

const LABEL_KEY: Record<FunctionTab, MessageKey> = {
  utilities: "functions.utilities",
  inputs: "functions.inputs",
  overlays: "functions.overlays",
};

/** Only the tabs that are still placeholders — Utilities and Overlays have
 *  real panels now, so a `Record<FunctionTab, …>` would force an announcement
 *  text for a feature that has shipped. */
type PendingTab = Exclude<FunctionTab, "utilities" | "overlays">;

const TITLE_KEY: Record<PendingTab, MessageKey> = {
  inputs: "functions.inputsTitle",
};

const HINT_KEY: Record<PendingTab, MessageKey> = {
  inputs: "functions.inputsHint",
};

const TAB_ID_BASE = "resources-functions";

/**
 * The third resource tab: what can go on the projector that is not a file and
 * not scripture — a countdown, a camera, a lower third.
 *
 * Utilities and Overlays are built;
 * Inputs is still an announcement. It is a real, selectable tab rather than
 * a disabled one on purpose: the operator gets to read what it will do, which
 * is the whole value a tab has until its feature lands.
 */
export function FunctionsTabs() {
  const t = useT();
  const [tab, setTab] = useState<FunctionTab>("utilities");
  // «Recuperar» after a crash: the tab whose panel holds the editor it opens (DU-1).
  const recovering = useEditorRecovery((s) => s.queue[0]?.editor ?? null);
  useEffect(() => {
    if (recovering === "scene") setTab("utilities");
    else if (recovering === "plate") setTab("overlays");
  }, [recovering]);

  const tabs: TabItem<FunctionTab>[] = TAB_ORDER.map((value) => ({
    icon: ICON[value],
    label: t(LABEL_KEY[value]),
    value,
  }));

  return (
    <>
      <Tabs idBase={TAB_ID_BASE} onChange={setTab} tabs={tabs} value={tab} variant="segment" />
      <TabPanels>
        {/* Every panel mounted from the start, unlike the media ones: a
            placeholder costs nothing to keep alive and there is no scroll
            position, no listing and no conversion queue behind it. */}
        {TAB_ORDER.map((value) => (
          <TabPanel active={value === tab} idBase={TAB_ID_BASE} key={value} value={value}>
            {value === "utilities" ? (
              <UtilitiesPanel />
            ) : value === "overlays" ? (
              <OverlaysPanel />
            ) : (
              <PanelBody className="p-1.5">
                <EmptyState
                  action={<Badge variant="blue">{t("functions.inDevelopment")}</Badge>}
                  description={t(HINT_KEY[value])}
                  icon={ICON[value]}
                  title={t(TITLE_KEY[value])}
                />
              </PanelBody>
            )}
          </TabPanel>
        ))}
      </TabPanels>
    </>
  );
}
