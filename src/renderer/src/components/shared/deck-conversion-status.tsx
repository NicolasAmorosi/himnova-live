import { Button, LoadingState } from "@renderer/components/ui";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { useDeckStore } from "@renderer/stores/deck.store";

/**
 * Every non-`ready` state of one deck's conversion, in the shape the preview
 * monitor's black stage and the slide-grid panel both need — same component,
 * same wording, so the two never disagree about what's happening (the
 * "monitors never lie to the operator" rule, applied to loading states too).
 *
 * No entry yet at all means the deck is either about to start or still
 * waiting behind other work in main's background queue — main only pushes
 * a `deck-progress` once a conversion actually starts running (see
 * `deck-service.ts`'s `pump`), so "no entry" and "queued" are the same case
 * here on purpose.
 */
export function DeckConversionStatus({
  assetId,
  onRetry,
  surface = "panel",
}: {
  assetId: number;
  /** Omit to hide the retry action entirely (the caller already shows its own). */
  onRetry?: () => void;
  surface?: "stage" | "panel";
}) {
  const t = useT();
  const entry = useDeckStore((s) => s.byAssetId[assetId]);
  const cancelConversion = useDeckStore((s) => s.cancelConversion);

  // Every state below puts its action in the same slot of the same
  // `LoadingState`, so without keys React reused one `<button>` for «Cancel»
  // and «Retry»: a conversion starting between the press and the release
  // turned a click on «Retry» into a cancel.
  const cancelAction = (
    <Button key="cancel" onClick={() => cancelConversion(assetId)} size="xs" variant="ghost">
      {t("deck.cancel")}
    </Button>
  );

  if (!entry || entry.status === "converting") {
    const done = entry?.progress.done ?? 0;
    const total = entry?.progress.total ?? 0;
    return (
      <LoadingState
        action={cancelAction}
        hint={t("deck.convertingHint")}
        icon="ppt"
        progress={total > 0 ? done / total : null}
        surface={surface}
        title={total > 0 ? t("deck.converting", { done, total }) : t("deck.preparing")}
      />
    );
  }

  // A deck that is `stale` with nothing rendered yet is a CANCELLED one: the
  // other route to `stale` (`markStale`, for a source file that changed or a
  // cache directory that was evicted) always keeps the slides it already had,
  // and the caller shows its own banner over them. Without this branch the
  // panel fell through to "The presentation has no slides" — blaming the
  // file for something the operator had just chosen to do, with no way back
  // other than selecting something else and returning.
  if (entry.status === "stale" && entry.deck === null) {
    return (
      <LoadingState
        action={
          onRetry ? (
            <Button key="retry" onClick={onRetry} size="xs" variant="outline">
              {t("deck.retry")}
            </Button>
          ) : undefined
        }
        hint={t("deck.canceledHint")}
        icon="ppt"
        surface={surface}
        title={t("deck.canceled")}
      />
    );
  }

  if (entry.status === "failed") {
    return (
      <LoadingState
        action={
          onRetry ? (
            <Button key="retry" onClick={onRetry} size="xs" variant="outline">
              {t("deck.retry")}
            </Button>
          ) : undefined
        }
        hint={entry.error ?? undefined}
        icon="alert"
        surface={surface}
        title={t("deck.failed")}
        tone="failed"
      />
    );
  }

  return null;
}
