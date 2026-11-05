import { useEffect, useState, type DragEvent } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { EditorScreen } from "@renderer/components/shared/editor-screen";
import { ProgramUsages } from "@renderer/components/shared/program-usages";
import { Button, EmptyState, Icon, Inspector, ListRow, type MenuOption } from "@renderer/components/ui";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import { hideDragGhost, OVERLAY_PLATE_MIME } from "@renderer/lib/dnd";
import {
  deletePlate,
  duplicatePlate,
  isPlateUp,
  plateUsages,
  reorderPlates,
  savePlate,
} from "@renderer/lib/actions/overlays";
import { useOverlayStore } from "@renderer/stores/overlay.store";
import { PLATE_NAME_MAX_LENGTH } from "@shared/overlay-validators";
import type { MediaAsset } from "@shared/types/media";
import type { Plate, PlateUsage } from "@shared/types/overlay";
import { emptyPlateDraft, isPlateDraftSavable, toPlateDraft, toPlateUpsert, type PlateDraft } from "./plate-draft";
import { PlateForm } from "./plate-form";
import { PlatePreview } from "./plate-preview";
import { PLATE_KIND_ICON, PLATE_KIND_LABEL } from "./plate-display";

type Editing = { plateId: number | null; draft: PlateDraft; baseline: PlateDraft };

type Pending =
  | { kind: "discard"; go: () => void }
  | { kind: "delete"; plateId: number; up: boolean; usages: PlateUsage[] };

/**
 * The plate editor — the same full-screen layout and the same EXPLICIT save as
 * the «Scenes» editor, for the same reason: a plate can be on the air while it is
 * edited, and saving per keystroke would spell a name out letter by letter in
 * front of the congregation. Once saved, a plate that is up is re-dressed in
 * place (`setLivePlate`), without its entrance playing again.
 */
