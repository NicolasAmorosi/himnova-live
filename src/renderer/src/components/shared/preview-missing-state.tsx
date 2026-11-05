import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, EmptyState, Icon } from "@renderer/components/ui";
import { relocateAsset } from "@renderer/lib/actions/relocate-asset";

/**
 * Shown wherever the previewed item's source file is gone from disk — a
 * single media asset or a slide deck.
 *
 * It carries the repair, not just the diagnosis: the file has almost always
 * been moved rather than deleted (a renamed folder, a different USB stick),
 * and relocating keeps the row's id, so the programs that use it and the
 * order of service being assembled stay intact. Re-adding the file from
 * Resources would create a second asset and leave all of that pointing at the
 * broken one.
 */
export function PreviewMissingState({ assetId }: { assetId: number }) {
  const t = useT();
  return (
    <EmptyState
      action={
        <Button className="mt-1" onClick={() => void relocateAsset(assetId)} size="sm" variant="outline">
          <Icon name="folder" /> {t("library.relocate")}
        </Button>
      }
      description={t("preview.missingHint")}
      icon="alert"
      title={t("preview.missing")}
      tone="danger"
    />
  );
}
