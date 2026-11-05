## An inspector row stretches every child, and its class outranks the child's own width
**Area:** ui
**Trigger:** a control inside an inspector (`FieldRow` in `compact` layout) is crushed, collapsed or ignores its `w-*`; adding a second control beside a field in an inspector; giving a primitive a fixed width with a class

- `COMPACT_CONTROL` in `src/renderer/src/components/ui/field.tsx` puts `[&>*:not([role=switch])]:w-full` on the
  cell, so that every field of an inspector shares one right edge whatever width the call site gave it. That
  selector is `.cell > *:not(...)` — parent class + attribute — and **outranks any single class on the child**
  (`w-12`, `w-52`, `w-auto`). Only an inline `style` beats it.
- Two bugs came from it on 2026-11-05:
  - **A `Select` and a `Button` side by side split the cell in half**, so «+ Agregar…» rendered as «+ A» in the
    song-theme, verse, logo and bug-image background rows (owner's report). Fix: the cell also carries
    `[&>button:not([role])]:w-auto [&>button:not([role])]:shrink-0` — a plain button keeps its width; a
    `Select`'s trigger is a `<button role="combobox">`, so `:not([role])` leaves it stretching.
  - **The slider readout took the whole row** when its width moved from an inline `ch` style to a `w-12` class:
    the track collapsed to its thumb in every inspector. The readout's 48 px is set inline on purpose
    (`components/ui/slider.tsx`).
- Settings rows (`spread` layout) have the mirror rule: the row sets `w-64` on `[role=combobox]` and
  `input:not([type=checkbox])` children (`SPREAD_FIELD`), so a call site's width class there is dead too.
- Same family, same day: `in-has-[:disabled]:` on a row's label dims it whenever ANY ancestor has a disabled
  descendant — and the inspector `aside` always does —, so every switch label greyed out. Scope it to the row
  itself: `has-[:disabled]:[&>span:first-child]:opacity-50` on the row (or its `<label>`).
- And `[&>button:not([role])]` also matched `ColorField`'s lone trigger, shrinking it to its content: the rule
  is `:not(:only-child)` — a button keeps its width only BESIDE a field.
- Do: in an inspector, put a field's companion action INSIDE the field (`Select`'s `action`) rather than beside it;
  give a primitive's internal fixed width as an inline style; check a new control in an inspector screenshot, not
  only on a Settings page — the same component renders differently in each.

Related: [a-shrinking-icon-hides-labels-that-never-fit-and-truncate-needs-a-span.md](a-shrinking-icon-hides-labels-that-never-fit-and-truncate-needs-a-span.md),
[fixed-width-readout-inflates-flex-gap.md](fixed-width-readout-inflates-flex-gap.md).

**Last updated:** 2026-11-05
