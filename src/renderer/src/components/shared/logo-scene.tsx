import { sceneTextCss } from "./scene-text";
import { StageImage } from "./stage-image";
import { cssSceneBackground, DEFAULT_SHADOW_STRENGTH, type SceneTextStyle } from "@shared/types/scene-style";
import type { ProjectionOutput } from "@shared/types/projection";

type LogoOutput = Extract<ProjectionOutput, { kind: "logo" }>;

/** The church's name: one fixed look, legible over any background. */
const NAME_STYLE: SceneTextStyle = { sizeCqw: 5.5, color: "#ffffff", weight: 600, shadow: true, shadowStrength: DEFAULT_SHADOW_STRENGTH };

/**
 * LOGO when the church has no logo image (owner, 2026-11-05): its background
 * and its name, centred. Drawn from the output alone, like every scene.
 */
export function LogoScene({ onImageError, output }: { onImageError?: ((url: string) => void) | undefined; output: LogoOutput }) {
  const { backgroundUrl, scene } = output;
  const background = cssSceneBackground(scene.background);
  const image = scene.background.kind === "image" ? scene.background : null;
  return (
    <>
      {background ? <div className="absolute inset-0" style={{ background }} /> : null}
      {image && backgroundUrl ? (
        <StageImage
          className="absolute inset-0 size-full"
          onError={() => onImageError?.(backgroundUrl)}
          src={backgroundUrl}
          style={{ objectFit: image.fit }}
        />
      ) : null}
      {scene.name ? (
        <div className="absolute inset-0 flex items-center justify-center px-[8cqw] text-center">
          <p data-logo-name style={{ ...sceneTextCss(NAME_STYLE), lineHeight: 1.2 }}>
            {scene.name}
          </p>
        </div>
      ) : null}
    </>
  );
}
