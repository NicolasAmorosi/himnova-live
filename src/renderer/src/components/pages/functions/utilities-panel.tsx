import { useMemo, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { Button, EmptyState, Icon, IconButton, ListRow, Tooltip } from "@renderer/components/ui";
import { PanelBody, PanelFooter } from "@renderer/components/shared/panel";
import { LibraryFilterBar } from "@renderer/components/shared/library-filter-bar";
import { viewNamed } from "@renderer/lib/named-list";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { NAMED_SORT_ORDERS, type NamedSortOrder } from "@shared/types/settings";
import { ModalBoundary } from "@renderer/components/shared/modal-boundary";
import { toast } from "@renderer/lib/toast";
import { useUtilityStore } from "@renderer/stores/utility.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { setUtilitySceneDrag } from "@renderer/lib/dnd";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { previewUtilityScene } from "@renderer/lib/actions/preview";
import { goLive } from "@renderer/lib/actions/playback";
import { ScenesModal } from "./ScenesModal";
import { SceneReadout } from "./scene-readout";
import { TOOL_ICON, TOOL_LABEL } from "./tool-display";

/**
 * The Utilities tab: the saved time scenes, and the transport of the one
 * timer that is armed.
 *
 * Follows the two-stage flow like every other list in the app — a click
 * previews, a double click goes live, and `goLive()` is the only path to the
 * projector. Starting the countdown is deliberately NOT part of selecting it:
 * a timer that started because somebody clicked a row is a timer nobody asked
 * for. GO LIVE starts it (see `goLiveWithUtilityScene`), and so does the
 * transport on the row of the column the scene is in — `UtilityTrackRow`,
 * under the PREVIEW monitor and inside the LIVE media panel. This tab holds no
 * transport of its own: controlling a scene belongs next to the picture of
 * that scene, not next to a list of names. All a row keeps is the running
 * value and a STOP, and only while its clock is actually going (see
 * `SceneReadout`).
 *
 * Creating and editing is a modal of its own rather than an inline form: a
 * scene has some thirty fields and this column is the narrowest in the app.
 *
 * A scene reaches the order of service the same two ways an asset does — the
 * footer button for the selected row, and dragging the row onto the schedule.
 * It belongs there because a time scene IS full-screen base content; an
 * overlay, which only modifies what is projected, deliberately will not be
 * (see `PLAN.md`).
 */
export function UtilitiesPanel() {
  const { locale, t } = useI18n();
  const [editorOpen, setEditorOpen] = useState(false);
  const scenes = useUtilityStore((s) => s.scenes);
  const sort = useSettingsStore((s) => s.settings["functions.scenesSort"]);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => viewNamed(scenes, sort, query, locale), [scenes, sort, query, locale]);
  const runSceneId = useUtilityStore((s) => s.run?.sceneId ?? null);
  const runStarted = useUtilityStore((s) => s.run?.started ?? false);
  const target = usePreviewStore((s) => s.target);
  const liveSceneId = useProjectionStore((s) => (s.base?.kind === "utility" ? s.base.sceneId : null));
  const addItem = useProgramStore((s) => s.addItem);

  const previewedId = target?.kind === "utility" ? target.sceneId : null;
  // Whose clock is actually going: the projected one, and the armed one once
  // it has been started. Decided here, per row, rather than inside the readout
  // — a resting wall clock is still a *running* clock, so mounting a ticking
  // component for every row would re-render the whole list once a second to
  // paint values nobody asked for.
  const startedSceneId = runStarted ? runSceneId : null;

  return (
    <>
      {/* Searched and ordered like Media's and Songs' lists (owner, 2026-11-05). */}
      <LibraryFilterBar<NamedSortOrder>
        onQueryChange={setQuery}
        onSortChange={(order) => void useSettingsStore.getState().update({ "functions.scenesSort": order })}
        query={query}
        searchLabel={t("resources.search")}
        sort={sort}
        sortHint={t("utilities.sortHint")}
        sortOptions={NAMED_SORT_ORDERS.map((order) => ({ label: t(`resources.sortOrders.${order}`), value: order }))}
      />
      <PanelBody className="gap-1.5 p-1.5">
        {scenes.length === 0 ? (
          // No button: «Escenas» is in the footer right below (2026-11-04 review).
          <EmptyState
            description={t("utilities.emptyHint")}
            icon="clock"
            title={t("utilities.empty")}
          />
        ) : shown.length === 0 ? (
          <EmptyState
            action={
              <Button onClick={() => setQuery("")} size="sm" variant="outline">
                {t("resources.clearSearch")}
              </Button>
            }
            description={t("resources.searchNoNameHint", { query })}
            icon="search"
            title={t("resources.searchNoResults")}
          />
        ) : (
          <ul aria-label={t("utilities.listLabel")} className="flex flex-col gap-0.5">
            {shown.map((scene) => (
              <ListRow
                active={liveSceneId === scene.id}
                key={scene.id}
                // No on-air rail here: the live scene is already the one
                // showing a running clock on its right (`SceneReadout`), and a
                // red bar beside it reads as an alert rather than as «this
                // is projected». See `ListRow`'s `rail`.
                rail={false}
                leading={
                  <Icon className="text-subtle" name={TOOL_ICON[scene.tool]} />
                }
                draggable
                onClick={() => previewUtilityScene(scene.id)}
                onDoubleClick={() => {
                  previewUtilityScene(scene.id);
                  void goLive();
                }}
                onDragStart={(e) => setUtilitySceneDrag(e, scene.id)}
                selected={previewedId === scene.id}
                trailing={
                  scene.id === liveSceneId || scene.id === startedSceneId ? (
                    <SceneReadout scene={scene} />
                  ) : scene.name === t(TOOL_LABEL[scene.tool]) ? null : (
                    // The kind, unless the name already says it: «Reloj · Reloj» (2026-11-05 review).
                    <span className="text-xs text-subtle">{t(TOOL_LABEL[scene.tool])}</span>
                  )
                }
              >
                {scene.name}
              </ListRow>
            ))}
          </ul>
        )}

      </PanelBody>

      {/* The same footer every resource tab has, so the two buttons that act
          on the selected row sit where the operator already looks for them —
          «Scenes…» on the left like the tab's own tools, «Add to
          schedule» pinned right like the media browser's. */}
      <PanelFooter>
        <Tooltip content={t("utilities.manageHint")} floating>
          <IconButton aria-label={t("utilities.manage")} onClick={() => setEditorOpen(true)} size="sm" variant="ghost">
            <Icon name="timer" />
          </IconButton>
        </Tooltip>
        <Tooltip className="ml-auto" content={t("resources.addToScheduleHint")} placement="top">
          <Button
            aria-label={t("resources.addToSchedule")}
            disabled={previewedId === null}
            onClick={() =>
              previewedId !== null && addItem({ kind: "utility", utilitySceneId: previewedId, title: null })
            }
            size="sm"
            variant="outline"
          >
            <Icon name="addToSchedule" />
            {t("resources.addToScheduleShort")}
          </Button>
        </Tooltip>
      </PanelFooter>

      {/* Its own boundary, like every other dialog: a throw while rendering
          thirty form fields must cost the operator this dialog, never the
          order of service behind it. */}
      <ModalBoundary
        onCrash={() => {
          setEditorOpen(false);
          toast.danger(t("app.modalCrashed"));
        }}
        open={editorOpen}
      >
        <ScenesModal onOpenChange={setEditorOpen} open={editorOpen} />
      </ModalBoundary>
    </>
  );
}
