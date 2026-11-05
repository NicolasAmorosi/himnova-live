import { useState, type DragEvent, type KeyboardEvent } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import {
  Button,
  EmptyState,
  FieldGroup,
  FieldRow,
  Icon,
  IconButton,
  Input,
  Tooltip,
} from "@renderer/components/ui";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { ProgramUsages } from "@renderer/components/shared/program-usages";
import { api } from "@renderer/lib/api";
import { cn } from "@renderer/lib/utils";
import { BIBLE_VERSION_MIME, hideDragGhost } from "@renderer/lib/dnd";
import { toast } from "@renderer/lib/toast";
import { useBibleStore } from "@renderer/stores/bible.store";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { BIBLE_VERSION_NAME_MAX_LENGTH, isBibleVersionName } from "@shared/types/bible";
import type { BibleVersionDTO, BibleVersionUsage } from "@shared/types/bible";

/** What a delete confirmation is about to do. The usages are read BEFORE the
 *  dialog opens — a list that arrived while the operator was already reading
 *  would change the question under them, and an empty one is the ordinary
 *  case rather than a loading state. Same shape as `ScenesModal`'s. */
type Pending = { version: BibleVersionDTO; usages: BibleVersionUsage[] };

/**
 * «Bible»: the installed versions, and nothing else — import, rename, choose
 * a default, delete.
 *
 * How a verse LOOKS is not here: it is the Bible tab's verse style editor
 * (`pages/resources/VerseStyleModal.tsx`), a single `settings` key with a live
 * 16:9 preview that wants the whole screen, while this is a table of bibles.
 *
 * Each of the four actions exists for its own reason:
 *
 * - **rename** because the name is what the projector prints under a verse
 *   when the style asks for the version, and an imported module arrives named
 *   after its file (`spaRV1909_vpl`). «RV1909» is a decision only the operator
 *   can make.
 * - **default** because the Bible tab used to open on `versions[0]`, an
 *   insertion order nobody chose.
 * - **delete** because until now a version could only ever be added — and the
 *   bundled RV1909 could not even be that, since the seed put it back on every
 *   launch (see `seedBuiltinBibles` for the flag that now makes «delete» mean
 *   delete).
 *
 * The rows are `FieldRow`s, not the denser `ListRow` the resource panels use:
 * a list inside Settings is still Settings, and a 32 px row wedged between 60 px
 * ones is what made this screen read as a different app. `FieldRow` also owns
 * the rename state cleanly — the name and the `<Input>` that replaces it are
 * the same slot, so the row does not change height while it is being edited.
 *
 * The store is reloaded after every write rather than patched: `loadVersions`
 * also re-selects the version the Bible tab is browsing, which a delete or a
 * new default has to move.
 *
 * Two things about the row are deliberate and easy to undo by accident:
 *
 * - **The star is the LEADING control, and it is the only mark of «default»
 *   there is.** It replaced both a decorative bible icon and a pair
 *   of badges, and it is the same star `ProgramRow` uses — a filled
 *   `accent-ink` glyph, not a badge and not a filled button. One shape for
 *   "this is the one I keep coming back to" across the app. Clicking the one
 *   that already is the default does nothing on purpose: there is always
 *   exactly one, because a dangling default sends the Bible tab back to
 *   `versions[0]`, an insertion order nobody chose.
 * - **The order is the operator's, and it is not cosmetic.** The list is the
 *   same array the version picker offers (`bible.store`), so dragging a row
 *   here is what puts RV1909 first there. The drag is handle-only — the row
 *   carries a rename field and three buttons, and a row that starts moving
 *   when you press its name is a row you cannot use.
 */
