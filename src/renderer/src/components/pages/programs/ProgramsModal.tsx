import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@renderer/lib/i18n/i18n-provider";
import { ConfirmModal } from "@renderer/components/shared/modal";
import { EditorScreen } from "@renderer/components/shared/editor-screen";
import {
  Box,
  Button,
  Callout,
  EmptyState,
  FieldRow,
  Icon,
  Inspector,
  InspectorSection,
  Input,
  ListRow,
  Select,
  Skeleton,
  Switch,
  Textarea,
  Title,
  type MenuOption,
} from "@renderer/components/ui";
import { normalizeForSearch } from "@renderer/lib/utils";
import { api } from "@renderer/lib/api";
import { PROGRAM_ROW_MIME } from "@renderer/lib/dnd";
import { useProgramStore } from "@renderer/stores/program.store";
import {
  createProgram,
  createProgramFromCurrent,
  deleteProgram,
  duplicateProgram,
  hasUnsavedChanges,
  openProgram,
  reorderPrograms,
  setProgramFavorite,
  updateProgramMeta,
  type ProgramMetaInput,
} from "@renderer/lib/actions/programs";
import { ProgramItemList } from "./program-item-list";
import { ProgramRow } from "./program-row";
import type { ProgramItemDTO, ProgramSummary } from "@shared/types/program";

type FavoriteFilter = "all" | "favorites" | "others";

/** The floating clone standing in for the browser's native drag-ghost — see
 *  the window listener below. `offsetY` is where inside the row the cursor
 *  first grabbed it, kept constant so the clone doesn't jump to align its top
 *  with the cursor. `left`/`width` never change: only `top` tracks the
 *  cursor, which is what makes the drag read as vertical-only. */
type DragPreview = { height: number; id: number; left: number; name: string; offsetY: number; top: number; width: number };

type Draft = { favorite: boolean; name: string; notes: string };

/** What the screen has chosen. `create` saves the schedule being worked on as
 *  a new program (the top bar's «Save» on an unsaved one); `new` is an empty
 *  program. Duplicating is not a draft: it saves a copy of the saved program
 *  at once, like every other editor's «Duplicate». */
type Editing =
  | { kind: "saved"; program: ProgramSummary; draft: Draft; baseline: Draft }
  | { kind: "create"; draft: Draft; baseline: Draft }
  | { kind: "new"; draft: Draft; baseline: Draft; openAfter: boolean };

/** `schedule`: the schedule being worked on has unsaved changes, and `go`
 *  would replace it. */
type Pending =
  | { kind: "leave"; go: () => void }
  | { kind: "delete"; program: ProgramSummary }
  | { kind: "schedule"; go: () => Promise<void> };

const EMPTY: Draft = { favorite: false, name: "", notes: "" };
const draftOf = (program: ProgramSummary): Draft => ({
  favorite: program.favorite,
  name: program.name,
  notes: program.notes ?? "",
});
const savedEditing = (program: ProgramSummary): Editing => ({
  kind: "saved",
  program,
  draft: draftOf(program),
  baseline: draftOf(program),
});
const sameDraft = (a: Draft, b: Draft) => a.name === b.name && a.notes === b.notes && a.favorite === b.favorite;

