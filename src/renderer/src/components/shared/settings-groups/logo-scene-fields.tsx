import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Box, FieldRow, Input } from "@renderer/components/ui";
import { OutputView } from "@renderer/components/shared/output-view";
import { BackgroundFields } from "@renderer/components/shared/style-fields";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { useCommitOnUnmount } from "@renderer/lib/hooks/use-commit-on-unmount";
import { useLogoPreview } from "./use-logo-preview";
import { useEditorLibrary } from "@renderer/lib/hooks/use-editor-library";
import { LOGO_NAME_MAX_LENGTH } from "@shared/types/projection";
import { logoModeOf } from "@shared/types/settings";
import type { SceneBackground } from "@shared/types/scene-style";

/**
 * LOGO's «name over a background» mode (owner, 2026-11-05): the church's name
 * and the background — rows of the «Logo» group, shown only in that mode —, and
 * in either mode the preview of what LOGO shows, drawn by the projector's own
 * `OutputView` from the same `logoLook` the projector gets. Saved as it
 * changes, like everything in Settings; the name on blur, Enter or leaving
 * Settings however it is left (`useCommitOnUnmount`). The background offers
 * the image library — the backgrounds the app ships included — through the
 * same `BackgroundFields` every style editor uses.
 */
export function LogoSceneFields({ preview = true }: { preview?: boolean }) {
  const t = useT();
  const path = useSettingsStore((s) => s.settings["logo.path"]);
  const mode = useSettingsStore((s) => s.settings["logo.mode"]);
  const name = useSettingsStore((s) => s.settings["logo.name"]);
  const background = useSettingsStore((s) => s.settings["logo.background"]);
  const update = useSettingsStore((s) => s.update);
  const [draft, setDraft] = useState(name ?? "");
  const images = useEditorLibrary(true, "image", "logo");
  // «Image» picked before an image: shown, never saved — an image background
  // with no image is one the settings validator refuses.
  const [pendingImage, setPendingImage] = useState<Extract<SceneBackground, { kind: "image" }> | null>(null);

  useEffect(() => setDraft(name ?? ""), [name]);

  function commitName() {
    const next = draft.trim() === "" ? null : draft.trim();
    if (next !== name) void update({ "logo.name": next });
  }
  useCommitOnUnmount(commitName);

  async function addImages() {
    const first = await images.add();
    if (!first) return;
    setPendingImage(null);
    void update({ "logo.background": { kind: "image", assetId: first.id, fit: pendingImage?.fit ?? "cover" } });
  }

  const output = useLogoPreview(pendingImage);

  return (
    <>
      {/* In «image» mode the name and background would not apply: not shown. */}
      {logoModeOf(mode, path) === "name" ? (
        <>
          <FieldRow description={t("settings.logoNameDesc")} label={t("settings.logoName")}>
            <Input
              aria-label={t("settings.logoName")}
              maxLength={LOGO_NAME_MAX_LENGTH}
              onBlur={commitName}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitName();
              }}
              placeholder={t("settings.logoNamePlaceholder")}
              size="sm"
              value={draft}
            />
          </FieldRow>
          <BackgroundFields
            addingImages={images.adding}
            imageAssets={images.assets}
            onAddImages={() => void addImages()}
            onChange={(next) => {
              const noImageYet = next.kind === "image" && next.assetId === 0;
              setPendingImage(noImageYet ? next : null);
              if (!noImageYet) void update({ "logo.background": next });
            }}
            value={pendingImage ?? background}
          />
        </>
      ) : null}
      {/* A row like the others, the picture where a field would be — or, where the caller draws it bigger
          (the welcome), not here. */}
      {preview ? (
        <FieldRow label={t("settings.logoPreview")}>
          <Box className="aspect-video w-64 overflow-hidden">
            <OutputView mode="preview" output={output} />
          </Box>
        </FieldRow>
      ) : null}
    </>
  );
}