export function BibleSection() {
  const t = useT();
  const versions = useBibleStore((s) => s.versions);
  const loadVersions = useBibleStore((s) => s.loadVersions);
  const defaultVersionId = useSettingsStore((s) => s.settings["bible.defaultVersionId"]);
  const update = useSettingsStore((s) => s.update);

  const [importing, setImporting] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  // Which row a drag is hovering, by version id — `null` means "no drop
  // indicator", never "drop at the end": this list is short enough to always
  // have a row under the cursor, so a drop outside one is not a move.
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const reorderVersions = useBibleStore((s) => s.reorderVersions);

  // One version cannot be arranged, and a rename in progress owns the row's
  // whole width — dragging either is a gesture with no meaning.
  const reorderEnabled = versions.length > 1 && renamingId === null;

  /**
   * Importing is seconds of work with nothing on screen to say so: measured at
   * ~590 ms for the RV1909 bundle (31 102 verses), and it is all synchronous
   * work in main — 457 ms of INSERTs, 47 ms rebuilding the FTS5 index, 11 ms
   * of JSON. That is long enough for a second click to start a second import,
   * and long enough that silence reads as a broken button.
   *
   * `null` means the operator dismissed the file dialog, which is not an
   * outcome worth a toast. A rejection is a real failure — an unrecognised
   * format, a module with no verses in it — and has to be said out loud with
   * main's OWN message, since that message is the only thing that says which
   * of the two it was.
   */
  async function importVersion() {
    setImporting(true);
    try {
      const version = await api.bible.import();
      if (version === null) return;
      await loadVersions();
      toast.success(t("bible.importSucceeded", { name: version.name, verses: version.verseCount }));
    } catch (error) {
      console.error("[bible] import failed", error);
      toast.danger(describeError(error, t("bible.importFailed")));
    } finally {
      setImporting(false);
    }
  }

  function startRename(version: BibleVersionDTO) {
    setRenamingId(version.id);
    setDraftName(version.name);
  }

  async function commitRename(version: BibleVersionDTO) {
    const name = draftName.trim();
    setRenamingId(null);
    if (name === version.name || !isBibleVersionName(name)) return;
    setBusyId(version.id);
    try {
      const renamed = await api.bible.rename(version.id, name);
      await loadVersions();
      toast.success(t("settings.bible.renameDone", { name: renamed.name }));
    } catch (error) {
      console.error("[bible] rename failed", error);
      toast.danger(t("settings.bible.renameFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function setDefault(version: BibleVersionDTO) {
    await update({ "bible.defaultVersionId": version.id });
    toast.success(t("settings.bible.setDefaultDone", { name: version.name }));
  }

  /** Opens the confirmation having first asked which saved programs cite the
   *  version — that answer is what turns a plain "are you sure" into the
   *  forced delete, so it has to be in hand before the dialog is. */
  async function askToDelete(version: BibleVersionDTO) {
    setBusyId(version.id);
    try {
      // A lookup that fails must not make the version undeletable: the dialog
      // opens with no list, as the scene and plate equivalents already do.
      const usages = await api.bible.usages(version.id).catch((error: unknown) => {
        console.warn("[bible] usage lookup failed", error);
        return [];
      });
      setPending({ version, usages });
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete({ usages, version }: Pending) {
    try {
      // `force` is exactly "the operator has just read which programs this
      // affects and said yes anyway" — never a flag the UI sets on its own.
      await api.bible.delete(version.id, usages.length > 0);
      await loadVersions();
      toast.success(t("settings.bible.deleteDone", { name: version.name }));
    } catch (error) {
      console.error("[bible] delete failed", error);
      toast.danger(t("settings.bible.deleteFailed"));
    }
  }

  /** The version a drag is over, read off the `<li>` under the cursor. `null`
   *  when the pointer is between the rows or outside them — the caller treats
   *  that as "no target" rather than guessing at one. */
  function dropTargetId(e: DragEvent<HTMLElement>): number | null {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-id]");
    const id = li ? Number(li.dataset.id) : Number.NaN;
    return Number.isFinite(id) ? id : null;
  }

  function handleDragOver(e: DragEvent<HTMLUListElement>) {
    if (!reorderEnabled || !e.dataTransfer.types.includes(BIBLE_VERSION_MIME)) return;
    e.preventDefault();
    setDragOverId(dropTargetId(e));
  }

  /** Drop-BEFORE semantics, exactly like `ProgramsModal`'s: the dragged
   *  version is pulled out of the list first and then inserted where the row
   *  it was dropped on now sits, which is why there is no index-shift
   *  correction here. The store applies it optimistically and then replaces it
   *  with what main actually stored. */
  function handleDrop(e: DragEvent<HTMLUListElement>) {
    const raw = e.dataTransfer.getData(BIBLE_VERSION_MIME);
    setDragOverId(null);
    if (!reorderEnabled || raw === "") return;
    e.preventDefault();

    const fromId = Number(raw);
    const targetId = dropTargetId(e);
    if (targetId === null || fromId === targetId) return;
    const from = versions.findIndex((version) => version.id === fromId);
    if (from === -1) return;

    const next = [...versions];
    const [moved] = next.splice(from, 1);
    const insertAt = next.findIndex((version) => version.id === targetId);
    if (!moved || insertAt === -1) return;
    next.splice(insertAt, 0, moved);
    void reorderVersions(next.map((version) => version.id));
  }

  function handleRenameKey(e: KeyboardEvent<HTMLInputElement>, version: BibleVersionDTO) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename(version);
    } else if (e.key === "Escape") {
      // Stopped, because `Modal` listens for Escape on `document`: without
      // this, one press would abandon the rename AND close Settings.
      e.preventDefault();
      e.stopPropagation();
      setRenamingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Two cards, not one: importing is an ACTION and the list below is a
          set of things, and a single group's `divide-y` drew the same line
          between the button and the first bible as between two bibles. */}
      <FieldGroup title={t("settings.groups.versions")}>
        <FieldRow description={t("settings.bible.importDesc")} label={t("settings.bible.import")}>
          {/* `floating` on every tooltip in here, without exception: this
              panel is the `overflow-y-auto` one in `SettingsModal`, so an
              in-flow bubble is clipped by it — which is why the row actions'
              tooltips could not be seen at all. */}
          <Tooltip content={t("settings.bible.importFormats")} floating>
            <Icon className="text-subtle" name="help" />
          </Tooltip>
          <Button
            loading={importing}
            loadingLabel={t("bible.importing")}
            onClick={() => void importVersion()}
            variant="outline"
          >
            <Icon name="import" />
            {t("bible.import")}
          </Button>
        </FieldRow>
      </FieldGroup>

      {versions.length > 0 ? (
        <FieldGroup title={t("settings.groups.versionsInstalled")}>
          <ul
            aria-label={t("settings.bible.versionsLabel")}
            className="divide-y divide-border"
            onDragLeave={() => setDragOverId(null)}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {versions.map((version) => {
              const renaming = renamingId === version.id;
              const isDefault = version.id === defaultVersionId;
              return (
                <VersionRow
                  busy={busyId === version.id}
                  draggable={reorderEnabled}
                  dragOver={dragOverId === version.id}
                  dragging={draggingId === version.id}
                  draftName={draftName}
                  isDefault={isDefault}
                  key={version.id}
                  onDelete={() => void askToDelete(version)}
                  onDraftNameChange={setDraftName}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDragOverId(null);
                  }}
                  onDragStart={(e) => {
                    hideDragGhost(e);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData(BIBLE_VERSION_MIME, String(version.id));
                    setDraggingId(version.id);
                  }}
                  onRenameCommit={() => void commitRename(version)}
                  onRenameKey={(e) => handleRenameKey(e, version)}
                  onRenameStart={() => startRename(version)}
                  onSetDefault={() => void setDefault(version)}
                  renaming={renaming}
                  version={version}
                />
              );
            })}
          </ul>
          {/* Outside the `<ul>` so it is not announced as one more version,
              and only while the gesture is actually available. */}
          {reorderEnabled ? (
            <p className="py-2 text-xs text-muted-foreground">{t("settings.bible.reorderHint")}</p>
          ) : null}
        </FieldGroup>
      ) : null}

      {versions.length === 0 ? (
        <div className="relative min-h-40">
          <EmptyState
            description={t("settings.bible.versionsEmptyHint")}
            icon="bible"
            title={t("settings.bible.versionsEmpty")}
          />
        </div>
      ) : null}

      <ConfirmModal
        confirmLabel={
          pending && pending.usages.length > 0 ? t("settings.bible.deleteAnyway") : t("common.delete")
        }
        danger
        description={
          pending && pending.usages.length > 0 ? (
            <ProgramUsages
              intro={t("settings.bible.deleteInUseIntro")}
              usages={pending.usages}
              warning={t("settings.bible.deleteInUseWarning")}
            />
          ) : (
            t("settings.bible.deleteBody")
          )
        }
        onConfirm={async () => {
          if (pending) await confirmDelete(pending);
        }}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        open={pending !== null}
        title={t("settings.bible.deleteTitle")}
      />
    </div>
  );
}

