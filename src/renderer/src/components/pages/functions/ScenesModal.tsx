import { useEffect, useState, type DragEvent } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { EditorScreen, EditorStage } from "@renderer/components/shared/editor-screen";
import { ProgramUsages } from "@renderer/components/shared/program-usages";
import {
  Button,
  EmptyState,
  Icon,
  Inspector,
  ListRow,
  Segmented,
  type MenuOption,
} from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { hideDragGhost, UTILITY_SCENE_MIME } from "@renderer/lib/dnd";
import { copyName } from "@renderer/lib/named-list";
import {
  deleteScene,
  duplicateScene,
  isSceneInSchedule,
  reorderScenes,
  saveScene,
  sceneUsages,
} from "@renderer/lib/actions/utility";
import { useUtilityStore } from "@renderer/stores/utility.store";
import { SCENE_NAME_MAX_LENGTH } from "@shared/scene-validators";
import { isCountdownTool } from "@shared/types/timer";
import type { MediaAsset } from "@shared/types/media";
import type { UtilityScene, UtilitySceneUsage } from "@shared/types/utility";
import { emptySceneDraft, isDraftSavable, toDraft, toUpsert, type SceneDraft } from "./scene-draft";
import { SceneForm } from "./scene-form";
import { ScenePreview } from "./scene-preview";
import { TOOL_ICON, TOOL_LABEL } from "./tool-display";

/** Which row the form is editing. `null` = a scene that does not exist yet. */
type Editing = { sceneId: number | null; draft: SceneDraft; baseline: SceneDraft };

/** What a confirmation is about to do once the operator says yes. A delete
 *  carries the saved programs it would break, read BEFORE the dialog opens: a
 *  list that arrives while the operator is already reading would change the
 *  question under them, and an empty one is the ordinary case rather than a
 *  loading state. */
type Pending =
  | { kind: "discard"; go: () => void }
  | { kind: "delete"; sceneId: number; usages: UtilitySceneUsage[]; inSchedule: boolean };

/**
 * The scene editor, full screen (`EditorScreen`): the scenes on the left, the
 * scene as the projector draws it in the middle, its knobs on the right and
 * its name in the bar.
 *
 * Saving is EXPLICIT, unlike Settings, and that is a decision rather than an
 * inconsistency: a scene can be on the projector while it is being edited, and
 * writing on every keystroke would spell a new end message out letter by
 * letter in front of the congregation. The 16:9 preview is what makes the
 * delay free — the operator sees every change immediately, just not the room.
 *
 * Once saved, `saveScene` patches the live scene in place (`setLiveScene`), so
 * the projector picks up the new look without a transition and without
 * restarting the count. That is the F2 gate.
 */