export function PlatesModal({ onOpenChange, open }: { onOpenChange: (open: boolean) => void; open: boolean }) {
  const t = useT();
  const plates = useOverlayStore((s) => s.plates);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [imageAssets, setImageAssets] = useState<readonly MediaAsset[]>([]);
  const [addingImages, setAddingImages] = useState(false);

  const dirty = editing !== null && JSON.stringify(editing.draft) !== JSON.stringify(editing.baseline);
  const savable = editing !== null && isPlateDraftSavable(editing.draft);
  // A plate that does not exist yet has nothing to differ from — the lesson
  // of the scene editor's dead «Save» (HANDOFF B1).
  const canSave = savable && (editing.plateId === null || dirty);

  useEffect(() => {
    if (!open) return;
    void api.library
      .list("image")
      .then(setImageAssets)
      .catch((error: unknown) => console.warn("[plates] could not list the image library", error));
  }, [open]);

  useEffect(() => {
    if (!open) {
      setEditing(null);
      setPending(null);
      return;
    }
    // With no plate yet, the only thing to do here is make one — and the
    // empty Overlays panel opens this through a button that says «New
    // overlay». Landing on an empty pane meant pressing it a second time.
    setEditing((current) => {
      if (current !== null) return current;
      const first = plates[0];
      if (first) return { plateId: first.id, draft: toPlateDraft(first), baseline: toPlateDraft(first) };
      const draft = emptyPlateDraft(t("plates.newName"));
      return { plateId: null, draft, baseline: draft };
    });
  }, [open, plates, t]);

  function leaveEditing(go: () => void) {
    if (dirty) setPending({ kind: "discard", go });
    else go();
  }

  function select(plate: Plate) {
    leaveEditing(() =>
      setEditing({ plateId: plate.id, draft: toPlateDraft(plate), baseline: toPlateDraft(plate) }),
    );
  }

  function createNew() {
    leaveEditing(() => {
      const draft = emptyPlateDraft(t("plates.newName"));
      setEditing({ plateId: null, draft, baseline: draft });
    });
  }

  async function handleSave() {
    if (!canSave || !editing) return;
    setSaving(true);
    try {
      const saved = await savePlate(toPlateUpsert(editing.draft, editing.plateId));
      if (!saved) return;
      setEditing({ plateId: saved.id, draft: toPlateDraft(saved), baseline: toPlateDraft(saved) });
      toast.success(t("plates.saved", { name: saved.name }));
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicate() {
    if (editing?.plateId == null) return;
    const source = plates.find((plate) => plate.id === editing.plateId);
    if (!source) return;
    const copy = await duplicatePlate(source.id, t("plates.copyName", { name: source.name }));
    if (copy) setEditing({ plateId: copy.id, draft: toPlateDraft(copy), baseline: toPlateDraft(copy) });
  }

  /** The usages are read BEFORE the dialog opens, like `ScenesModal`'s: they
   *  are what turns a plain "are you sure" into the forced delete. */
  async function askToDelete(plateId: number) {
    setPending({ kind: "delete", plateId, up: isPlateUp(plateId), usages: await plateUsages(plateId) });
  }

  async function handleDelete(plateId: number, force: boolean) {
    if (!(await deletePlate(plateId, force))) return;
    const index = plates.findIndex((plate) => plate.id === plateId);
    const next = plates[index + 1] ?? plates[index - 1] ?? null;
    setEditing(next ? { plateId: next.id, draft: toPlateDraft(next), baseline: toPlateDraft(next) } : null);
  }

  async function handleAddImages() {
    const requestedFor = editing?.plateId;
    setAddingImages(true);
    try {
      const paths = await api.files.pick("image", true);
      if (paths.length === 0) return;
      const added = await api.library.add(paths, "image");
      setImageAssets(await api.library.list("image"));
      // Onto the form as it is NOW (see the same line in `ScenesModal`).
      const first = added[0];
      if (first) {
        setEditing((current) =>
          current && current.plateId === requestedFor
            ? { ...current, draft: { ...current.draft, imageAssetId: first.id } }
            : current,
        );
      }
    } catch (error) {
      console.warn("[plates] could not add images", error);
      toast.danger(t("style.addImageError"));
    } finally {
      setAddingImages(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLLIElement>, targetId: number) {
    e.preventDefault();
    setDragOverId(null);
    const raw = e.dataTransfer.getData(OVERLAY_PLATE_MIME);
    const draggedId = Number(raw);
    if (!raw || Number.isNaN(draggedId) || draggedId === targetId) return;
    const ids = plates.map((plate) => plate.id).filter((id) => id !== draggedId);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    void reorderPlates([...ids.slice(0, at), draggedId, ...ids.slice(at)]);
  }

  const persisted = editing !== null && editing.plateId !== null;
  const menuOptions: MenuOption<"duplicate" | "delete">[] = [
    { disabled: !persisted, label: t("common.duplicate"), value: "duplicate" },
    { disabled: !persisted, label: t("common.delete"), tone: "danger", value: "delete" },
  ];

  return (
    <>
      <EditorScreen
        inspector={
          editing ? (
            // Keyed by plate, so opening another one starts at its top instead
            // of at the scroll position the previous one was left at.
            <Inspector key={editing.plateId ?? "new"} label={t("plates.title")}>
              <PlateForm
                addingImages={addingImages}
                imageAssets={imageAssets}
                onAddImages={() => void handleAddImages()}
                onChange={(draft) => setEditing({ ...editing, draft })}
                value={editing.draft}
              />
            </Inspector>
          ) : null
        }
        onNew={{ label: t("plates.new"), onClick: createNew }}
        list={
          <>
            <ul aria-label={t("plates.listLabel")} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
              {plates.map((plate) => (
                <ListRow
                  draggable
                  dropBefore={dragOverId === plate.id}
                  grip
                  key={plate.id}
                  leading={
                    // The kind as an icon only: written out beside the name it
                    // left the name «Cuent…» in a 256 px list.
                    <span className="flex" title={t(PLATE_KIND_LABEL[plate.kind])}>
                      <Icon className="text-subtle" name={PLATE_KIND_ICON[plate.kind]} />
                      <span className="sr-only">{t(PLATE_KIND_LABEL[plate.kind])}</span>
                    </span>
                  }
                  onClick={() => select(plate)}
                  onDragEnd={() => setDragOverId(null)}
                  onDragLeave={() => setDragOverId((current) => (current === plate.id ? null : current))}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverId((current) => (current === plate.id ? current : plate.id));
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData(OVERLAY_PLATE_MIME, String(plate.id));
                    hideDragGhost(e);
                  }}
                  onDrop={(e) => handleDrop(e, plate.id)}
                  selected={editing?.plateId === plate.id}
                >
                  {plate.name}
                </ListRow>
              ))}
              {editing?.plateId === null ? (
                <ListRow selected>{editing.draft.name}</ListRow>
              ) : null}
            </ul>
          </>
        }
        menu={{
          onSelect: (command) => {
            if (editing?.plateId == null) return;
            // Through the guard like every other exit from the form: the copy
            // is made of the SAVED plate and replaces the open form.
            if (command === "duplicate") leaveEditing(() => void handleDuplicate());
            else void askToDelete(editing.plateId);
          },
          options: menuOptions,
        }}
        name={
          editing
            ? {
                label: t("plates.name"),
                maxLength: PLATE_NAME_MAX_LENGTH,
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
        title={t("plates.title")}
      >
        {editing === null ? (
          <div className="relative flex-1">
            <EmptyState
              action={
                <Button onClick={createNew} size="sm" variant="primary">
                  {t("plates.new")}
                </Button>
              }
              description={t("plates.emptyHint")}
              icon="overlay"
              title={t("plates.empty")}
            />
          </div>
        ) : (
          <PlatePreview
            draft={editing.draft}
            id={editing.plateId}
            warning={savable ? undefined : t("plates.invalidHint")}
          />
        )}
      </EditorScreen>

      <ConfirmModal
        confirmLabel={
          pending?.kind !== "delete"
            ? t("plates.discard")
            : pending.usages.length > 0
              ? t("plates.deleteAnyway")
              : t("common.delete")
        }
        danger={pending?.kind === "delete"}
        description={
          pending?.kind !== "delete" ? (
            t("plates.discardBody")
          ) : pending.usages.length > 0 ? (
            <ProgramUsages
              intro={t("plates.deleteInUseIntro")}
              usages={pending.usages}
              warning={pending.up ? t("plates.deleteInUseUpWarning") : t("plates.deleteInUseWarning")}
            />
          ) : pending.up ? (
            t("plates.deleteUpBody")
          ) : (
            t("plates.deleteBody")
          )
        }
        onConfirm={async () => {
          if (!pending) return;
          // `force` only ever means "the operator read the list and said yes".
          if (pending.kind === "delete") await handleDelete(pending.plateId, pending.usages.length > 0);
          else pending.go();
        }}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        open={pending !== null}
        title={pending?.kind === "delete" ? t("plates.deleteTitle") : t("plates.discardTitle")}
      />
    </>
  );
}