type ProgramsModalProps = {
  initialMode?: { kind: "create" } | undefined;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

/**
 * The saved programs, full screen (2026-11-04 redesign, owner's D10): the
 * programs on the left, what the chosen one IS — its items — in the middle,
 * its favourite, notes and dates in the inspector. Saving a program that was
 * never saved lands here too, with a new row chosen and the name ready to
 * type. Opening one is the canvas's «Open»; a double click on a row is the
 * fast path to the same thing.
 */
export function ProgramsModal({ initialMode, onOpenChange, open }: ProgramsModalProps) {
  const { locale, t } = useI18n();
  const currentProgramId = useProgramStore((s) => s.currentProgramId);
  const workingItems = useProgramStore((s) => s.items);

  const [query, setQuery] = useState("");
  const [favoriteFilter, setFavoriteFilter] = useState<FavoriteFilter>("all");
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // `ModalBoundary` remounts this on every opening, so the initializer runs
  // once per opening and the bar never paints a frame without the new row.
  const [editing, setEditing] = useState<Editing | null>(() =>
    initialMode?.kind === "create" ? { kind: "create", draft: EMPTY, baseline: EMPTY } : null,
  );
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [peeked, setPeeked] = useState<{ id: number; items: ProgramItemDTO[] } | "loading" | "error">("loading");
  const nameRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<number, HTMLLIElement>());
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);

  // The clone has to keep tracking the cursor even past the list's own
  // bounds (e.g. dragged up over the search bar), so it listens on the
  // window rather than relying on the list's own onDragOver/onDragEnd.
  useEffect(() => {
    if (!dragPreview) return;
    function trackY(e: globalThis.DragEvent) {
      setDragPreview((prev) => (prev ? { ...prev, top: e.clientY - prev.offsetY } : prev));
    }
    function clear() {
      setDragPreview(null);
    }
    window.addEventListener("dragover", trackY);
    window.addEventListener("dragend", clear);
    return () => {
      window.removeEventListener("dragover", trackY);
      window.removeEventListener("dragend", clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only (re)subscribe when a drag starts/ends, not on every tracked pixel
  }, [dragPreview !== null]);

  async function refreshList(): Promise<ProgramSummary[] | null> {
    setLoading(true);
    setLoadError(false);
    try {
      const list = await api.programs.list();
      setPrograms(list);
      return list;
    } catch {
      setLoadError(true);
      return null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) {
      setEditing(null);
      setPending(null);
      return;
    }
    setQuery("");
    setFavoriteFilter("all");
    const creating = initialMode?.kind === "create";
    if (creating) setEditing({ kind: "create", draft: EMPTY, baseline: EMPTY });
    void refreshList().then((list) => {
      if (creating || !list) return;
      // The program in use first: managing programs usually starts from it.
      const pick = list.find((p) => p.id === useProgramStore.getState().currentProgramId) ?? list[0];
      if (pick) setEditing((current) => current ?? savedEditing(pick));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [open]);

  // `peek`, never `load`: choosing a row is a single click, and loading adopts
  // the program in main (history attribution + deck pins).
  const peekId = editing?.kind === "saved" ? editing.program.id : null;
  useEffect(() => {
    if (peekId === null) return;
    let cancelled = false;
    setPeeked("loading");
    api.programs
      .peek(peekId)
      .then((full) => {
        if (!cancelled) setPeeked({ id: full.id, items: full.items });
      })
      .catch(() => {
        if (!cancelled) setPeeked("error");
      });
    return () => {
      cancelled = true;
    };
  }, [peekId]);

  // Something new to name: the caret goes to the name in the bar.
  const draftKey = editing === null || editing.kind === "saved" ? null : editing.kind;
  useEffect(() => {
    if (draftKey !== null) nameRef.current?.focus();
  }, [draftKey]);

  const selectedId = editing?.kind === "saved" ? editing.program.id : null;
  useEffect(() => {
    if (selectedId !== null) rowRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const dirty = editing !== null && !sameDraft(editing.draft, editing.baseline);
  const named = editing !== null && editing.draft.name.trim() !== "";
  const canSave = editing !== null && named && (editing.kind !== "saved" || dirty);

  const filtersActive = query.trim() !== "" || favoriteFilter !== "all";
  // Reordering a filtered view can't be mapped back onto the full list, so the
  // drag affordance is greyed out while a search or filter is on.
  const reorderEnabled = !filtersActive && programs.length > 1;

  const filtered = useMemo(() => {
    const q = normalizeForSearch(query);
    return programs
      .filter((p) => (q ? normalizeForSearch(p.name).includes(q) : true))
      .filter((p) => {
        if (favoriteFilter === "favorites") return p.favorite;
        if (favoriteFilter === "others") return !p.favorite;
        return true;
      });
  }, [programs, query, favoriteFilter]);

  /** Every way off the chosen row goes through here: changes the operator
   *  made to it cost a «Discard changes?» first, like every other editor. */
  function leaveEditing(go: () => void) {
    if (dirty) setPending({ kind: "leave", go });
    else go();
  }

  /** Whatever replaces the schedule being worked on asks first when it has
   *  unsaved changes. */
  function guardSchedule(go: () => Promise<void>) {
    if (hasUnsavedChanges()) setPending({ kind: "schedule", go });
    else void go();
  }

  const select = (program: ProgramSummary) => leaveEditing(() => setEditing(savedEditing(program)));
  const patch = (next: Partial<Draft>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...next } } : current));

  function requestOpen(id: number) {
    leaveEditing(() =>
      guardSchedule(async () => {
        await openProgram(id);
        onOpenChange(false);
      }),
    );
  }

  async function toggleFavorite(program: ProgramSummary) {
    const updated = await setProgramFavorite(program.id, !program.favorite);
    if (!updated) return;
    setPrograms((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    // The star is saved at once: the chosen row's draft and baseline follow
    // it, so it is never a pending change of the inspector.
    setEditing((current) =>
      current?.kind === "saved" && current.program.id === updated.id
        ? {
            ...current,
            program: updated,
            baseline: { ...current.baseline, favorite: updated.favorite },
            draft: { ...current.draft, favorite: updated.favorite },
          }
        : current,
    );
  }

  async function handleSave() {
    if (!editing || !canSave) return;
    const meta: ProgramMetaInput = {
      favorite: editing.draft.favorite,
      name: editing.draft.name.trim(),
      notes: editing.draft.notes.trim() || null,
    };
    if (editing.kind === "new" && editing.openAfter) {
      guardSchedule(async () => {
        setSaving(true);
        try {
          if (await createProgram(meta, true)) onOpenChange(false);
        } finally {
          setSaving(false);
        }
      });
      return;
    }
    setSaving(true);
    try {
      const saved =
        editing.kind === "saved"
          ? await updateProgramMeta(editing.program.id, meta)
          : editing.kind === "create"
            ? await createProgramFromCurrent(meta)
            : await createProgram(meta, false);
      if (!saved) return;
      const list = await refreshList();
      setEditing(savedEditing(list?.find((p) => p.id === saved.id) ?? saved));
    } finally {
      setSaving(false);
    }
  }

  /** A copy of what is SAVED, saved at once and chosen — the other editors'
   *  «Duplicate». It used to be a draft of the current draft, so a copy made
   *  right after «discard?» carried the changes just discarded. */
  async function handleDuplicate(source: ProgramSummary) {
    const copy = await duplicateProgram(source.id, {
      favorite: source.favorite,
      name: t("programs.duplicateName", { name: source.name }),
      notes: source.notes,
    });
    if (!copy) return;
    const list = await refreshList();
    setEditing(savedEditing(list?.find((p) => p.id === copy.id) ?? copy));
  }

  /** Which row a drag is hovering, by program id — `null` means past the last
   *  row, i.e. drop at the end. */
  function dropTargetId(e: DragEvent<HTMLDivElement>): number | null {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li");
    if (!li) return null;
    // The rows without an id are drafts: the unsaved schedule always sits
    // above every program (dropping on it means "put this first"), a new
    // program below them all.
    if (li.dataset.id === undefined) return li.previousElementSibling === null ? (programs[0]?.id ?? null) : null;
    return Number(li.dataset.id);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (!reorderEnabled || !e.dataTransfer.types.includes(PROGRAM_ROW_MIME)) return;
    e.preventDefault();
    setDragOverId(dropTargetId(e));
  }

  /** Drop-before semantics: the dragged program is pulled out of the list
   *  first, then inserted where the row it was dropped on now sits — which is
   *  why there's no index-shift correction here. Applied optimistically and
   *  then replaced by whatever the main process actually stored. */
  function handleDrop(e: DragEvent<HTMLDivElement>) {
    const raw = e.dataTransfer.getData(PROGRAM_ROW_MIME);
    setDragOverId(null);
    if (!reorderEnabled || raw === "") return;
    e.preventDefault();

    const fromId = Number(raw);
    const targetId = dropTargetId(e);
    if (fromId === targetId) return;
    const from = programs.findIndex((p) => p.id === fromId);
    if (from === -1) return;

    const next = [...programs];
    const [moved] = next.splice(from, 1);
    const insertAt = targetId === null ? next.length : next.findIndex((p) => p.id === targetId);
    if (!moved || insertAt === -1) return;
    next.splice(insertAt, 0, moved);
    setPrograms(next);
    void reorderPrograms(next.map((p) => p.id))
      .then((stored) => {
        if (stored) setPrograms(stored);
        else void refreshList();
      })
      // `reorderPrograms` already returns `null` on failure, so only a throw
      // from the `then` itself lands here. Without this it would escape to the
      // global `unhandledrejection` handler as a generic error toast, leaving
      // the optimistic order on screen and the stored one unknown.
      .catch(() => void refreshList());
  }

  function handleSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (filtered.length === 0) return;
    const at = selectedId === null ? -1 : filtered.findIndex((p) => p.id === selectedId);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = filtered[Math.min(at + 1, filtered.length - 1)];
      if (next) select(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      // Up from nothing chosen enters the list from the LAST row, mirroring
      // Down entering it from the first; inside the list it clamps.
      const next = filtered[at < 0 ? filtered.length - 1 : Math.max(at - 1, 0)];
      if (next) select(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[at];
      if (target) requestOpen(target.id);
    }
  }

  const showDraftRow = (currentProgramId === null && workingItems.length > 0) || editing?.kind === "create";

  const items: readonly ProgramItemDTO[] | "loading" | "error" =
    editing === null || editing.kind === "new"
      ? []
      : editing.kind === "create"
        ? workingItems
        : peeked === "loading" || peeked === "error"
          ? peeked
          : peeked.id === peekId
            ? peeked.items
            : "loading";
  const itemCount =
    editing === null || editing.kind === "new"
      ? 0
      : editing.kind === "create"
        ? workingItems.length
        : editing.program.itemCount;

  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);

  const menuOptions: MenuOption<"duplicate" | "delete">[] = [
    { disabled: editing?.kind !== "saved", label: t("common.duplicate"), value: "duplicate" },
    { disabled: editing?.kind !== "saved", label: t("common.delete"), tone: "danger", value: "delete" },
  ];

  return (
    <>
      <EditorScreen
        inspector={
          editing ? (
            // One section like every inspector; the favourite is the row's star
            // only (it was a second control here too — 2026-11-04 review).
            <Inspector label={t("programs.title")}>
              <InspectorSection title={t("schedule.title")}>
                {editing.kind === "new" ? (
                  <FieldRow label={t("programs.createAndOpen")}>
                    <Switch
                      checked={editing.openAfter}
                      onChange={(e) => setEditing({ ...editing, openAfter: e.target.checked })}
                    />
                  </FieldRow>
                ) : null}
                <FieldRow label={t("programs.notes")} layout="stacked">
                  <Textarea
                    className="min-h-32"
                    onChange={(e) => patch({ notes: e.target.value })}
                    placeholder={t("programs.notesPlaceholder")}
                    value={editing.draft.notes}
                  />
                </FieldRow>
                {editing.kind === "saved" ? (
                  <>
                    <FieldRow label={t("programs.createdAt")}>
                      <span>{dateFormat.format(editing.program.createdAt)}</span>
                    </FieldRow>
                    <FieldRow label={t("programs.lastOpenedAt")}>
                      <span>
                        {editing.program.lastOpenedAt === null
                          ? t("programs.neverOpened")
                          : dateFormat.format(editing.program.lastOpenedAt)}
                      </span>
                    </FieldRow>
                  </>
                ) : null}
              </InspectorSection>
            </Inspector>
          ) : null
        }
        onNew={{
          label: t("programs.new"),
          onClick: () => leaveEditing(() => setEditing({ kind: "new", draft: EMPTY, baseline: EMPTY, openAfter: true })),
        }}
        list={
          <>
            <div className="flex shrink-0 flex-col gap-2 px-2 pb-2">
              <Input
                icon="search"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={t("programs.searchPlaceholder")}
                size="sm"
                value={query}
              />
              <Select
                aria-label={t("programs.filterLabel")}
                className="w-full"
                onChange={(value) => setFavoriteFilter(value as FavoriteFilter)}
                options={[
                  { label: t("programs.filterAll"), value: "all" },
                  { label: t("programs.filterFavorites"), value: "favorites" },
                  { label: t("programs.filterOthers"), value: "others" },
                ]}
                size="sm"
                value={favoriteFilter}
              />
            </div>
            <div
              className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-2"
              onDragLeave={() => setDragOverId(null)}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            >
              {loading && programs.length === 0 ? (
                <div className="flex flex-col gap-1">
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                </div>
              ) : loadError ? (
                <Callout tone="danger">
                  <p>{t("programs.loadError")}</p>
                  {/* `text-current` rather than the variant's own ink: a link
                      inside a toned Callout reads as part of that message. */}
                  <Button className="mt-1 text-current" onClick={() => void refreshList()} variant="link">
                    {t("common.retry")}
                  </Button>
                </Callout>
              ) : filtered.length === 0 && filtersActive ? (
                <EmptyState icon="search" title={t("programs.noResults")} />
              ) : (
                <ul aria-label={t("programs.listLabel")} className="flex flex-col gap-0.5">
                  {showDraftRow ? (
                    <ListRow
                      leading={<Icon className="text-subtle" name="filePlus" />}
                      onClick={() => leaveEditing(() => setEditing({ kind: "create", draft: EMPTY, baseline: EMPTY }))}
                      selected={editing?.kind === "create"}
                    >
                      {t("header.untitled")}
                    </ListRow>
                  ) : null}
                  {filtered.map((program) => (
                    <ProgramRow
                      dragOver={dragOverId === program.id}
                      dragging={dragPreview?.id === program.id}
                      draggable={reorderEnabled}
                      isCurrent={program.id === currentProgramId}
                      key={program.id}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData(PROGRAM_ROW_MIME, String(program.id));
                        const rect = e.currentTarget.getBoundingClientRect();
                        setDragPreview({
                          height: rect.height,
                          id: program.id,
                          left: rect.left,
                          name: program.name,
                          offsetY: e.clientY - rect.top,
                          top: rect.top,
                          width: rect.width,
                        });
                      }}
                      onOpen={() => requestOpen(program.id)}
                      onSelect={() => select(program)}
                      onToggleFavorite={() => void toggleFavorite(program)}
                      program={program}
                      ref={(el) => {
                        if (el) rowRefs.current.set(program.id, el);
                        else rowRefs.current.delete(program.id);
                      }}
                      selected={selectedId === program.id}
                    />
                  ))}
                  {editing?.kind === "new" ? (
                    <ListRow selected>{editing.draft.name || t("programs.namePlaceholder")}</ListRow>
                  ) : null}
                </ul>
              )}
            </div>
          </>
        }
        menu={{
          onSelect: (command) => {
            if (editing?.kind !== "saved") return;
            if (command === "delete") {
              setPending({ kind: "delete", program: editing.program });
              return;
            }
            const source = editing.program;
            leaveEditing(() => void handleDuplicate(source));
          },
          options: menuOptions,
        }}
        name={
          editing
            ? {
                label: t("programs.name"),
                // The program name has no limit of its own in the schema; this
                // only keeps a pasted paragraph out of the bar.
                maxLength: 200,
                onChange: (name) => patch({ name }),
                placeholder: t("programs.namePlaceholder"),
                ref: nameRef,
                value: editing.draft.name,
              }
            : undefined
        }
        onClose={() => leaveEditing(() => onOpenChange(false))}
        open={open}
        // Always the save model, even with nothing chosen: this screen edits,
        // and its bar keeps ✕ and «Save» in the same corner either way.
        save={{
          canSave,
          dirty,
          onDiscard: () => setEditing((current) => (current ? { ...current, draft: current.baseline } : current)),
          onSave: () => void handleSave(),
          saving,
        }}
        title={t("programs.title")}
      >
        {editing === null ? (
          <div className="relative flex-1">
            {loading || loadError ? null : (
              // With nothing saved yet the list still shows the unsaved
              // schedule: say it is the way to save it (2026-11-05 review: the
              // canvas said «nothing saved» beside a row, with no next step).
              <EmptyState
                {...(showDraftRow ? { description: t("programs.emptyDraftHint", { name: t("header.untitled") }) } : {})}
                icon="folderOpen"
                title={t("programs.empty")}
              />
            )}
          </div>
        ) : (
          // The items in a framed box down to the bottom, under a header —
          // the song editor's lyrics box: the canvas is one object, not rows
          // hanging at the top of an empty area (owner, 2026-11-04).
          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-2 p-6">
            <div className="flex items-center gap-2">
              <Title as="h3" className="flex-1">
                {t("schedule.itemCount", { count: itemCount })}
              </Title>
              {editing.kind === "saved" ? (
                <Button onClick={() => requestOpen(editing.program.id)} size="sm" variant="outline">
                  {t("common.open")}
                </Button>
              ) : null}
            </div>
            <Box className="relative min-h-0 flex-1 overflow-y-auto">
              {items === "loading" ? (
                <div className="flex flex-col gap-1 p-2">
                  <Skeleton className="h-9" />
                  <Skeleton className="h-9" />
                  <Skeleton className="h-9" />
                </div>
              ) : items === "error" ? (
                <div className="p-3">
                  <Callout tone="danger">{t("programs.loadError")}</Callout>
                </div>
              ) : items.length > 0 ? (
                <ProgramItemList items={items} />
              ) : (
                <EmptyState icon="folderOpen" title={t("schedule.empty")} />
              )}
            </Box>
          </div>
        )}
      </EditorScreen>

      <ConfirmModal
        confirmLabel={
          pending?.kind === "delete"
            ? t("common.delete")
            : pending?.kind === "schedule"
              ? t("programs.discardConfirm")
              : t("programs.leave")
        }
        danger={pending?.kind === "delete"}
        description={
          pending?.kind === "delete" ? (
            <>
              <p>{t("programs.deleteWarning", { name: pending.program.name })}</p>
              <p>{t("programs.itemCount", { count: pending.program.itemCount })}</p>
            </>
          ) : pending?.kind === "schedule" ? (
            t("programs.discardWarning")
          ) : (
            t("programs.leaveBody")
          )
        }
        onConfirm={async () => {
          if (!pending) return;
          if (pending.kind === "leave") {
            pending.go();
            return;
          }
          if (pending.kind === "schedule") {
            await pending.go();
            return;
          }
          await deleteProgram(pending.program.id);
          const list = await refreshList();
          const next = list?.find((p) => p.id === useProgramStore.getState().currentProgramId) ?? list?.[0];
          setEditing(next ? savedEditing(next) : null);
        }}
        onOpenChange={(next) => {
          // Leaving a changed row to open a program asks twice — first for the
          // row, then for the schedule — and the second question is set by the
          // first one's `go`: closing must not clear it.
          const shown = pending;
          if (!next) setPending((current) => (current === shown ? null : current));
        }}
        open={pending !== null}
        title={
          pending?.kind === "delete"
            ? t("programs.deleteTitle")
            : t("programs.discardTitle")
        }
      />

      {dragPreview
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[var(--z-drag)] flex items-center gap-2 rounded-md border border-border bg-card px-4 text-sm text-foreground shadow-overlay"
              style={{
                height: dragPreview.height,
                left: dragPreview.left,
                top: dragPreview.top,
                width: dragPreview.width,
              }}
            >
              <Icon className="text-subtle" name="grip" />
              <span className="min-w-0 flex-1 truncate">{dragPreview.name}</span>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
