import { Badge, Icon } from "@renderer/components/ui";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { useSlideModel } from "@renderer/lib/slide-models";

/** Whether the slide at this model url was drawn without a part of its file
 *  that won't parse (`SlideModel.damaged`). Shares the window's model cache
 *  with the `ModelSlide` drawing it, so asking costs no second fetch. */
function useDamaged(url: string | null): boolean {
  const shown = useSlideModel(url);
  return url !== null && shown?.url === url && shown.model.damaged === true;
}

/**
 * A damaged slide, said in the control window only — on its tile here, beside
 * the monitor showing it in `DamagedSlideBadge` — and never on the projector,
 * which draws what could be read and nothing else: the congregation can't see
 * a warning sign. Over a tile's media area (`ThumbTile`'s `overlay`).
 */
export function DamagedSlideMark({ url }: { url: string | null }) {
  const t = useT();
  const damaged = useDamaged(url);
  if (!damaged) return null;
  return (
    <span className="absolute bottom-0.5 left-0.5" title={t("deck.damagedSlideHint")}>
      <Badge className="px-1" variant="neutral">
        <Icon className="size-3 text-warning-ink" name="alert" />
        {/* Part of the tile's name, so a screen reader says it too. */}
        <span className="sr-only">{t("deck.damagedSlide")}</span>
      </Badge>
    </span>
  );
}

/** The same warning in a monitor column's header, for the slide its monitor
 *  shows now. */
export function DamagedSlideBadge({ url }: { url: string | null }) {
  const t = useT();
  const damaged = useDamaged(url);
  if (!damaged) return null;
  return (
    <Badge title={t("deck.damagedSlideHint")} variant="neutral">
      <Icon className="size-3 text-warning-ink" name="alert" />
      <span className="truncate">{t("deck.damagedSlide")}</span>
    </Badge>
  );
}
