import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Modal, ModalTitle } from "@renderer/components/shared/modal";
import { Button, Icon, IconButton, Menu, type MenuOption } from "@renderer/components/ui";
import { cn } from "@renderer/lib/utils";
import { LiveIndicator } from "./LiveIndicator";

const SAVE_SHORTCUT = navigator.userAgent.includes("Mac") ? "⌘S" : "Ctrl+S";

/** What an editor that saves on demand puts in its bar. Its absence makes the
 *  screen one that applies at once (Settings, the verse's look): «← Back» and
 *  nothing to save. */
type SaveActions = {
  canSave: boolean;
  dirty: boolean;
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
};

/** The edited thing's name, written in the bar instead of a «Name» field. */
type EditableName = {
  label: string;
  maxLength: number;
  onChange: (value: string) => void;
  /** What an empty name shows, so a new thing's bar is not a blank gap. */
  placeholder?: string | undefined;
  /** For the editor that puts the caret here (something new to name). */
  ref?: Ref<HTMLInputElement> | undefined;
  value: string;
};

type EditorScreenProps<T extends string> = {
  /** The canvas: what is being edited, in the middle. */
  children: ReactNode;
  /** The right-hand column — an `Inspector`. */
  inspector?: ReactNode;
  /** The left-hand column: the things of this kind, «New» first. */
  list?: ReactNode;
  /** «+ New …», at the top of the list: one place and one look for every
   *  editor that makes things of a kind. */
  onNew?: { label: string; onClick: () => void } | undefined;
  /** The «⋯» menu's commands (Duplicate, Delete). */
  menu?: { options: readonly MenuOption<T>[]; onSelect: (value: T) => void } | undefined;
  name?: EditableName | undefined;
  /** ✕, ←, or Escape. Whoever owns the draft decides whether that asks first. */
  onClose: () => void;
  open: boolean;
  save?: SaveActions | undefined;
  /** What kind of thing this edits («Themes»): the dialog's accessible name. */
  title: string;
};

/**
 * A full-screen editor (2026-11-04 redesign): a bar on top, and under it a list
 * of things · the canvas · the inspector. Every editor in the control window
 * has this same shape, so «Save» is always in the same corner.
 *
 * Two save models, each with its own look (Material's full-screen dialog): an
 * editor that saves on demand closes with ✕ and has «Save» — the one primary
 * button of the screen — plus «Discard» while there are changes and «Edited»
 * by the title; one that applies at once closes with «← Back» and has neither.
 *
 * Built on `Modal size="screen"`, so it inherits the focus trap, the inert
 * work screen, Escape (after any open dropdown has used it), and the global
 * shortcuts switched off while it is open — which is the owner's rule: with an
 * editor open, no key acts on the projector. `LiveIndicator` shows what is
 * on air instead.
 */
export function EditorScreen<T extends string>({
  children,
  inspector,
  list,
  menu,
  name,
  onClose,
  onNew,
  open,
  save,
  title,
}: EditorScreenProps<T>) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const onSave = save?.onSave;
  const canSave = save ? save.canSave && !save.saving : false;

  // ⌘S / Ctrl+S, only while focus is inside THIS screen: a confirm opened on
  // top of it holds the focus, and must not save the draft behind it.
  useEffect(() => {
    if (!open || !onSave) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      if (!rootRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      if (canSave) onSave();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onSave, canSave]);

  return (
    <Modal onOpenChange={(next) => (next ? undefined : onClose())} open={open} size="screen">
      <div className="flex min-h-0 flex-1 flex-col" ref={rootRef}>
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
          {save ? (
            <IconButton aria-label={t("common.close")} onClick={onClose} size="sm" title={t("common.close")} variant="ghost">
              <Icon name="close" />
            </IconButton>
          ) : (
            <Button onClick={onClose} size="sm" variant="ghost">
              <Icon name="arrowLeft" />
              {t("editor.back")}
            </Button>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ModalTitle className={cn("shrink-0", name && "text-muted-foreground")}>{title}</ModalTitle>
            {name ? (
              <>
                <span aria-hidden="true" className="text-subtle">
                  /
                </span>
                <input
                  aria-label={name.label}
                  className="h-8 min-w-24 max-w-96 truncate rounded-md field-sizing-content border border-transparent bg-transparent px-2 font-stretch-extra-condensed text-xl font-bold text-foreground hover:border-border placeholder:text-subtle focus-ring focus:border-border focus:bg-surface"
                  maxLength={name.maxLength}
                  onChange={(e) => name.onChange(e.target.value)}
                  // Enter in the name saves, as it did in the programs' old
                  // side panel: name it, press Enter, done.
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || !onSave) return;
                    e.preventDefault();
                    if (canSave) onSave();
                  }}
                  placeholder={name.placeholder}
                  ref={name.ref}
                  spellCheck={false}
                  value={name.value}
                />
              </>
            ) : null}
            {save?.dirty ? <span className="shrink-0 text-dense text-subtle">{t("editor.edited")}</span> : null}
          </div>
          {save ? (
            <div className="flex shrink-0 items-center gap-2">
              {save.dirty ? (
                <Button onClick={save.onDiscard} size="sm" variant="ghost">
                  {t("editor.discard")}
                </Button>
              ) : null}
              <Button
                disabled={!save.canSave}
                loading={save.saving}
                onClick={save.onSave}
                size="sm"
                title={t("editor.saveHint", { shortcut: SAVE_SHORTCUT })}
              >
                {t("common.save")}
              </Button>
              {menu ? (
                <Menu align="end" icon="more" label={t("editor.more")} onSelect={menu.onSelect} options={menu.options} size="sm" />
              ) : null}
            </div>
          ) : null}
          <div className="h-8 w-px shrink-0 bg-border" />
          <LiveIndicator />
        </header>
        <div className="flex min-h-0 flex-1">
          {list ? (
            <nav className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-border bg-background">
              {onNew ? (
                <div className="shrink-0 p-2">
                  <Button className="w-full justify-start" onClick={onNew.onClick} size="sm" variant="ghost">
                    <Icon name="add" />
                    {onNew.label}
                  </Button>
                </div>
              ) : null}
              {list}
            </nav>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-card">{children}</div>
          {inspector}
        </div>
      </div>
    </Modal>
  );
}
