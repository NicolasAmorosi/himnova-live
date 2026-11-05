import { useT } from "@renderer/lib/i18n/i18n-provider";
import { selectOutputMemo, useProjectionStore } from "@renderer/stores/projection.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useMediaAsset } from "@renderer/lib/hooks/use-media-asset";
import type { BaseContent } from "@shared/types/projection";

function liveAssetId(base: BaseContent | null): number | null {
  if (!base) return null;
  if (base.kind === "deck" || base.kind === "video" || base.kind === "image") return base.assetId;
  return null;
}

/**
 * The title shown next to "LIVE" in the third column's header — the same
 * kind of heading the centre column shows for the preview, but resolved
 * against `base` (what's actually on the projector) instead of the preview
 * cursor. Schedule items already carry their own title/name; content sent
 * live straight from the library resolves it from the asset instead.
 */
export function useLiveHeading(): string | null {
  const base = useProjectionStore((s) => s.base);
  const activeIndex = useProgramStore((s) => s.activeIndex);
  const items = useProgramStore((s) => s.items);
  const activeItem = activeIndex !== null ? items[activeIndex] : undefined;
  const asset = useMediaAsset(liveAssetId(base));

  if (!base) return null;

  switch (base.kind) {
    case "deck":
      return (activeItem?.kind === "ppt" ? activeItem.title : null) ?? asset?.name ?? null;
    case "video":
    case "image":
      return asset?.name ?? null;
    case "bible":
      return base.reference;
    case "utility":
      // The scene's own name, never its title/message: the header labels
      // WHICH thing is live, and two scenes can perfectly well share the
      // words painted on the screen.
      return base.scene.name;
    case "song":
      return base.song.title;
  }
}

/** The LIVE header's status word (BLACK, LOGO, projector closed) — empty when
 *  content is going out. Shared by the LIVE column and a full-screen editor's
 *  on-air indicator, which must say the same thing. */
export function useLiveStatus(): string {
  const t = useT();
  const presentationOpen = useProjectionStore((s) => s.presentationOpen);
  // Read off the SAME value the monitor renders, never a second reading of
  // `overlay`/`base`: this badge used to re-derive the precedence by hand and
  // got it wrong for the one case the two disagree on. With nothing selected
  // and no overlay, `selectOutputWithoutUnderlay` falls back to the logo — so
  // the stage showed the logo while the badge beside it said "No signal".
  // A badge that contradicts the stage it labels is the monitor lying to the
  // operator, which is the one thing this column may never do.
  // `.kind` and not the whole output: a string is comparable by `Object.is`,
  // so this subscription only wakes the column when the badge would actually
  // change — not on every slide advance. `selectOutputMemo` makes the call
  // inside the selector free.
  const outputKind = useProjectionStore((s) => selectOutputMemo(s).kind);

  if (!presentationOpen) return t("live.disconnected");
  if (outputKind === "black") return t("status.black");
  if (outputKind === "logo") return t("status.logo");
  return "";
}
