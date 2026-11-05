import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Box, FieldGroup, FieldRow, Input } from "@renderer/components/ui";
import { OutputView } from "@renderer/components/shared/output-view";
import { BackgroundFields } from "@renderer/components/shared/style-fields";
import { selectOutput, useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { INSTANT_TRANSITION, LOGO_NAME_MAX_LENGTH, type ProjectionOutput } from "@shared/types/projection";
import type { MediaAsset } from "@shared/types/media";
import type { SceneBackground } from "@shared/types/scene-style";

/**
 * LOGO without a logo image (owner, 2026-11-05): the church's name over a
 * background, with a preview drawn by the projector's own `OutputView`.
 * Saved as it changes, like everything in Settings; the name on blur or Enter.
 */
export function LogoSceneFields() {
  const t = useT();
  const name = useSettingsStore((s) => s.settings["logo.name"]);
  const background = useSettingsStore((s) => s.settings["logo.background"]);
  const update = useSettingsStore((s) => s.update);
  const [draft, setDraft] = useState(name ?? "");
  const [imageAssets, setImageAssets] = useState<readonly MediaAsset[]>([]);
  const [addingImages, setAddingImages] = useState(false);
  // «Image» picked before an image: shown, never saved — an image background
  // with no image is one the settings validator refuses.
  const [pendingImage, setPendingImage] = useState<Extract<SceneBackground, { kind: "image" }> | null>(null);

  useEffect(() => setDraft(name ?? ""), [name]);
  useEffect(() => {
    void api.library
      .list("image")
      .then(setImageAssets)
      .catch((error: unknown) => console.warn("[logo] could not list the image library", error));
  }, []);

  function commitName() {
    const next = draft.trim() === "" ? null : draft.trim();
    if (next !== name) void update({ "logo.name": next });
  }

  async function addImages() {
    setAddingImages(true);
    try {
      const paths = await api.files.pick("image", true);
      if (paths.length === 0) return;
      const [first] = await api.library.add(paths, "image");
      setImageAssets(await api.library.list("image"));
      if (first) {
        setPendingImage(null);
        void update({ "logo.background": { kind: "image", assetId: first.id, fit: pendingImage?.fit ?? "cover" } });
      }
    } catch (error) {
      console.warn("[logo] could not add images", error);
      toast.danger(t("style.addImageError"));
    } finally {
      setAddingImages(false);
    }
  }

  // The projector's own builder, fed this group's values: the preview cannot
  // draw what the projector would not.
  const logo = selectOutput({
    ...useProjectionStore.getState(),
    base: null,
    overlay: "logo",
    logoUrl: null,
    logoScene: { name, background: pendingImage ?? background },
  });
  const output: ProjectionOutput = { ...logo, transition: INSTANT_TRANSITION };

  return (
    <FieldGroup title={t("settings.groups.logoScene")}>
      <FieldRow description={t("settings.logoNameDesc")} label={t("settings.logoName")}>
        <Input
          aria-label={t("settings.logoName")}
          className="w-64"
          maxLength={LOGO_NAME_MAX_LENGTH}
          onBlur={commitName}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitName();
          }}
          size="sm"
          value={draft}
        />
      </FieldRow>
      <BackgroundFields
        addingImages={addingImages}
        imageAssets={imageAssets}
        onAddImages={() => void addImages()}
        onChange={(next) => {
          const noImageYet = next.kind === "image" && next.assetId === 0;
          setPendingImage(noImageYet ? next : null);
          if (!noImageYet) void update({ "logo.background": next });
        }}
        value={pendingImage ?? background}
      />
      <div className="py-3">
        <Box className="aspect-video w-full max-w-sm overflow-hidden">
          <OutputView mode="preview" output={output} />
        </Box>
      </div>
    </FieldGroup>
  );
}
