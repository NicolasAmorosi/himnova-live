import type { ButtonHTMLAttributes, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Fragment, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { isPointerFocused } from "@renderer/lib/focus-modality";
import { cn } from "@renderer/lib/utils";
import { FieldLabelContext } from "./field-layout";
import { computeMenuPosition, useFollowTrigger, type MenuPosition } from "./floating-menu";
import { Icon } from "./icon";
import { filterOptions, groupHeaderAt, orderByGroup } from "./select.groups";

export type SelectOption = {
  disabled?: boolean;
  /** A heading the option is listed under — the language of a bible. Options of one group are listed together,
   *  the groups in the order they first appear; the heading is a label, never a row the keyboard stops on. Leave
   *  it out when every option would share it. */
  group?: string;
  label: string;
  value: string;
};

/** A command at the foot of the list, after a rule — «Import image…» under the
 *  images it adds to. Not a value: picking it closes the menu and runs it. */
export type SelectAction = { disabled?: boolean; label: string; onSelect: () => void };

type SelectProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "type" | "value"> & {
  /** The list's last row, after a rule (2026-11-05, owner: the import lives
   *  inside the picker, not in a button that did not fit beside it). It sits
   *  at index `visible.length` of the keyboard's highlight. */
  action?: SelectAction | undefined;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  /** Puts a filter box at the top of the menu, for a list nobody can scan —
   *  the machine's installed font families. It REPLACES the type-ahead: with a
   *  real text field open, a letter belongs to the query, not to a jump. Off by
   *  default, because for a handful of options the box is one more thing
   *  between the operator and the value. */
  searchable?: boolean;
  size?: "xs" | "sm";
  value: string;
};

const sizes: Record<NonNullable<SelectProps["size"]>, string> = {
  xs: "h-7 text-xs pl-2 pr-6",
  sm: "h-8 text-sm pl-3 pr-8",
};

/**
 * A styled dropdown, not a native `<select>` — Lumina Live's identity (design
 * tokens, dark cabin theme) has to reach into the option list itself, which a
 * native listbox never lets a page style. Renders its menu through a portal
 * to `document.body`, positioned in viewport coordinates (`computeMenuPosition`),
 * so it always paints above modals/panels and is never clipped by an
 * ancestor's `overflow`, unlike `Tooltip`'s in-flow bubble.
 *
 * Keyboard behavior matches the native control it replaces: Up/Down moves the
 * highlight (opening the menu first if closed), Home/End jump to the first/
 * last enabled option, Enter/Space commits, Escape closes, typing letters
 * jumps to a matching label, and Tab closes without stealing focus.
 *
 * With `searchable`, the same keys work from the filter box instead, which is
 * what holds focus while the menu is open — so every index in here is an index
 * into the VISIBLE options, never into `options`.
 */
export function Select({
  action,
  className,
  disabled,
  onChange,
  options,
  placeholder,
  searchable = false,
  size = "sm",
  value,
  ...props
}: SelectProps) {
  const t = useT();
  const id = useId();
  const listboxId = `${id}-listbox`;
  // Named by the `FieldRow` it sits in, unless the caller names it.
  const fieldLabelId = useContext(FieldLabelContext);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeaheadRef = useRef({ buffer: "", timer: 0 });

  const selectedOption = options.find((o) => o.value === value);

  /** What the menu actually lists. Everything below indexes into THIS: with a
   *  filter applied, an index into `options` points at a row that is not on
   *  screen, which is how a keyboard commit picks the wrong font. */
  const ordered = useMemo(() => orderByGroup(options), [options]);
  const visible = useMemo(
    () => (searchable ? filterOptions(ordered, query) : ordered),
    [ordered, query, searchable],
  );

  /** Rows the highlight walks: the visible options, then the action. */
  const rows = visible.length + (action ? 1 : 0);
  const isAction = (index: number) => action !== undefined && index === visible.length;
  const rowDisabled = (index: number) => (isAction(index) ? action?.disabled === true : visible[index]?.disabled === true);

  useFollowTrigger(
    open,
    triggerRef,
    (trigger) => setPosition(computeMenuPosition(trigger)),
    () => closeMenu(searchable),
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // The filter box is what takes the keyboard while the menu is open, so it
  // has to get focus by itself: the operator opened the menu with the mouse
  // and expects to type straight into it.
  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  // The typeahead buffer's reset timer is the one thing in here that can
  // outlive the component: a Select unmounted within 500 ms of a keystroke
  // (a modal closing under the operator's hands) left it counting down
  // towards a ref nobody reads any more.
  useEffect(() => {
    const typeahead = typeaheadRef.current;
    return () => window.clearTimeout(typeahead.timer);
  }, []);

  function optionId(index: number) {
    return `${id}-option-${index}`;
  }

  useEffect(() => {
    if (!open || highlightedIndex < 0) return;
    document.getElementById(optionId(highlightedIndex))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId is a pure function of `id`, stable across renders
  }, [open, highlightedIndex]);

  /** The first row the highlight may rest on — the action when no option can
   *  (a new install's image picker holds only «Importar imagen…»). */
  function firstEnabledIndex(list: readonly SelectOption[] = visible): number {
    const index = list.findIndex((o) => !o.disabled);
    if (index >= 0) return index;
    return action && !action.disabled ? list.length : -1;
  }

  function lastEnabledIndex(): number {
    for (let i = rows - 1; i >= 0; i--) {
      if (!rowDisabled(i)) return i;
    }
    return -1;
  }

  function openMenu(initialIndex?: number) {
    if (disabled || (options.length === 0 && !action) || !triggerRef.current) return;
    // A stale query would open the menu already filtered down to whatever the
    // operator looked for last time, hiding the value that is actually set.
    if (searchable) setQuery("");
    // `ordered`, not `visible`: a searchable menu opens unfiltered (the query
    // was just cleared) and a plain one never filters at all.
    const selectedIndex = ordered.findIndex((o) => o.value === value);
    setPosition(computeMenuPosition(triggerRef.current));
    setHighlightedIndex(initialIndex ?? (selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(ordered)));
    setOpen(true);
  }

  function closeMenu(refocusTrigger: boolean) {
    setOpen(false);
    // preventScroll: a trigger closed by scrolling out of sight must not be
    // scrolled back into view by the focus that follows.
    if (refocusTrigger) triggerRef.current?.focus({ preventScroll: true });
  }

  /** `refocusTrigger` is false for a MOUSE pick: focus put back by code would
   *  read as the keyboard's, and a trigger focused by the keyboard keeps the
   *  arrows and Enter — after choosing a book with the mouse, → no longer moved
   *  the verse on the projector. Left on the page, every shortcut works. */
  function selectOption(index: number, refocusTrigger = true) {
    if (isAction(index)) {
      if (action?.disabled) return;
      closeMenu(refocusTrigger);
      action?.onSelect();
      return;
    }
    const option = visible[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    closeMenu(refocusTrigger);
  }

  function moveHighlight(delta: number) {
    setHighlightedIndex((current) => {
      const count = rows;
      if (count === 0) return -1;
      let index = current;
      for (let i = 0; i < count; i++) {
        index = (index + delta + count) % count;
        if (!rowDisabled(index)) return index;
      }
      return current;
    });
  }

  function handleTypeahead(char: string) {
    const state = typeaheadRef.current;
    window.clearTimeout(state.timer);
    state.buffer += char.toLowerCase();
    state.timer = window.setTimeout(() => {
      state.buffer = "";
    }, 500);

    const count = ordered.length;
    const startAt = open ? highlightedIndex + 1 : 0;
    for (let i = 0; i < count; i++) {
      const index = (startAt + i) % count;
      const option = ordered[index];
      if (option && !option.disabled && option.label.toLowerCase().startsWith(state.buffer)) {
        if (open) setHighlightedIndex(index);
        else openMenu(index);
        return;
      }
    }
  }

  function handleQueryChange(next: string) {
    setQuery(next);
    // The highlight is an index into a list that just changed under it, so it
    // is re-seeded rather than kept: Enter must commit the row the operator is
    // looking at, which after typing is the first match.
    setHighlightedIndex(firstEnabledIndex(filterOptions(ordered, next)));
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    // A closed trigger the mouse focused is just a button that opens on click:
    // its keys (arrows, Enter, Space, typeahead) are the operator's shortcuts.
    // Reached with Tab, they open and drive the list.
    if (disabled || (!open && isPointerFocused(e.currentTarget))) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (open) moveHighlight(1);
        else openMenu();
        break;
      case "ArrowUp":
        e.preventDefault();
        if (open) moveHighlight(-1);
        else openMenu();
        break;
      case "Home":
        if (open) {
          e.preventDefault();
          setHighlightedIndex(firstEnabledIndex());
        }
        break;
      case "End":
        if (open) {
          e.preventDefault();
          setHighlightedIndex(lastEnabledIndex());
        }
        break;
      case "Enter":
        e.preventDefault();
        if (open) selectOption(highlightedIndex);
        else openMenu();
        break;
      case " ":
        // A space inside the filter box is part of a font's name («Noto
        // Sans»), not a commit — that is the one key the two modes cannot
        // share.
        if (searchable && open) break;
        e.preventDefault();
        if (open) selectOption(highlightedIndex);
        else openMenu();
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          // Focus goes back to the trigger here (unlike the non-searchable
          // path, where the handler runs on the trigger and it never left):
          // while the menu is open it is the filter box that holds it, and
          // that box is about to be unmounted.
          closeMenu(searchable);
        }
        break;
      case "Tab":
        // Focus is handed back to the trigger BEFORE Tab does its own work, so
        // the browser moves on from the control the operator was on. Without
        // it the element holding focus (the filter box) is unmounted mid-key
        // and the tab order restarts from the top of the dialog.
        closeMenu(searchable);
        break;
      default:
        if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) handleTypeahead(e.key);
    }
  }

  const trigger = (
    <button
      aria-activedescendant={!searchable && open && highlightedIndex >= 0 ? optionId(highlightedIndex) : undefined}
      aria-controls={listboxId}
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-labelledby={props["aria-label"] === undefined ? fieldLabelId : undefined}
      className={cn(
        "focus-ring relative inline-flex items-center rounded-md border border-border bg-surface text-left text-foreground transition-colors hover:border-border-light disabled:cursor-not-allowed disabled:opacity-60",
        sizes[size],
        className,
      )}
      disabled={disabled}
      onClick={() => (open ? setOpen(false) : openMenu())}
      onKeyDown={handleKeyDown}
      ref={triggerRef}
      role="combobox"
      type="button"
      {...props}
    >
      <span className={cn("min-w-0 truncate", !selectedOption && "text-subtle")}>
        {selectedOption ? selectedOption.label : (placeholder ?? "")}
      </span>
      <Icon
        className={cn(
          "pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-subtle transition-transform",
          open && "rotate-180",
        )}
        name="chevronDown"
      />
    </button>
  );

  // The menu is the trigger's SIBLING, not its child. The portal takes it out
  // of the DOM either way, but written inside the `<button>` it reads — to a
  // person and to a linter — like a listbox full of interactive rows nested in
  // a button, which is invalid HTML and is not what ships.
  const menu =
    open && position
      ? createPortal(
          <div
            className="fixed z-[var(--z-popover)] flex flex-col rounded-xl border border-border bg-card shadow-overlay"
            ref={menuRef}
            style={{
              left: position.left,
              maxHeight: position.maxHeight,
              width: position.width,
              ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
            }}
          >
            {searchable ? (
              <div className="shrink-0 border-b border-border p-1">
                <div className="relative">
                  <Icon
                    className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-subtle"
                    name="search"
                  />
                  {/* Not the `Input` primitive: this one is chrome inside a
                      menu, with no border of its own and sized by the menu
                      rather than by the field scale. */}
                  <input
                    aria-activedescendant={highlightedIndex >= 0 ? optionId(highlightedIndex) : undefined}
                    aria-autocomplete="list"
                    aria-controls={listboxId}
                    aria-expanded
                    aria-label={t("common.search")}
                    className="h-8 w-full rounded-md bg-muted pr-2 pl-7 text-sm text-foreground placeholder:text-subtle focus-ring-inset"
                    onChange={(e) => handleQueryChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t("common.search")}
                    ref={searchRef}
                    role="combobox"
                    spellCheck={false}
                    value={query}
                  />
                </div>
              </div>
            ) : null}

            <ul
              className={cn("min-h-0 flex-1 overflow-y-auto focus:outline-none", rows > 0 && "p-1")}
              id={listboxId}
              role="listbox"
            >
              {visible.map((option, index) => {
                const header = groupHeaderAt(visible, index);
                return (
                  <Fragment key={option.value}>
                    {/* A label, not a row: no `role="option"`, no index, so the
                        highlight and the type-ahead step over it. */}
                    {header !== null ? (
                      <li
                        className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground first:pt-1"
                        role="presentation"
                      >
                        {header}
                      </li>
                    ) : null}
                    {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events --
                       In the ARIA listbox pattern the options never take focus: the
                       trigger (or the filter box) keeps it and points at the active
                       option with `aria-activedescendant`, so the keyboard
                       equivalent of this click lives in that element's `onKeyDown`.
                       A key handler here could never fire. */}
                    <li
                      aria-disabled={option.disabled || undefined}
                      aria-selected={option.value === value}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-foreground",
                        option.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                        !option.disabled && index === highlightedIndex && "bg-hover",
                      )}
                      id={optionId(index)}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectOption(index, false);
                      }}
                      onMouseEnter={() => !option.disabled && setHighlightedIndex(index)}
                      role="option"
                    >
                      <span className="truncate">{option.label}</span>
                      {option.value === value ? <Icon className="text-accent-ink" name="check" /> : null}
                    </li>
                  </Fragment>
                );
              })}
              {action ? (
                <>
                  {visible.length > 0 ? <li aria-hidden className="mx-1 my-1 h-px bg-border" role="presentation" /> : null}
                  {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events -- same as the options above: the trigger's `onKeyDown` commits it */}
                  <li
                    aria-disabled={action.disabled || undefined}
                    aria-selected={false}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground",
                      action.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                      !action.disabled && highlightedIndex === visible.length && "bg-hover",
                    )}
                    id={optionId(visible.length)}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectOption(visible.length, false);
                    }}
                    onMouseEnter={() => !action.disabled && setHighlightedIndex(visible.length)}
                    role="option"
                  >
                    <Icon className="text-muted-foreground" name="add" />
                    <span className="truncate">{action.label}</span>
                  </li>
                </>
              ) : null}
            </ul>

            {/* Not for a list that holds only its action: there is nothing to
                find, only something to do. */}
            {visible.length === 0 && (options.length > 0 || !action) ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">{t("common.noResults")}</p>
            ) : null}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {trigger}
      {menu}
    </>
  );
}
