import { selectOutput, useProjectionStore } from "@renderer/stores/projection.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { INSTANT_TRANSITION, type ProjectionOutput } from "@shared/types/projection";
import { logoLook } from "@shared/types/settings";
import type { SceneBackground } from "@shared/types/scene-style";

/** What LOGO shows with the saved settings — or with an image background picked but not given its image
 *  yet (`pending`, never saved). The projector's own builder, fed these values: a preview cannot draw what
 *  the projector would not. */
export function useLogoPreview(pending: Extract<SceneBackground, { kind: "image" }> | null = null): ProjectionOutput {
  const path = useSettingsStore((s) => s.settings["logo.path"]);
  const mode = useSettingsStore((s) => s.settings["logo.mode"]);
  const name = useSettingsStore((s) => s.settings["logo.name"]);
  const background = useSettingsStore((s) => s.settings["logo.background"]);
  const look = logoLook({ "logo.path": path, "logo.mode": mode, "logo.name": name, "logo.background": pending ?? background });
  const logo = selectOutput({
    ...useProjectionStore.getState(),
    base: null,
    overlay: "logo",
    logoUrl: look.url,
    logoScene: look.scene,
  });
  return { ...logo, transition: INSTANT_TRANSITION };
}