export function ScenesModal({ onOpenChange, open }: { onOpenChange: (open: boolean) => void; open: boolean }) {
  const t = useT();
  const scenes = useUtilityStore((s) => s.scenes);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [imageAssets, setImageAssets] = useState<readonly MediaAsset[]>([]);
  const [addingImages, setAddingImages] = useState(false);
  /** Whether the stage is drawing the scene as it rests or as it ends. A view
   *  of the editor, not part of the draft: it must never reach a row, and it
   *  survives switching scenes on purpose — an operator dressing the end state
   *  of several countdowns keeps looking at the end state. */
  const [previewAtEnd, setPreviewAtEnd] = useState(false);

  const dirty = editing !== null && JSON.stringify(editing.draft) !== JSON.stringify(editing.baseline);
  /** A scene that does not exist yet has nothing to differ FROM, so `dirty` is
   *  the wrong gate for it: creating one and saving it untouched is a perfectly
   *  ordinary thing to do, and comparing a fresh draft against its own copy
   *  left the button dead. `dirty` keeps its own meaning — it is what the
   *  discard guard and the bar's «Discard» ask. */
  const canSave = editing !== null && isDraftSavable(editing.draft) && (editing.sceneId === null || dirty);

  // The image library, for an image background's picker. Read on open rather
  // than kept in a store: it is one query, only this dialog wants it, and it
  // must reflect whatever the operator added since the last time they were
  // here.
  useEffect(() => {
    if (!open) return;
    void api.library
      .list("image")
      .then(setImageAssets)
      .catch((error: unknown) => console.warn("[scenes] could not list the image library", error));
  }, [open]);

  // Opening on the first scene is what makes the dialog useful on arrival; an
  // empty right-hand pane next to a full list reads as something broken.
  useEffect(() => {
    if (!open) {
      setEditing(null);
      setPending(null);
      return;
    }
    // With no scene left, the only thing to do here is make one (see the same
    // rule in `PlatesModal`).
    setEditing((current) => {
      if (current !== null) return current;
      const first = scenes[0];
      if (first) return { sceneId: first.id, draft: toDraft(first), baseline: toDraft(first) };
      const draft = emptySceneDraft(t("scenes.newName"));
      return { sceneId: null, draft, baseline: draft };
    });
  }, [open, scenes, t]);

  /** Every way of leaving the current form goes through here, so unsaved work
   *  can only ever be lost through the confirmation. */
  function leaveEditing(go: () => void) {
    if (dirty) {
      setPending({ kind: "discard", go });
      return;
    }
    go();
  }

  function select(scene: UtilityScene) {
    leaveEditing(() => setEditing({ sceneId: scene.id, draft: toDraft(scene), baseline: toDraft(scene) }));
  }

  function createNew() {
    leaveEditing(() => {
      const draft = emptySceneDraft(t("scenes.newName"));
      setEditing({ sceneId: null, draft, baseline: draft });
    });
  }

  async function handleSave(): Promise<boolean> {
    if (!canSave || !editing) return false;
    setSaving(true);
    try {
      const saved = await saveScene(toUpsert(editing.draft, editing.sceneId));
      if (!saved) return false;
      setEditing({ sceneId: saved.id, draft: toDraft(saved), baseline: toDraft(saved) });
      toast.success(t("scenes.saved", { name: saved.name }));
      return true;
    } finally {
      setSaving(false);
    }
  }

  /** Named off the store when it runs, not off this render: through «Save and
   *  leave» the scene was renamed after «Duplicate» was chosen. */
  async function handleDuplicate(sceneId: number) {
    const source = useUtilityStore.getState().scenes.find((scene) => scene.id === sceneId);
    if (!source) return;
    const name = copyName(source.name, SCENE_NAME_MAX_LENGTH, (base) => t("scenes.copyName", { name: base }));
    const copy = await duplicateScene(source.id, name);
    if (!copy) return;
    setEditing({ sceneId: copy.id, draft: toDraft(copy), baseline: toDraft(copy) });
    toast.success(t("scenes.saved", { name: copy.name }));
  }

  /** Opens the confirmation, having first asked which saved programs the
   *  scene appears in — that answer is what turns a plain "are you sure" into
   *  the forced delete, so it has to be in hand before the dialog is. */
  async function askToDelete(sceneId: number) {
    setPending({ kind: "delete", sceneId, usages: await sceneUsages(sceneId), inSchedule: isSceneInSchedule(sceneId) });
  }

  async function handleDelete(sceneId: number, force: boolean) {
    if (!(await deleteScene(sceneId, force))) return;
    // The list in the store has already been refreshed by `deleteScene`; this
    // reads the version this render closed over, which is why the next scene
    // is picked by position rather than by "whatever is first now".
    const index = scenes.findIndex((scene) => scene.id === sceneId);
    const next = scenes[index + 1] ?? scenes[index - 1] ?? null;
    setEditing(next ? { sceneId: next.id, draft: toDraft(next), baseline: toDraft(next) } : null);
  }

  async function handleAddImages() {
    const requestedFor = editing?.sceneId;
    setAddingImages(true);
    try {
      const paths = await api.files.pick("image", true);
      if (paths.length === 0) return;
      const added = await api.library.add(paths, "image");
      setImageAssets(await api.library.list("image"));
      // Selecting the first one it just added is the point of the button: the
      // operator picked a file in order to use it, not in order to then find
      // it in a dropdown.
      // Onto the form as it is NOW, not as it was before the file dialog and
      // the import: anything typed meanwhile used to be reverted.
      const first = added[0];
      if (first) {
        setEditing((current) =>
          current && current.sceneId === requestedFor
            ? {
                ...current,
                draft: {
                  ...current.draft,
                  style: { ...current.draft.style, background: { kind: "image", assetId: first.id, fit: "cover" } },
                },
              }
            : current,
        );
      }
    } catch (error) {
      console.warn("[scenes] could not add images", error);
      toast.danger(t("style.addImageError"));
    } finally {
      setAddingImages(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLLIElement>, targetId: number) {
    e.preventDefault();
    setDragOverId(null);
    const raw = e.dataTransfer.getData(UTILITY_SCENE_MIME);
    const draggedId = Number(raw);
    if (!raw || Number.isNaN(draggedId) || draggedId === targetId) return;
    const ids = scenes.map((scene) => scene.id).filter((id) => id !== draggedId);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    void reorderScenes([...ids.slice(0, at), draggedId, ...ids.slice(at)]);
  }

  const persisted = editing !== null && editing.sceneId !== null;
  const menuOptions: MenuOption<"duplicate" | "delete">[] = [
    { disabled: !persisted, label: t("common.duplicate"), value: "duplicate" },
    { disabled: !persisted, label: t("common.delete"), tone: "danger", value: "delete" },
  ];

  return (
    <>
      <EditorScreen
        inspector={
          editing ? (
            <Inspector key={editing.sceneId ?? "new"} label={t("scenes.title")}>
              <SceneForm
                onEndFocus={() => setPreviewAtEnd(true)}
                addingImages={addingImages}
                imageAssets={imageAssets}
                onAddImages={() => void handleAddImages()}
                onChange={(draft) => setEditing({ ...editing, draft })}
                value={editing.draft}
              />
            </Inspector>
          ) : null
        }
        onNew={{ label: t("scenes.new"), onClick: createNew }}
        list={
          <>
            <ul aria-label={t("scenes.listLabel")} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
              {scenes.map((scene) => (
                <ListRow
                  draggable
                  dropBefore={dragOverId === scene.id}
                  grip
                  key={scene.id}
                  leading={
                    // The kind as an icon only: written out beside the name it
                    // left the name «Cuent…» in a 256 px list.
                    <span className="flex" title={t(TOOL_LABEL[scene.tool])}>
                      <Icon className="text-subtle" name={TOOL_ICON[scene.tool]} />
                      <span className="sr-only">{t(TOOL_LABEL[scene.tool])}</span>
                    </span>
                  }
                  onClick={() => select(scene)}
                  onDragEnd={() => setDragOverId(null)}
                  onDragLeave={() => setDragOverId((current) => (current === scene.id ? null : current))}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverId((current) => (current === scene.id ? current : scene.id));
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    // The scene's ID, never its index: `reorderScenes` refreshes
                    // the list from main mid-drag, and an index would then point
                    // at a different row. Same rule as `PROGRAM_ROW_MIME`.
                    e.dataTransfer.setData(UTILITY_SCENE_MIME, String(scene.id));
                    hideDragGhost(e);
                  }}
                  onDrop={(e) => handleDrop(e, scene.id)}
                  selected={editing?.sceneId === scene.id}
                >
                  {scene.name}
                </ListRow>
              ))}
              {editing?.sceneId === null ? (
                <ListRow selected>{editing.draft.name}</ListRow>
              ) : null}
            </ul>
          </>
        }
        menu={{
          onSelect: (command) => {
            if (editing?.sceneId == null) return;
            const sceneId = editing.sceneId;
            // Through the guard like every other exit from the form: the copy
            // is made of the SAVED scene and replaces the open form.
            if (command === "duplicate") leaveEditing(() => void handleDuplicate(sceneId));
            else void askToDelete(sceneId);
          },
          options: menuOptions,
        }}
        name={
          editing
            ? {
                label: t("scenes.name"),
                maxLength: SCENE_NAME_MAX_LENGTH,
                onChange: (name) => setEditing({ ...editing, draft: { ...editing.draft, name } }),
                value: editing.draft.name,
              }
            : undefined
        }
        onClose={() => leaveEditing(() => onOpenChange(false))}
        open={open}
        save={
          editing
            ? {
                canSave,
                dirty,
                onDiscard: () => setEditing({ ...editing, draft: editing.baseline }),
                onSave: () => void handleSave(),
                saving,
              }
            : undefined
        }
        title={t("scenes.title")}
      >
        {editing === null ? (
          <div className="relative flex-1">
            <EmptyState
              action={
                <Button onClick={createNew} size="sm" variant="primary">
                  {t("scenes.new")}
                </Button>
              }
              description={t("scenes.emptyHint")}
              icon="clock"
              title={t("scenes.empty")}
            />
          </div>
        ) : (
          <EditorStage
            below={
              // Only where there is an end to look at. A clock and a stopwatch
              // never run out, so the switch would toggle nothing.
              isCountdownTool(editing.draft.tool) ? (
                // The editors' one sample control (2026-11-05): a segmented
                // choice of what the canvas draws, in Temas and Versículo too.
                <Segmented
                  label={t("scenes.sample")}
                  onChange={(sample) => setPreviewAtEnd(sample === "end")}
                  options={[
                    { label: t("scenes.sampleRunning"), value: "running" },
                    { label: t("scenes.sampleEnd"), value: "end" },
                  ]}
                  value={previewAtEnd ? "end" : "running"}
                />
              ) : undefined
            }
            warning={isDraftSavable(editing.draft) ? undefined : t("scenes.invalidHint")}
          >
            <ScenePreview atEnd={previewAtEnd} draft={editing.draft} />
          </EditorStage>
        )}
      </EditorScreen>

      <ConfirmModal
        confirmLabel={
          pending?.kind !== "delete"
            ? t("scenes.discard")
            : pending.usages.length > 0
              ? t("scenes.deleteAnyway")
              : t("common.delete")
        }
        danger={pending?.kind === "delete"}
        onSave={pending?.kind === "discard" && canSave ? handleSave : undefined}
        description={
          pending?.kind !== "delete" ? (
            t("scenes.discardBody")
          ) : (
            <div className="flex flex-col gap-3">
              {pending.usages.length > 0 ? (
                <ProgramUsages
                  intro={t("scenes.deleteInUseIntro")}
                  usages={pending.usages}
                  warning={t("scenes.deleteInUseWarning")}
                />
              ) : (
                <p>{t("scenes.deleteBody")}</p>
              )}
              {/* The open order of service is no saved program: said apart. */}
              {pending.inSchedule ? <p>{t("schedule.inOpenSchedule")}</p> : null}
            </div>
          )
        }
        onConfirm={async () => {
          if (!pending) return;
          // `force` is exactly "the operator has just read which programs this
          // breaks and said yes anyway" — never a flag the UI sets on its own.
          if (pending.kind === "delete") await handleDelete(pending.sceneId, pending.usages.length > 0);
          else pending.go();
        }}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        open={pending !== null}
        title={pending?.kind === "delete" ? t("scenes.deleteTitle") : t("scenes.discardTitle")}
      />
    </>
  );
}