type VersionRowProps = {
  /** A write for this version is in flight — the buttons that would start a
   *  second one are out for its duration. */
  busy: boolean;
  draftName: string;
  /** Reordering is available at all: off for a single version and while a
   *  rename is open. The grip stays in place, greyed out, so the row does not
   *  change width — same call `ProgramRow` makes for a filtered list. */
  draggable: boolean;
  /** A drag is hovering this row: the drop indicator goes above it. */
  dragOver: boolean;
  /** This row is the one being dragged — faded in place. */
  dragging: boolean;
  isDefault: boolean;
  onDelete: () => void;
  onDraftNameChange: (next: string) => void;
  onDragEnd: () => void;
  onDragStart: (e: DragEvent<HTMLLIElement>) => void;
  onRenameCommit: () => void;
  onRenameKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  onRenameStart: () => void;
  onSetDefault: () => void;
  renaming: boolean;
  version: BibleVersionDTO;
};

/**
 * One installed bible.
 *
 * Its own component rather than an inline `map` body because it owns a piece
 * of state the section must not have: `dragReady`. Native HTML5 drag has no
 * handle concept — the ROW is what carries `draggable` — so it is armed only
 * while the grip is held and disarmed right after, which is what keeps a press
 * on the name a plain click. Identical to `ProgramRow`'s, deliberately.
 */
