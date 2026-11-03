import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { Button, FieldGroup, FieldRow, ProgressBar, Select } from "@renderer/components/ui";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { formatBytes } from "@renderer/lib/utils";
import { SLIDE_FALLBACK_FONTS, SLIDE_IMAGE_FORMATS, type SlideFallbackFont, type SlideImageFormat } from "@shared/types/settings";
import type { DeckCacheStats } from "@shared/types/deck";

/** Offered as a list rather than a free number field: every value here is
 *  valid, and the validator's range (1 MB … 1 TB) contains plenty that are
 *  technically accepted and practically absurd. */
const CACHE_MB_OPTIONS = [1024, 2048, 4096, 8192, 16_384] as const;

/** Bounded at the top by what a projector can actually show. 3840 is there for
 *  a 4K house screen; past that the extra pixels only cost disk and decode. */
const RENDER_WIDTH_OPTIONS = [1280, 1600, 1920, 2560, 3840] as const;

/**
 * The slide cache — what it costs, and its cap — and what a PDF's pages are
 * drawn at. Changing the width or the format opens a PDF again the next time
 * it is opened (~25 ms) and draws its pages anew; nothing is ever converted.
 * (Every other deck is read from its source and owns no images: these two
 * knobs never touch it.)
 */
export function SlidesSection({ active }: { active: boolean }) {
  const { t, locale } = useI18n();
  const cacheMaxMb = useSettingsStore((s) => s.settings["slides.cacheMaxMb"]);
  const renderWidth = useSettingsStore((s) => s.settings["slides.maxRenderWidth"]);
  const imageFormat = useSettingsStore((s) => s.settings["slides.imageFormat"]);
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

  async function change(patch: Parameters<typeof updateSettings>[0]) {
    await updateSettings(patch);
    await refresh();
  }

  async function clearCache() {
    const next = await api.deck.clearCache();
    setStats(next);
    toast.success(t("settings.slidesCacheCleared"));
  }

  const usedFraction = stats && stats.maxBytes > 0 ? stats.bytesOnDisk / stats.maxBytes : 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Reaches what is live at once and with no transition (`App` mirrors it
          into every slide output), like the verse's style. */}
      <FieldGroup title={t("settings.groups.slidesText")}>
        <FieldRow description={t("settings.slidesFallbackFontDesc")} label={t("settings.slidesFallbackFont")}>
          <Select
            className="min-w-40"
            onChange={(value) => void updateSettings({ "slides.fallbackFont": value ? (value as SlideFallbackFont) : null })}
            options={[
              { label: t("settings.slidesFallbackFontSystem"), value: "" },
              ...SLIDE_FALLBACK_FONTS.map((font) => ({ label: font, value: font })),
            ]}
            size="md"
            value={fallbackFont ?? ""}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup title={t("settings.groups.slidesCache")}>
        <FieldRow
          description={
            stats
              ? t("settings.slidesCacheUsageDesc", { decks: stats.deckCount })
              : t("settings.slidesCacheLoading")
          }
          label={t("settings.slidesCacheUsage")}
        >
          <div className="flex w-56 flex-col gap-1.5">
            <span className="text-sm font-medium tabular-nums text-foreground">
              {stats
                ? t("settings.slidesCacheOf", {
                    used: formatBytes(stats.bytesOnDisk, locale),
                    max: formatBytes(stats.maxBytes, locale),
                  })
                : "—"}
            </span>
            <ProgressBar
              aria-label={t("settings.slidesCacheUsage")}
              // At the cap nothing is broken — eviction just starts taking the
              // oldest decks. The colour says "this is why a deck you prepared
              // last month is gone", which is the only question it ever raises.
              tone={usedFraction >= 1 ? "danger" : "accent"}
              value={usedFraction}
            />
          </div>
          <Button disabled={!stats || stats.deckCount === 0} onClick={() => setConfirmClear(true)} variant="outline">
            {t("settings.slidesCacheClear")}
          </Button>
        </FieldRow>

        <FieldRow description={t("settings.slidesCacheMaxDesc")} label={t("settings.slidesCacheMax")}>
          <Select
            className="min-w-40"
            onChange={(value) => void change({ "slides.cacheMaxMb": Number(value) })}
            options={CACHE_MB_OPTIONS.map((mb) => ({
              label: formatBytes(mb * 1024 * 1024, locale),
              value: String(mb),
            }))}
            size="md"
            value={String(cacheMaxMb)}
          />
        </FieldRow>
      </FieldGroup>

      <FieldGroup title={t("settings.groups.slidesQuality")}>
        <FieldRow description={t("settings.slidesRenderWidthDesc")} label={t("settings.slidesRenderWidth")}>
          <Select
            className="min-w-40"
            onChange={(value) => void change({ "slides.maxRenderWidth": Number(value) })}
            options={RENDER_WIDTH_OPTIONS.map((px) => ({ label: `${px} px`, value: String(px) }))}
            size="md"
            value={String(renderWidth)}
          />
        </FieldRow>

        <FieldRow description={t("settings.slidesImageFormatDesc")} label={t("settings.slidesImageFormat")}>
          <Select
            className="min-w-40"
            onChange={(value) => void change({ "slides.imageFormat": value as SlideImageFormat })}
            options={SLIDE_IMAGE_FORMATS.map((format) => ({
              label: t(`settings.slidesImageFormats.${format}`),
              value: format,
            }))}
            size="md"
            value={imageFormat}
          />
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
