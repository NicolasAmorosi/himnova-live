import { useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, EmptyState, Icon, IconButton, ListRow, Tooltip } from "@renderer/components/ui";
import { PanelBody, PanelFooter } from "@renderer/components/shared/panel";
import { ModalBoundary } from "@renderer/components/shared/modal-boundary";
import { PlateAirStatus } from "@renderer/components/shared/plate-air-status";
import { toast } from "@renderer/lib/toast";
import { setOverlayPlateDrag } from "@renderer/lib/dnd";
import { previewPlate } from "@renderer/lib/actions/preview";
import { goLive } from "@renderer/lib/actions/playback";
import { useOverlayStore } from "@renderer/stores/overlay.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { PlatesModal } from "./PlatesModal";
import { PLATE_KIND_ICON, PLATE_KIND_LABEL } from "./plate-display";

/**
 * The Overlays tab: the saved plates.
 *
 * The same two-stage flow as every other list: a click previews the plate —
 * the PREVIEW monitor draws it over what is live, and its row under the
 * monitor carries its own GO LIVE — and a double click puts it up. `goLive()`
 * is the only path either way (`goLiveWithPlate`), which puts it up without
 * replacing what is projected.
 *
 * A plate reaches the order of service the same two ways a time scene does:
 * the footer button for the selected row, and dragging the row onto the
 * schedule.
 */
export function OverlaysPanel() {
  const t = useT();
  const [editorOpen, setEditorOpen] = useState(false);
  const plates = useOverlayStore((s) => s.plates);
  const target = usePreviewStore((s) => s.target);
  const livePlates = useProjectionStore((s) => s.livePlates);
  const addItem = useProgramStore((s) => s.addItem);

  const previewedId = target?.kind === "plate" ? target.plateId : null;

  return (
    <>
      <PanelBody className="gap-1.5 p-1.5">
        {plates.length === 0 ? (
          // No button: «Placas» is in the footer right below (2026-11-04 review).
          <EmptyState
            description={t("overlays.emptyHint")}
            icon="overlay"
            title={t("overlays.empty")}
          />
        ) : (
          <ul aria-label={t("overlays.listLabel")} className="flex flex-col gap-0.5" title={t("overlays.selectHint")}>
            {plates.map((plate) => (
              <ListRow
                active={livePlates.some((live) => live.id === plate.id)}
                draggable
                key={plate.id}
                // No on-air rail: `PlateAirStatus` on the right already says
                // «On air» or «Covered», and the rail can't tell the two
                // apart. Same call as the Utilities list — see `ListRow`'s `rail`.
                rail={false}
                leading={
                  <Icon className="text-subtle" name={PLATE_KIND_ICON[plate.kind]} />
                }
                onClick={() => previewPlate(plate.id)}
                onDoubleClick={() => {
                  previewPlate(plate.id);
                  void goLive();
                }}
                onDragStart={(e) => setOverlayPlateDrag(e, plate.id)}
                selected={previewedId === plate.id}
                trailing={
                  livePlates.some((live) => live.id === plate.id) ? (
                    <PlateAirStatus plateId={plate.id} />
                  ) : plate.name === t(PLATE_KIND_LABEL[plate.kind]) ? null : (
                    <span className="text-xs text-subtle">{t(PLATE_KIND_LABEL[plate.kind])}</span>
                  )
                }
              >
                {plate.name}
              </ListRow>
            ))}
          </ul>
        )}
      </PanelBody>

      {/* The footer every resource tab has: the editor on the left as an icon,
          «Add to schedule» pinned right with its word. */}
      <PanelFooter>
        <Tooltip content={t("overlays.manageHint")} floating>
          <IconButton aria-label={t("overlays.manage")} onClick={() => setEditorOpen(true)} size="sm" variant="ghost">
            <Icon name="overlay" />
          </IconButton>
        </Tooltip>
        <Tooltip className="ml-auto" content={t("resources.addToScheduleHint")} placement="top">
          <Button
            aria-label={t("resources.addToSchedule")}
            disabled={previewedId === null}
            onClick={() => previewedId !== null && addItem({ kind: "plate", overlayPlateId: previewedId, title: null })}
            size="sm"
            variant="outline"
          >
            <Icon name="addToSchedule" />
            {t("resources.addToScheduleShort")}
          </Button>
        </Tooltip>
      </PanelFooter>

      <ModalBoundary
        onCrash={() => {
          setEditorOpen(false);
          toast.danger(t("app.modalCrashed"));
        }}
        open={editorOpen}
      >
        <PlatesModal onOpenChange={setEditorOpen} open={editorOpen} />
      </ModalBoundary>
    </>
  );
}
