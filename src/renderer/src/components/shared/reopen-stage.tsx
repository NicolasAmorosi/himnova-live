import { api } from "@renderer/lib/api";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button } from "@renderer/components/ui";
import { useStageStore } from "@renderer/stores/stage.store";

/** The stage window the operator closed stays closed for the session, like the projector (owner, 2026-11-15): this
 *  brings it back. In the stage panel's head, whose press would also fold the card, and in Settings ▸ Screens (a copy
 *  of the projector has no panel). */
export function ReopenStage() {
  const t = useT();
  const closed = useStageStore((s) => s.closed);
  if (!closed) return null;
  return (
    <Button
      className="shrink-0"
      onClick={(e) => {
        e.stopPropagation();
        void api.stage.reopen();
      }}
      size="xs"
      variant="outline"
    >
      {t("stagePanel.reopen")}
    </Button>
  );
}
