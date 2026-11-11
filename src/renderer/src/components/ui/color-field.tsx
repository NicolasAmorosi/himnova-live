import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "@renderer/lib/utils";
import { computeMenuPosition, useFollowTrigger, type MenuPosition } from "./floating-menu";
import { useT, type MessageKey } from "@renderer/lib/i18n/i18n-provider";

/**
 * The colours a scene can be painted with, straight out of the 2026-10-22
 * identity sheet (see the palette table in `docs/knowledge/06-ui-and-theme.md`):
 * its neutrals, its blues, the accent, and the four indicators plus the flame.
 *
 * These are CONTENT values, not design tokens: they end up stored in a row and
 * rendered into an inline style on the projector, exactly like a program's
 * name. That is why they may be hex literals here while `CLAUDE.md` forbids a
 * hex anywhere in a component's classes — the projector's stage is not themed,
 * and a scene must look the same whatever theme the control window is in.
 *
 * Exact sheet values, not the AA-adjusted UI fills: on the projector a colour
 * is the brand's, and its legibility is the operator's call on that stage.
 */
type ColorPreset = { labelKey: MessageKey; value: string };

const SCENE_COLOR_PRESETS: readonly ColorPreset[] = [
  { labelKey: "style.colors.white", value: "#ffffff" },
  { labelKey: "style.colors.lightGray", value: "#eef2f6" },
  { labelKey: "style.colors.gray", value: "#9aa9b8" },
  { labelKey: "style.colors.black", value: "#000000" },
  { labelKey: "style.colors.navy", value: "#162231" },
  { labelKey: "style.colors.deepBlue", value: "#213c59" },
  { labelKey: "style.colors.blue", value: "#2f557f" },
  { labelKey: "style.colors.steel", value: "#8299b2" },
  { labelKey: "style.colors.teal", value: "#3e8391" },
  { labelKey: "style.colors.green", value: "#448d21" },
  { labelKey: "style.colors.amber", value: "#ffa92d" },
  { labelKey: "style.colors.orange", value: "#e36520" },
  { labelKey: "style.colors.flame", value: "#d14600" },
  { labelKey: "style.colors.red", value: "#dd1f1f" },
];

const PICKER_WIDTH_PX = 232;

/** Exactly `#rrggbb` — the one canonical form the row validator accepts. */
const HEX = /^#[0-9a-fA-F]{6}$/;

type ColorFieldSize = "xs" | "sm";

type ColorFieldProps = {
  className?: string;
  /** Accessible name of the trigger: it shows a swatch and a hex, neither of
   *  which says WHICH colour of the scene this is. */
  label: string;
  onChange: (value: string) => void;
  /** The same scale as `Input` and `Select`, so a colour sitting in a
   *  `FieldRow` next to a dropdown lines up with it instead of being the one
   *  short control in the group. */
  size?: ColorFieldSize;
  value: string;
};

const sizes: Record<ColorFieldSize, string> = {
  xs: "h-7 px-2 text-xs",
  sm: "h-8 px-3 text-sm",
};

/**
 * A colour, picked from the official palette or typed as a hex.
 *
 * Opens a portalled popover for the same reason `Select` and `Menu` do: every
 * panel and dialog in this app clips its overflow, so a swatch grid laid out
 * in flow is a grid the operator cannot see. Shares `computeMenuPosition` with
 * them, so it flips and clamps identically.
 *
 * The free-form field is a real `<input type="color">` next to the hex box,
 * not instead of it: the native picker is the only way to reach a colour that
 * is not in the palette with a mouse, and the hex box is the only way to type
 * one a designer handed over. Both commit only a valid `#rrggbb`, so the row
 * never holds a half-typed value.
 */
export function ColorField({ className, label, onChange, size = "sm", value }: ColorFieldProps) {
  const t = useT();
  const presetName = (preset: ColorPreset) => t(preset.labelKey);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  /** What is in the hex box while it is being typed. `null` means "show the
   *  committed value" — anything else is a draft that has not parsed yet. */
  const [draft, setDraft] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useFollowTrigger(
    open,
    triggerRef,
    (trigger) => setPosition(computeMenuPosition(trigger, PICKER_WIDTH_PX, "end")),
    () => close(true),
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function close(refocus: boolean) {
    setOpen(false);
    setDraft(null);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }

  function commitDraft(next: string) {
    setDraft(next);
    if (HEX.test(next)) onChange(next.toLowerCase());
  }

  function handlePopoverKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    // Stopped, because `Modal` listens for Escape on `document`: without this
    // one press would close the picker AND the dialog the operator is editing
    // in, losing the form. React attaches its listeners to a portal's own
    // container, so this runs before the event ever reaches `document`.
    e.stopPropagation();
    close(true);
  }

  const hex = draft ?? value;
  const invalid = draft !== null && !HEX.test(draft);

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className={cn(
          "focus-ring flex cursor-pointer items-center gap-2 rounded-md border border-border bg-surface text-foreground transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border",
          sizes[size],
          open && "border-accent",
          className,
        )}
        onClick={() => (open ? close(false) : setOpen(true))}
        ref={triggerRef}
        type="button"
      >
        {/* A checkerboard behind the swatch would be noise: a scene colour is
            always opaque. The ring is what keeps white readable on the light
            theme's white surface. */}
        <span
          className="size-4 shrink-0 rounded-sm ring-1 ring-border ring-inset"
          style={{ background: value }}
        />
        <span className="font-mono tabular-nums uppercase">{value}</span>
      </button>

      {open && position
        ? createPortal(
            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the tab stops inside this popover are the swatches and the two inputs; Escape has to close it from whichever one holds focus, which is a handler on the container by definition. Same delegated pattern `Select`, `Menu` and `Tabs` use — see `.claude/knowledge/jsx-a11y-reads-one-element-so-every-delegated-keyboard-pattern-is-an-error.md`.
            <div
              aria-label={label}
              className="fixed z-[var(--z-popover)] flex flex-col gap-2 rounded-xl border border-border bg-card p-2 shadow-overlay"
              onKeyDown={handlePopoverKeyDown}
              ref={popoverRef}
              role="dialog"
              style={{
                left: position.left,
                width: position.width,
                ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
              }}
            >
              <div className="grid grid-cols-7 gap-1">
                {SCENE_COLOR_PRESETS.map((preset) => (
                  <button
                    aria-label={presetName(preset)}
                    aria-pressed={preset.value === value.toLowerCase()}
                    className={cn(
                      "size-7 cursor-pointer rounded-md ring-1 ring-border ring-inset transition-transform hover:scale-110 focus-ring",
                      preset.value === value.toLowerCase() && "ring-2 ring-accent",
                    )}
                    key={preset.value}
                    onClick={() => {
                      onChange(preset.value);
                      setDraft(null);
                    }}
                    style={{ background: preset.value }}
                    title={presetName(preset)}
                    type="button"
                  />
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                <input
                  aria-label={label}
                  className="size-7 shrink-0 cursor-pointer rounded-md border border-border bg-surface p-0.5"
                  onChange={(e) => {
                    onChange(e.target.value.toLowerCase());
                    setDraft(null);
                  }}
                  type="color"
                  value={HEX.test(value) ? value : "#000000"}
                />
                <input
                  aria-invalid={invalid || undefined}
                  aria-label={label}
                  className="h-7 w-full rounded-md border border-border bg-surface px-2 font-mono text-xs text-foreground uppercase focus-ring aria-invalid:border-danger/80 aria-invalid:focus-visible:outline-danger"
                  maxLength={7}
                  onChange={(e) => commitDraft(e.target.value)}
                  spellCheck={false}
                  value={hex}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