function VersionRow({
  busy,
  draftName,
  draggable,
  dragOver,
  dragging,
  isDefault,
  onDelete,
  onDraftNameChange,
  onDragEnd,
  onDragStart,
  onRenameCommit,
  onRenameKey,
  onRenameStart,
  onSetDefault,
  renaming,
  version,
}: VersionRowProps) {
  const t = useT();
  const [dragReady, setDragReady] = useState(false);
  const defaultLabel = isDefault ? t("settings.bible.isDefault") : t("settings.bible.setDefault");

  return (
    <li
      className={cn(dragging && "opacity-40")}
      data-id={version.id}
      draggable={draggable && dragReady}
      onDragEnd={() => {
        setDragReady(false);
        onDragEnd();
      }}
      onDragStart={onDragStart}
    >
      <FieldRow
        description={renaming ? t("settings.bible.renameHint") : undefined}
        dropBefore={dragOver}
        grip
        gripDisabled={!draggable}
        label={
          renaming ? (
            <Input
              aria-label={t("settings.bible.renameLabel")}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the field does not exist until «Rename» is pressed and it replaces the name in place, so this is focus following the operator's own click, not focus stolen on arrival. A ref callback instead would re-fire on every keystroke and reset the caret.
              autoFocus
              className="w-64"
              maxLength={BIBLE_VERSION_NAME_MAX_LENGTH}
              onBlur={onRenameCommit}
              onChange={(e) => onDraftNameChange(e.target.value)}
              onKeyDown={onRenameKey}
              value={draftName}
            />
          ) : (
            <span className="truncate">{version.name}</span>
          )
        }
        leading={
          // The star IS the default marker — there is no badge saying so any
          // more, and none saying «Included» either: neither was something the
          // operator could act on, and between them they pushed the name off
          // its own column on exactly the rows that had them.
          <Tooltip content={defaultLabel} floating>
            <IconButton
              aria-label={defaultLabel}
              aria-pressed={isDefault}
              // Inert rather than hidden on the current default: there is
              // always exactly one, so this is a state and not a missing
              // control.
              disabled={isDefault || busy}
              onClick={onSetDefault}
              size="xs"
              variant="ghost"
            >
              <Icon className={cn(isDefault ? "fill-current text-accent-ink" : "text-subtle")} name="favorite" />
            </IconButton>
          </Tooltip>
        }
        onGripMouseDown={draggable ? () => setDragReady(true) : undefined}
        onGripMouseUp={draggable ? () => setDragReady(false) : undefined}
      >
        {/* Nothing but the field while a name is being typed: the row's own
            «Rename» button is what the operator just pressed, and a delete
            one keystroke away from the caret is a trap. */}
        {renaming ? null : (
          <>
            <Tooltip content={t("settings.bible.rename")} floating>
              <IconButton aria-label={t("settings.bible.rename")} disabled={busy} onClick={onRenameStart} variant="ghost">
                <Icon name="pencil" />
              </IconButton>
            </Tooltip>
            <Tooltip content={t("common.delete")} floating>
              <IconButton aria-label={t("common.delete")} disabled={busy} onClick={onDelete} variant="ghost">
                <Icon name="remove" />
              </IconButton>
            </Tooltip>
          </>
        )}
      </FieldRow>
    </li>
  );
}

/** Main's own message when it has one. An import can fail for two reasons the
 *  operator can act on differently — the file is not a bible, or it is one
 *  with no verses in it — and only main knows which. */
function describeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message.length > 0 ? message : fallback;
}

