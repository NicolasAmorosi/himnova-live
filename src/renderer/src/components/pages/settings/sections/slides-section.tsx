import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, Select } from "@renderer/components/ui";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { formatBytes } from "@renderer/lib/utils";
import { SLIDE_FALLBACK_FONTS, type SlideFallbackFont } from "@shared/types/settings";
import type { DeckCacheStats } from "@shared/types/deck";

/**
 * The face a slide falls back to, and the slide cache: the audio and video
 * taken out of a `.pptx`, which is all a deck keeps on disk. Its cap and a
 * PDF's width and format were settings until 2026-11-05; they are automatic
 * now (owner: «¿esto es necesario?»), and emptying it is what is left — for
 * when something got stuck.
 */
export function SlidesSection({ active }: { active: boolean }) {
  const { t, locale } = useI18n();
  const fallbackFont = useSettingsStore((s) => s.settings["slides.fallbackFont"]);
  const updateSettings = useSettingsStore((s) => s.update);
  const liveDeckAssetId = useProjectionStore((s) => (s.base?.kind === "deck" ? s.base.assetId : null));

  const [stats, setStats] = useState<DeckCacheStats | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStats(await api.deck.cacheStats());
    } catch (error) {
      console.warn("[slides] cache stats failed", error);
    }
  }, []);

  // Read whenever the section becomes the visible one. It stays mounted once
  // visited (see `SettingsModal`), so reading only at mount would pin the
  // figure to the first visit — across a conversion or a purge started from
  // anywhere else in the app. Still not live: the cache only grows through
  // conversions the operator started, so polling would be motion for its own
  // sake.
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  async function clearCache() {
    const next = await api.deck.clearCache();
    setStats(next);
    toast.success(t("settings.slidesCacheCleared"));
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Reaches what is live at once and with no transition (`App` mirrors it
          into every slide output), like the verse's style. */}
      <FieldGroup title={t("settings.groups.slidesText")}>
        <FieldRow
          description={t("settings.slidesFallbackFontDesc")}
          help={t("settings.slidesFallbackFontHelp")}
          label={t("settings.slidesFallbackFont")}
        >
          <Select
            onChange={(value) => void updateSettings({ "slides.fallbackFont": value ? (value as SlideFallbackFont) : null })}
            options={[
              { label: t("settings.slidesFallbackFontSystem"), value: "" },
              ...SLIDE_FALLBACK_FONTS.map((font) => ({ label: font, value: font })),
            ]}
            value={fallbackFont ?? ""}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup title={t("settings.groups.slidesCache")}>
        <FieldRow
          description={
            stats
              ? `${formatBytes(stats.bytesOnDisk, locale)} · ${t("settings.slidesCacheUsageDesc", { decks: stats.deckCount })}`
              : t("settings.slidesCacheLoading")
          }
          label={t("settings.slidesCacheUsage")}
        >
          <Button disabled={!stats || stats.deckCount === 0} onClick={() => setConfirmClear(true)} variant="outline">
            {t("settings.slidesCacheClear")}
          </Button>
        </FieldRow>
      </FieldGroup>

      <ConfirmModal
        confirmLabel={t("settings.slidesCacheClear")}
        danger
        description={
          liveDeckAssetId !== null
            ? t("settings.slidesCacheClearLiveBody")
            : t("settings.slidesCacheClearBody", { decks: stats?.deckCount ?? 0 })
        }
        onConfirm={clearCache}
        onOpenChange={setConfirmClear}
        open={confirmClear}
        title={t("settings.slidesCacheClearTitle")}
      />
    </div>
  );
}
